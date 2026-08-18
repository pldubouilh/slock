package db

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log"
	"sort"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migration is one numbered step, embedded in the binary so a deployment can
// never be out of step with the code that expects it.
type Migration struct {
	Version  int
	Name     string
	SQL      string
	Checksum string
}

// loadMigrations reads and orders the embedded migrations. Filenames are
// "<version>_<name>.sql", e.g. 0002_add_avatar_sha.sql.
func loadMigrations() ([]Migration, error) {
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return nil, err
	}
	var out []Migration
	seen := map[int]string{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		numPart, namePart, ok := strings.Cut(strings.TrimSuffix(e.Name(), ".sql"), "_")
		if !ok {
			return nil, fmt.Errorf("migration %q is not named <version>_<name>.sql", e.Name())
		}
		version, err := strconv.Atoi(numPart)
		if err != nil {
			return nil, fmt.Errorf("migration %q has a non-numeric version", e.Name())
		}
		if prev, dup := seen[version]; dup {
			return nil, fmt.Errorf("migrations %q and %q share version %d", prev, e.Name(), version)
		}
		seen[version] = e.Name()

		body, err := migrationFS.ReadFile("migrations/" + e.Name())
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(body)
		out = append(out, Migration{
			Version:  version,
			Name:     namePart,
			SQL:      string(body),
			Checksum: hex.EncodeToString(sum[:]),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}

// Migrate brings the database up to date, applying each pending migration in
// its own transaction. It is safe to run on every boot and safe to run against
// a database created before migrations existed.
//
// A migration that has already been applied is never re-run, and if its file
// has changed since, the boot fails rather than leaving the schema in a state
// nobody can reason about.
func (d *DB) Migrate(ctx context.Context) error {
	migrations, err := loadMigrations()
	if err != nil {
		return fmt.Errorf("load migrations: %w", err)
	}

	if _, err := d.Pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
		    version     INT PRIMARY KEY,
		    name        TEXT NOT NULL,
		    checksum    TEXT NOT NULL,
		    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[int]string{}
	rows, err := d.Pool.Query(ctx, `SELECT version, checksum FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	for rows.Next() {
		var v int
		var sum string
		if err := rows.Scan(&v, &sum); err != nil {
			rows.Close()
			return err
		}
		applied[v] = sum
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	pending := 0
	for _, m := range migrations {
		if sum, ok := applied[m.Version]; ok {
			if sum != m.Checksum {
				return fmt.Errorf(
					"migration %04d_%s has changed since it was applied (recorded %s, now %s); "+
						"applied migrations are immutable — add a new one instead",
					m.Version, m.Name, shortSum(sum), shortSum(m.Checksum))
			}
			continue
		}
		if err := d.applyMigration(ctx, m); err != nil {
			return err
		}
		log.Printf("migration %04d_%s applied", m.Version, m.Name)
		pending++
	}

	if pending == 0 {
		log.Printf("schema up to date (%d migrations)", len(migrations))
	} else {
		log.Printf("schema up to date (%d applied this boot, %d total)", pending, len(migrations))
	}
	return nil
}

// shortSum abbreviates a checksum for an error message without assuming the
// stored value is well-formed — a corrupt row must produce an error, not a panic.
func shortSum(sum string) string {
	if len(sum) > 12 {
		return sum[:12]
	}
	if sum == "" {
		return "(empty)"
	}
	return sum
}

// applyMigration runs one migration and records it, both or neither. Postgres
// has transactional DDL, so a failure leaves nothing half-built.
func (d *DB) applyMigration(ctx context.Context, m Migration) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, m.SQL); err != nil {
		return fmt.Errorf("migration %04d_%s: %w", m.Version, m.Name, err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
		m.Version, m.Name, m.Checksum); err != nil {
		return fmt.Errorf("record migration %04d_%s: %w", m.Version, m.Name, err)
	}
	return tx.Commit(ctx)
}

// MigrationStatus lists each migration and whether it has been applied, for
// `slock migrate status`.
func (d *DB) MigrationStatus(ctx context.Context) ([]string, error) {
	migrations, err := loadMigrations()
	if err != nil {
		return nil, err
	}
	applied := map[int]bool{}
	rows, err := d.Pool.Query(ctx, `SELECT version FROM schema_migrations`)
	if err == nil {
		for rows.Next() {
			var v int
			if err := rows.Scan(&v); err == nil {
				applied[v] = true
			}
		}
		rows.Close()
	}
	var out []string
	for _, m := range migrations {
		state := "pending"
		if applied[m.Version] {
			state = "applied"
		}
		out = append(out, fmt.Sprintf("%04d_%-32s %s", m.Version, m.Name, state))
	}
	return out, nil
}
