package db

import "context"

// KindNote is a shared plain-text note: a channel without messages, whose
// text lives in the notes table.
const KindNote = "note"

// PersonalNoteName is what everyone's first note is called.
const PersonalNoteName = "Personal note"

// CreatePersonalNote gives a new account its private "Personal note", the
// one every person starts with (migration 0013 made them for the accounts
// that predate notes).
func (d *DB) CreatePersonalNote(ctx context.Context, userID int64) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id int64
	if err := tx.QueryRow(ctx,
		`INSERT INTO channels (kind, name, is_private, created_by) VALUES ('note', $1, TRUE, $2) RETURNING id`,
		PersonalNoteName, userID).Scan(&id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, id, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO notes (channel_id, updated_by) VALUES ($1, $2)`, id, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
