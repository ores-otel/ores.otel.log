/// Public entrypoint for the oresoftware_next_loggers package.
///
/// The implementation remains available from `next_loggers.dart` for source
/// compatibility. Shutdown coordination and durable Supabase WebSocket ingest
/// are exported as part of the cross-runtime telemetry contract.
export 'next_loggers.dart';
export 'shutdown.dart';
export 'supabase_websocket_ingest.dart';
