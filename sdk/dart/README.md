# oresoftware_next_loggers

Dart and Flutter implementation of the shared `next-loggers/v1` structured
logging contract. It uses Dart Zones for scoped context and accepts explicit,
application-owned OpenTelemetry and Supabase transports. It does not register
or monkey-patch global runtime instrumentation.

```dart
import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';

final logger = Logger(appName: 'payments');
final record = await withLogContext(
  const LogContext(traceId: 'trace-1', spanId: 'span-1'),
  () => logger.info('charged order', fields: const {'orderId': 'order-42'}),
);
```

## Per-event OpenTelemetry routing

`Logger(otel: true)` is the default. Existing immediate methods remain
unchanged; use `event` when a record needs an explicit OTEL decision:

```dart
final log = Logger(appName: 'app', otel: false, transports: transports);
await log.event(LogLevel.info, 'sampled in').useOtel().send();
await log.event(LogLevel.warn, 'OTEL excluded').notOtel().send();
await log.event(LogLevel.info, 'computed').withOtel(routeToOtel).send();
```

`resetOtel()` restores the logger default and `isOtelEnabled(fallback)`
resolves it. Logger `setOtelEnabled`, `useOtel`, and `notOtel` update the
default. Other transports still receive records excluded from OTEL.
