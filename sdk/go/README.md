# next-loggers for Go

Native Go implementation of the shared `next-loggers/v1` contract.

```go
package main

import (
	nextloggers "github.com/ores-otel/ores.otel.log/sdk/go"
)

func main() {
	log := nextloggers.NewLogger(nextloggers.Options{
		AppName:    "payments",
		Runtime:    "go",
		Transports: []nextloggers.Transport{&nextloggers.MemoryTransport{}},
	})

	_ = log.Info("charged order").
		AddFields(map[string]any{"orderId": "order-42"}).
		Send()
	_ = log.Close()
}
```

`Logger`, `Event`, `LogRecord`, `Options`, `Transport`, and lifecycle
interfaces are public. Go applications can extend behavior through embedding
and transport composition.

Use `NewOpenTelemetryTransport` with an application-owned OTEL emitter and
`NewSupabaseTransport` with an authenticated sender. Both satisfy `Transport`,
have no SDK dependency, and never install global instrumentation:

```go
otel := nextloggers.NewOpenTelemetryTransport(func(record nextloggers.OpenTelemetryLogRecord) error {
	return otelLogger.Emit(record)
})
supabase := nextloggers.NewSupabaseTransport(sendToSupabase)
```

## Per-event OpenTelemetry routing

OpenTelemetry is enabled by default. Use `Options.Otel` when the default must
be explicit (a pointer distinguishes `false` from an omitted option), and use
the event chain for one-record overrides:

```go
disabled := false
log := nextloggers.NewLogger(nextloggers.Options{
	Otel: &disabled,
	Transports: []nextloggers.Transport{otel, supabase},
})
_ = log.Info("sampled in").UseOtel().Send()
_ = log.Warn("OTEL excluded").NotOtel().Send()
_ = log.Info("computed").WithOtel(routeToOtel).Send()
```

`ResetOtel` restores the logger default and `IsOtelEnabled(fallback)` resolves
it. `SetOtelEnabled`, `UseOtel`, and `NotOtel` update the logger default. OTEL
routing never suppresses non-OTEL transports.
