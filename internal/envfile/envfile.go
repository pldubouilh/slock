// Package envfile reads and appends KEY=VALUE configuration files, so slock can
// persist things it generates for itself (VAPID keys) without anyone having to
// run a command first.
//
// It is deliberately not a dotenv implementation: no interpolation, no export
// keyword, no multi-line values. Anything that needs those belongs in the real
// environment, which always takes precedence.
package envfile

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Load parses path into a map. A missing file is not an error — it just yields
// nothing, which is the normal first-boot case.
func Load(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	defer f.Close()

	out := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		// Tolerate quoted values, which people write out of habit.
		if len(value) >= 2 && (value[0] == '"' && value[len(value)-1] == '"' ||
			value[0] == '\'' && value[len(value)-1] == '\'') {
			value = value[1 : len(value)-1]
		}
		if key != "" {
			out[key] = value
		}
	}
	return out, sc.Err()
}

// ApplyMissing exports each pair into the process environment, but only where
// the variable is currently unset or empty. A real environment variable — what
// Docker or a systemd unit passes — always wins over the file.
func ApplyMissing(vars map[string]string) error {
	for k, v := range vars {
		if os.Getenv(k) != "" || v == "" {
			continue
		}
		if err := os.Setenv(k, v); err != nil {
			return err
		}
	}
	return nil
}

// Append adds a commented block of pairs to the end of path, creating the file
// (0600, since it holds secrets) and its directory if needed. Existing content
// is never rewritten, so a hand-edited file keeps its comments and order.
func Append(path, comment string, pairs [][2]string) error {
	if len(pairs) == 0 {
		return nil
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()

	// Start on a fresh line even if the file did not end with one.
	if st, err := f.Stat(); err == nil && st.Size() > 0 {
		if _, err := f.WriteString("\n"); err != nil {
			return err
		}
	}

	var b strings.Builder
	if comment != "" {
		for _, line := range strings.Split(comment, "\n") {
			fmt.Fprintf(&b, "# %s\n", line)
		}
	}
	for _, p := range pairs {
		fmt.Fprintf(&b, "%s=%s\n", p[0], p[1])
	}
	_, err = f.WriteString(b.String())
	return err
}
