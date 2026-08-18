// Package version reports which build of slock is running.
//
// The format is date-hash — 2026-08-14-9f3c1ab — taken from the commit the
// binary was built from. Clients compare it across reconnects to notice a
// deploy and reload themselves, so it has to change on every release and stay
// stable within one.
package version

import (
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

// override is set with -ldflags "-X slock/internal/version.override=..." for
// builds that cannot read VCS data (a tarball, say). Normally it stays empty
// and the value comes from the build info Go embeds automatically.
var override string

var (
	once   sync.Once
	cached string
)

// String returns the running build's version, e.g. "2026-08-14-9f3c1ab".
// A working tree with uncommitted changes gets a "-dirty" suffix, and a build
// with no VCS information at all reports "dev".
func String() string {
	once.Do(func() { cached = compute() })
	return cached
}

func compute() string {
	if override != "" {
		return override
	}

	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "dev"
	}

	var revision, vcsTime string
	var modified bool
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			revision = s.Value
		case "vcs.time":
			vcsTime = s.Value
		case "vcs.modified":
			modified = s.Value == "true"
		}
	}
	if revision == "" {
		return "dev"
	}

	date := "unknown"
	if t, err := time.Parse(time.RFC3339, vcsTime); err == nil {
		date = t.UTC().Format("2006-01-02")
	}
	short := revision
	if len(short) > 7 {
		short = short[:7]
	}

	v := date + "-" + short
	if modified {
		v += "-dirty"
	}
	return v
}

// Short is String without any "-dirty" marker, for display where the
// distinction does not matter.
func Short() string {
	return strings.TrimSuffix(String(), "-dirty")
}
