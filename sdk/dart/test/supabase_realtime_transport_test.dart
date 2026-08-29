import 'dart:async';
import 'dart:convert';

import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';
import 'package:test/test.dart';

void main() {
  group('SupabaseRealtimeTransport', () {
    test('joins a private channel and sends an acknowledged batch', () async {
      final socket = _FakeSocket();
      final transport = SupabaseRealtimeTransport(
        url: Uri.parse(
          'https://project.supabase.co/realtime/v1/websocket',
        ),
        publishableKey: 'sb_publishable_client',
        accessToken: () => 'user-access-token',
        channel: 'session-logs:user-123',
        batchSize: 2,
        clock: () => DateTime.utc(2026, 8, 23, 12),
        socketFactory: (_) => socket,
      );

      expect(
        transport.endpoint.toString(),
        'wss://project.supabase.co/realtime/v1/websocket'
        '?apikey=sb_publishable_client&vsn=1.0.0',
      );

      await transport.write(_record('one'));
      await transport.write(_record('two'));
      await transport.flush();

      final join = socket.sent.singleWhere(
        (message) => message['event'] == 'phx_join',
      );
      final joinPayload = join['payload']! as Map<String, Object?>;
      final config = joinPayload['config']! as Map<String, Object?>;
      final broadcastConfig = config['broadcast']! as Map<String, Object?>;
      expect(join['topic'], 'realtime:session-logs:user-123');
      expect(config['private'], isTrue);
      expect(broadcastConfig['ack'], isTrue);
      expect(joinPayload['access_token'], 'user-access-token');

      final broadcast = socket.sent.singleWhere(
        (message) => message['event'] == 'broadcast',
      );
      final envelope = ((broadcast['payload']!
          as Map<String, Object?>)['payload']!) as Map<String, Object?>;
      expect(envelope['schema'], supabaseRealtimeBatchSchema);
      expect(envelope['sentAt'], '2026-08-23T12:00:00.000Z');
      final records = envelope['records']! as List<Object?>;
      expect(
        records.map((item) => (item! as Map<String, Object?>)['id']),
        <String>['one', 'two'],
      );
      expect(envelope['batchId'], matches(r'^nl-rt-2-[0-9a-f]{16}$'));
      expect(transport.snapshot().queued, 0);
      await transport.close();
    });

    test('rejects client-side secret and service-role credentials', () async {
      expect(
        () => SupabaseRealtimeTransport(
          url: Uri.parse('https://project.supabase.co'),
          publishableKey: 'sb_secret_do-not-ship',
          accessToken: () => 'user-token',
          channel: 'logs',
        ),
        throwsArgumentError,
      );

      final payload = base64Url
          .encode(utf8.encode(jsonEncode(<String, String>{
            'role': 'service_role',
          })))
          .replaceAll('=', '');
      final socket = _FakeSocket();
      final transport = SupabaseRealtimeTransport(
        url: Uri.parse('https://project.supabase.co'),
        publishableKey: 'sb_publishable_client',
        accessToken: () => 'header.$payload.signature',
        channel: 'logs',
        awaitDelivery: true,
        socketFactory: (_) => socket,
      );

      await expectLater(
        transport.write(_record('secret')),
        throwsArgumentError,
      );
    });

    test('bounds the queue and reports the oldest dropped record', () async {
      final drops = <SupabaseRealtimeDrop>[];
      final fallback = MemoryTransport();
      final transport = SupabaseRealtimeTransport(
        url: Uri.parse('https://project.supabase.co'),
        publishableKey: 'sb_publishable_client',
        accessToken: () => 'user-token',
        channel: 'logs',
        batchSize: 100,
        maxQueueSize: 2,
        flushInterval: const Duration(days: 1),
        fallback: fallback,
        fallbackAfterFailures: 0,
        onDrop: drops.add,
      );

      await transport.write(_record('oldest'));
      await transport.write(_record('middle'));
      await transport.write(_record('newest'));

      expect(transport.snapshot().queued, 2);
      expect(transport.snapshot().dropped, 1);
      expect(drops.single.reason, 'queue-full');
      expect(drops.single.record.id, 'oldest');

      await transport.flush();
      expect(
        fallback.records.map((record) => record.id),
        <String>['middle', 'newest'],
      );
      await transport.close();
    });

    test('uses the durable fallback after a WebSocket failure', () async {
      final fallback = MemoryTransport();
      var attempts = 0;
      final transport = SupabaseRealtimeTransport(
        url: Uri.parse('https://project.supabase.co'),
        publishableKey: 'sb_publishable_client',
        accessToken: () => 'user-token',
        channel: 'logs',
        awaitDelivery: true,
        fallback: fallback,
        fallbackAfterFailures: 1,
        socketFactory: (_) {
          attempts += 1;
          throw StateError('network unavailable');
        },
      );

      await transport.write(_record('fallback-record'));
      expect(attempts, 1);
      expect(
        fallback.records.map((record) => record.id),
        <String>['fallback-record'],
      );
      expect(transport.snapshot().queued, 0);
      await transport.close();
    });
  });
}

LogRecord _record(String id) => LogRecord(
      id: id,
      timestamp: '2026-08-23T00:00:00.000Z',
      level: LogLevel.info,
      runtime: 'dart',
      appName: 'test-app',
      message: id,
      values: <Object?>[id],
      fields: const <String, Object?>{},
    );

class _FakeSocket implements SupabaseRealtimeSocket {
  final StreamController<Object?> _messages = StreamController<Object?>();
  final List<Map<String, Object?>> sent = <Map<String, Object?>>[];
  bool _closed = false;

  @override
  Future<void> get ready => Future<void>.value();

  @override
  Stream<Object?> get messages => _messages.stream;

  @override
  void send(String message) {
    if (_closed) throw StateError('socket is closed');
    final decoded = Map<String, Object?>.from(
      jsonDecode(message) as Map<Object?, Object?>,
    );
    sent.add(decoded);
    scheduleMicrotask(() {
      if (_closed) return;
      _messages.add(jsonEncode(<String, Object?>{
        'topic': decoded['topic'],
        'event': 'phx_reply',
        'payload': <String, Object?>{
          'status': 'ok',
          'response': const <String, Object?>{},
        },
        'ref': decoded['ref'],
      }));
    });
  }

  @override
  Future<void> close([int? code, String? reason]) async {
    if (_closed) return;
    _closed = true;
    await _messages.close();
  }
}
