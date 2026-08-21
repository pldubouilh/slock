// Package envfile reads KEY=VALUE configuration files. Nothing writes them:
// slock never edits its own config, and generated state (the Web Push keypair)
// lives in the database instead.
//
// It is deliberately not a dotenv implementation: no interpolation, no export
// keyword, no multi-line values. Anything that needs those belongs in the real
// environment, which always takes precedence.
package envfile

import (
	"bufio"
	"os"
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
