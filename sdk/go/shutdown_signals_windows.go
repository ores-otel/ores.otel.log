//go:build windows

package nextloggers

import "os"

func defaultShutdownSignals() []os.Signal {
	return []os.Signal{os.Interrupt}
}
