// Fleet template: stream this app's client logs to its own Supabase project over the
// ores-otel/ws-ingest/v1 WebSocket protocol, with commit acknowledgement.
//
// Wiring (main.dart):
//   final telemetry = await OresTelemetry.start(
//     appName: 'example-app',
//     apiBase: Uri.parse('https://api.example.com'),
//     bearerToken: () async => session.accessToken,   // shared-auth delegated token for this app
//   );
//   runApp(TelemetryScope(telemetry, child: const App()));
//   … telemetry.log.info('opened settings');
//
// The backend endpoint POST /api/telemetry/ticket (oresoftware-telemetry-ticket, axum route) mints
// the one-time ticket; the app never holds a Supabase key.
import 'dart:convert';
import 'dart:io' show HttpClient, Platform;
import 'dart:math';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/widgets.dart';
import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';
import 'package:oresoftware_next_loggers/supabase_websocket_ingest.dart';

typedef BearerTokenProvider = Future<String?> Function();

class OresTelemetry {
  OresTelemetry._(this.log, this._transport, this._lifecycle);

  final Logger log;
  final SupabaseWebSocketIngestTransport _transport;
  final AppLifecycleListener _lifecycle;

  static String _randomId() {
    final r = Random.secure();
    return List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  }

  static String get _runtime => kIsWeb ? 'flutter-web' : 'flutter-${Platform.operatingSystem}';

  /// Fetch a one-time ticket from the app backend. Fails closed: no token → no telemetry session.
  static Future<SupabaseWebSocketTicket> _fetchTicket(Uri apiBase, BearerTokenProvider bearerToken) async {
    final token = await bearerToken();
    if (token == null || token.isEmpty) throw StateError('telemetry ticket requires an authenticated session');
    final client = HttpClient();
    try {
      final req = await client.postUrl(apiBase.resolve('/api/telemetry/ticket'));
      req.headers.set('authorization', 'Bearer $token');
      req.headers.set('accept', 'application/json');
      final res = await req.close();
      if (res.statusCode != 200) throw StateError('telemetry ticket endpoint returned ${res.statusCode}');
      final body = jsonDecode(await res.transform(utf8.decoder).join()) as Map<String, Object?>;
      return SupabaseWebSocketTicket(
        url: Uri.parse(body['url'] as String),
        ticket: body['ticket'] as String,
        expiresAt: DateTime.tryParse(body['expiresAt'] as String? ?? ''),
      );
    } finally {
      client.close(force: true);
    }
  }

  static Future<OresTelemetry> start({
    required String appName,
    required Uri apiBase,
    required BearerTokenProvider bearerToken,
    String? appVersion,
    String? release,
    List<String> allowedHosts = const <String>[],
    List<LogTransport> extraTransports = const <LogTransport>[],
  }) async {
    final session = SupabaseTelemetrySession(
      appName: appName,
      runtime: _runtime,
      sessionId: _randomId(),
      clientInstanceId: _randomId(),
      appVersion: appVersion,
      release: release,
    );
    final transport = SupabaseWebSocketIngestTransport(
      ticketProvider: () => _fetchTicket(apiBase, bearerToken),
      session: session,
      allowedHosts: allowedHosts,
      onDrop: (record, reason, total) => debugPrint('[ores-otel] dropped ${record.id}: $reason (total $total)'),
      onError: (error, snapshot) => debugPrint('[ores-otel] transport error: $error'),
    );
    final logger = Logger(appName: appName, transports: <LogTransport>[transport, ...extraTransports]);
    late final AppLifecycleListener lifecycle;
    lifecycle = AppLifecycleListener(
      onPause: () => transport.flush(),
      onDetach: () => transport.flushOnExit(),
    );
    return OresTelemetry._(logger, transport, lifecycle);
  }

  Future<void> flush() => _transport.flush();

  Future<void> dispose() async {
    _lifecycle.dispose();
    await log.close();
  }
}

/// Makes the telemetry handle available to the widget tree.
class TelemetryScope extends InheritedWidget {
  const TelemetryScope(this.telemetry, {super.key, required super.child});
  final OresTelemetry telemetry;
  static OresTelemetry of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<TelemetryScope>()!.telemetry;
  @override
  bool updateShouldNotify(TelemetryScope old) => old.telemetry != telemetry;
}
