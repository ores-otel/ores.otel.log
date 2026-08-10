//go:build !windows

package nextloggers

import (
	"os"
	"syscall"
)

func defaultShutdownSignals() []os.Signal {
	return []os.Signal{os.Interrupt, syscall.SIGTERM}
}
