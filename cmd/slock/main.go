// Command slock runs the whole server: API, realtime stream, and static client.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"slock/internal/api"
	"slock/internal/db"
	"slock/internal/envfile"
	"slock/internal/mail"
	"slock/internal/media"
	"slock/internal/password"
	"slock/internal/push"
	"slock/internal/realtime"
	"slock/internal/version"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("slock ")

	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(version.String())
		return
	}

	if len(os.Args) > 1 && os.Args[1] == "keygen" {
		pub, priv, err := push.GenerateKeys()
		if err != nil {
			log.Fatalf("keygen: %v", err)
		}
		fmt.Printf("VAPID_PUBLIC_KEY=%s\nVAPID_PRIVATE_KEY=%s\n", pub, priv)
		return
	}

	if len(os.Args) > 2 && os.Args[1] == "migrate" && os.Args[2] == "status" {
		if err := migrateStatus(); err != nil {
			log.Fatal(err)
		}
		return
	}

	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("version %s", version.String())

	// The config file slock reads at boot and writes its generated VAPID keys
	// back to. Real environment variables always win, so this never overrides
	// what compose's env_file already put in the environment.
	cfgPath := env("SLOCK_CONFIG", "slock.config")
	if vars, err := envfile.Load(cfgPath); err != nil {
		log.Printf("could not read %s: %v", cfgPath, err)
	} else if err := envfile.ApplyMissing(vars); err != nil {
		return err
	}

	if err := ensureVAPIDKeys(cfgPath); err != nil {
		return err
	}

	baseURL := strings.TrimRight(env("BASE_URL", "http://localhost:8080"), "/")
	cfg := api.Config{
		Addr:           env("ADDR", ":8080"),
		BaseURL:        baseURL,
		DataDir:        env("DATA_DIR", "./data"),
		MaxUploadBytes: int64(envInt("MAX_UPLOAD_MB", 50)) << 20,
		SessionTTL:     time.Duration(envInt("SESSION_TTL_DAYS", 30)) * 24 * time.Hour,
		// Secure cookies are not configurable: they are on exactly when the
		// public origin is https, which is the only case where they can work.
		SecureCookies: strings.HasPrefix(baseURL, "https://"),
		DevWebDir:     os.Getenv("SLOCK_WEB_DIR"),
	}

	dsn := env("DATABASE_URL", "postgres://slock:slock@localhost:5432/slock?sslmode=disable")

	connectCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	database, err := db.Open(connectCtx, dsn)
	if err != nil {
		return err
	}
	defer database.Close()

	if err := database.Migrate(ctx); err != nil {
		return err
	}
	log.Printf("schema ready")

	if err := bootstrap(ctx, database); err != nil {
		return err
	}

	store, err := media.New(cfg.DataDir + "/attachments")
	if err != nil {
		return fmt.Errorf("media store: %w", err)
	}

	mailer := mail.New(os.Getenv("SENDGRID_API_KEY"), env("MAIL_FROM", ""), env("MAIL_FROM_NAME", "slock"))
	if mailer.Enabled() {
		log.Printf("sendgrid configured (from %s)", env("MAIL_FROM", ""))
	} else {
		log.Printf("sendgrid not configured; emails will be logged only")
	}

	pusher, err := push.New(os.Getenv("VAPID_PUBLIC_KEY"), os.Getenv("VAPID_PRIVATE_KEY"), env("VAPID_SUBJECT", "mailto:admin@localhost"))
	if err != nil {
		return fmt.Errorf("web push: %w", err)
	}
	if pusher.Enabled() {
		log.Printf("web push enabled")
	} else {
		log.Printf("web push disabled (no VAPID keys, and none could be generated or stored)")
	}

	srv := api.New(cfg, database, realtime.NewHub(), store, mailer, pusher)

	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 15 * time.Second,
		WriteTimeout:      0, // SSE streams must not be cut off
		IdleTimeout:       75 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutCtx)
	}()

	log.Printf("listening on %s", cfg.Addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	log.Printf("stopped")
	return nil
}

