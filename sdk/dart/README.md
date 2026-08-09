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
