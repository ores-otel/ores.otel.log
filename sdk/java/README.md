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
