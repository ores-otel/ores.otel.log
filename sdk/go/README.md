# next-loggers for Go

Native Go implementation of the shared `next-loggers/v1` contract.

```go
package main

import (
	nextloggers "github.com/ORESoftware/next-loggers.ts/sdk/go"
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
