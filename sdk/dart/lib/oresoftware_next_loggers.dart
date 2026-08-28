/// Public entrypoint for the oresoftware_next_loggers package.
///
/// The implementation remains available from `next_loggers.dart` for source
/// compatibility. Shutdown coordination, authenticated Supabase Realtime batch
/// transport, and durable Supabase WebSocket ingest are exported as explicit
/// capabilities of the cross-runtime telemetry contract.
export 'next_loggers.dart';
export 'shutdown.dart';
export 'supabase_realtime_transport.dart';
export 'supabase_websocket_ingest.dart';
