import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:oresoftware_next_loggers/supabase_log_commit_transport.dart';
import 'package:test/test.dart';

void main() {
  test('replays stable event and batch IDs after a lost acknowledgement',
      () async {
    final sentFrames = <Map<String, Object?>>[];
    var connectionCount = 0;

    Future<CommitSocket> connector(
      Uri endpoint,
      Map<String, String> headers,
    ) async {
      expect(endpoint.scheme, 'wss');
      expect(headers['Authorization'], 'Bearer short-lived-ticket');
      connectionCount += 1;

      final controller = StreamController<Object?>();
      return _FakeCommitSocket(
        controller,
        onSend: (value) {
          final decoded = jsonDecode(value) as Map<String, Object?>;
          sentFrames.add(decoded);
          if (connectionCount == 2) {
            final events = decoded['events']! as List<Object?>;
            final event = events.single! as Map<String, Object?>;
            controller.add(
              jsonEncode(<String, Object?>{
                'type': 'next_log_ack_v1',
                'batchId': decoded['batchId'],
                'committed': true,
                'eventIds': <Object?>[event['id']],
              }),
            );
          }
        },
      );
    }

    final transport = SupabaseLogCommitTransport(
      SupabaseLogCommitTransportOptions(
        endpoint: Uri.parse('wss://collector.example/v1/logs'),
        ticketProvider: () async => 'short-lived-ticket',
        ackTimeout: const Duration(milliseconds: 5),
        maxRetries: 1,
      ),
      connector: connector,
      random: Random(7),
    );

    await transport.send(
      SupabaseLogEnvelope(
        id: 'event-stable-1',
        tenantId: 'tenant-a',
        sessionId: 'session-a',
        occurredAt: DateTime.utc(2026, 8, 23),
        level: 'info',
        message: 'assignment-opened',
      ),
    );

    expect(connectionCount, 2);
    expect(sentFrames, hasLength(2));
    expect(sentFrames[0]['batchId'], sentFrames[1]['batchId']);

    final firstEvents = sentFrames[0]['events']! as List<Object?>;
    final secondEvents = sentFrames[1]['events']! as List<Object?>;
    expect(
      (firstEvents.single! as Map<String, Object?>)['id'],
      (secondEvents.single! as Map<String, Object?>)['id'],
    );
  });

  test('rejects the Supabase Realtime broker endpoint as durable storage', () {
    expect(
      () => SupabaseLogCommitTransport(
        SupabaseLogCommitTransportOptions(
          endpoint: Uri.parse(
            'wss://project.supabase.co/realtime/v1/websocket',
          ),
          ticketProvider: () async => 'ticket',
        ),
      ),
      throwsFormatException,
    );
  });

  test('requires a complete committed event-ID acknowledgement', () async {
    Future<CommitSocket> connector(
      Uri endpoint,
      Map<String, String> headers,
    ) async {
      final controller = StreamController<Object?>();
      return _FakeCommitSocket(
        controller,
        onSend: (value) {
          final decoded = jsonDecode(value) as Map<String, Object?>;
          controller.add(
            jsonEncode(<String, Object?>{
              'type': 'next_log_ack_v1',
              'batchId': decoded['batchId'],
              'committed': true,
              'eventIds': const <String>[],
            }),
          );
        },
      );
    }

    final transport = SupabaseLogCommitTransport(
      SupabaseLogCommitTransportOptions(
        endpoint: Uri.parse('wss://collector.example/v1/logs'),
        ticketProvider: () async => 'ticket',
        maxRetries: 0,
      ),
      connector: connector,
    );

    await expectLater(
      transport.send(
        SupabaseLogEnvelope(
          id: 'event-a',
          tenantId: 'tenant-a',
          sessionId: 'session-a',
          occurredAt: DateTime.utc(2026, 8, 23),
          level: 'warn',
          message: 'missing-ack',
        ),
      ),
      throwsA(isA<SupabaseLogCommitException>()),
    );
  });

  test('rejects duplicate event IDs before connecting', () async {
    var connected = false;
    final transport = SupabaseLogCommitTransport(
      SupabaseLogCommitTransportOptions(
        endpoint: Uri.parse('wss://collector.example/v1/logs'),
        ticketProvider: () async => 'ticket',
      ),
      connector: (endpoint, headers) async {
        connected = true;
        throw StateError('connector should not be called');
      },
    );

    final duplicate = SupabaseLogEnvelope(
      id: 'duplicate',
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      occurredAt: DateTime.utc(2026, 8, 23),
      level: 'info',
      message: 'duplicate',
    );

    await expectLater(
      transport.sendBatch(<SupabaseLogEnvelope>[duplicate, duplicate]),
      throwsA(isA<SupabaseLogCommitException>()),
    );
    expect(connected, isFalse);
  });
}

final class _FakeCommitSocket implements CommitSocket {
  _FakeCommitSocket(this._controller, {required this.onSend});

  final StreamController<Object?> _controller;
  final void Function(String value) onSend;

  @override
  Stream<Object?> get messages => _controller.stream;

  @override
  void send(String value) => onSend(value);

  @override
  Future<void> close() => _controller.close();
}
