# io.github.oresoftware:next-loggers

Java 17 implementation of the shared `next-loggers/v1` structured logging
contract. Context is scoped with `ThreadLocal` and restored after each callback.
OpenTelemetry and Supabase are explicit, application-owned transports; the
library does not install agents, providers, instrumentation, or runtime patches.

Maven coordinates:

```xml
<dependency>
  <groupId>io.github.oresoftware</groupId>
  <artifactId>next-loggers</artifactId>
  <version>0.1.0</version>
</dependency>
```

## Per-event OpenTelemetry routing

The existing logger constructors default OTEL routing to `true`; the overload
with a final boolean configures an opt-in logger. Immediate `info`/`error`
calls remain compatible, while `event` exposes the override chain:

```java
var log = new NextLoggers.Logger("app", null, "java", Map.of(), transports, false);
log.event(NextLoggers.Level.INFO, "sampled in", Map.of()).useOtel().send();
log.event(NextLoggers.Level.WARN, "OTEL excluded", Map.of()).notOtel().send();
log.event(NextLoggers.Level.INFO, "computed", Map.of()).withOtel(routeToOtel).send();
```

`resetOtel()` restores the logger default and `isOtelEnabled(fallback)`
resolves it. `setOtelEnabled`, `useOtel`, and `notOtel` update the logger
default. Only transports whose `isOtel()` marker/name identifies
OpenTelemetry are filtered.
