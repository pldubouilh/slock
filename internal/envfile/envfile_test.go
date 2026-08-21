package envfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadMissingFileIsEmpty(t *testing.T) {
	vars, err := Load(filepath.Join(t.TempDir(), "nope.env"))
	if err != nil {
		t.Fatalf("missing file should not error: %v", err)
	}
	if len(vars) != 0 {
		t.Fatalf("expected no vars, got %v", vars)
	}
}

func TestLoadParsesRealisticFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	os.WriteFile(path, []byte(`
# a comment
POSTGRES_PASSWORD=hunter2

BASE_URL = https://chat.example.com
QUOTED="with spaces"
SINGLE='single'
EMPTY=
NOEQUALS
`), 0o600)

	vars, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"POSTGRES_PASSWORD": "hunter2",
		"BASE_URL":          "https://chat.example.com",
		"QUOTED":            "with spaces",
		"SINGLE":            "single",
		"EMPTY":             "",
	}
	for k, v := range want {
		if vars[k] != v {
			t.Errorf("%s = %q, want %q", k, vars[k], v)
		}
	}
	if _, ok := vars["NOEQUALS"]; ok {
		t.Error("a line with no = should be skipped")
	}
}

func TestApplyMissingNeverOverridesTheEnvironment(t *testing.T) {
	t.Setenv("SLOCK_TEST_SET", "from-environment")
	t.Setenv("SLOCK_TEST_UNSET", "")

	if err := ApplyMissing(map[string]string{
		"SLOCK_TEST_SET":   "from-file",
		"SLOCK_TEST_UNSET": "from-file",
	}); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("SLOCK_TEST_SET"); got != "from-environment" {
		t.Errorf("a real environment variable must win, got %q", got)
	}
	if got := os.Getenv("SLOCK_TEST_UNSET"); got != "from-file" {
		t.Errorf("an empty variable should be filled from the file, got %q", got)
	}
}