// ensureVAPIDKeys mints a Web Push keypair on first boot and writes it to the
// config file, so push works out of the box instead of requiring `slock keygen`.
//
// Persisting matters more than generating: regenerating on every restart would
// silently invalidate every existing push subscription. If the file cannot be
// written we keep the keys for this process but say loudly that they will not
// survive a restart, rather than quietly churning them.
func ensureVAPIDKeys(envPath string) error {
	if os.Getenv("VAPID_PUBLIC_KEY") != "" && os.Getenv("VAPID_PRIVATE_KEY") != "" {
		return nil
	}
	// A half-configured pair is a mistake worth pointing at, not something to
	// paper over by generating a fresh one.
	if os.Getenv("VAPID_PUBLIC_KEY") != "" || os.Getenv("VAPID_PRIVATE_KEY") != "" {
		log.Printf("only one of VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY is set; " +
			"web push stays disabled until both are provided")
		return nil
	}

	pub, priv, err := push.GenerateKeys()
	if err != nil {
		return fmt.Errorf("generate web push keys: %w", err)
	}
	os.Setenv("VAPID_PUBLIC_KEY", pub)
	os.Setenv("VAPID_PRIVATE_KEY", priv)

	err = envfile.Append(envPath,
		"Web Push (VAPID) keys, generated by slock on first boot.\n"+
			"Keep them: replacing these invalidates every existing push subscription\n"+
			"and everyone has to enable notifications again.",
		[][2]string{{"VAPID_PUBLIC_KEY", pub}, {"VAPID_PRIVATE_KEY", priv}})
	if err != nil {
		log.Printf("──────────────────────────────────────────────")
		log.Printf(" generated web push keys but could NOT write %s: %v", envPath, err)
		log.Printf(" push works now but the keys are lost on restart, which")
		log.Printf(" invalidates subscriptions. Set them yourself to make it stick:")
		log.Printf("   VAPID_PUBLIC_KEY=%s", pub)
		log.Printf("   VAPID_PRIVATE_KEY=%s", priv)
		log.Printf("──────────────────────────────────────────────")
		return nil
	}
	log.Printf("generated web push keys and saved them to %s", envPath)
	return nil
}

// migrateStatus prints each migration and whether it has been applied. It
// connects but changes nothing, so it is safe to run against production.
func migrateStatus() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	database, err := db.Open(ctx, env("DATABASE_URL",
		"postgres://slock:slock@localhost:5432/slock?sslmode=disable"))
	if err != nil {
		return err
	}
	defer database.Close()

	lines, err := database.MigrationStatus(ctx)
	if err != nil {
		return err
	}
	for _, l := range lines {
		fmt.Println(l)
	}
	return nil
}

// bootstrap creates the first admin and a #general channel on an empty database.
func bootstrap(ctx context.Context, database *db.DB) error {
	var count int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	email := env("BOOTSTRAP_ADMIN_EMAIL", "admin@localhost")
	pw := os.Getenv("BOOTSTRAP_ADMIN_PASSWORD")
	generated := false
	if pw == "" {
		pw = randomPassword()
		generated = true
	}
	hash, err := password.Hash(pw)
	if err != nil {
		return err
	}

	var adminID int64
	err = database.Pool.QueryRow(ctx,
		`INSERT INTO users (email, display_name, password_hash, is_admin, must_change_pw, avatar_color)
		 VALUES ($1, $2, $3, TRUE, $4, 0) RETURNING id`,
		email, env("BOOTSTRAP_ADMIN_NAME", "Admin"), hash, generated).Scan(&adminID)
	if err != nil {
		return err
	}

	var channelID int64
	err = database.Pool.QueryRow(ctx,
		`INSERT INTO channels (kind, name, topic, created_by) VALUES ('channel', 'general', 'Everything and anything', $1)
		 ON CONFLICT DO NOTHING RETURNING id`, adminID).Scan(&channelID)
	if err == nil {
		_, err = database.Pool.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			channelID, adminID)
		if err != nil {
			return err
		}
	}

	log.Printf("──────────────────────────────────────────────")
	log.Printf(" first run: admin account created")
	log.Printf("   email:    %s", email)
	log.Printf("   password: %s", pw)
	log.Printf("──────────────────────────────────────────────")
	return nil
}

func randomPassword() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

