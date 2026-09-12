import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:oresoftware_next_loggers/supabase_log_commit_transport.dart';
import 'package:test/test.dart';

void main() {
  test('replays stable event and batch IDs after a lost acknowledgement',
      () async {
    final sentFrames = <Map<String, Object?>>[];
    final sockets = <_FakeCommitSocket>[];
    var connectionCount = 0;

    Future<CommitSocket> connector(
      Uri endpoint,
      Map<String, String> headers,
    ) async {
      expect(endpoint.scheme, 'wss');
      expect(headers['Authorization'], 'Bearer short-lived-ticket');
      connectionCount += 1;

      final socket = _FakeCommitSocket(
        onSend: (value) {
          final decoded = jsonDecode(value) as Map<String, Object?>;
          sentFrames.add(decoded);
          if (connectionCount == 2) {
            final events = decoded['events']! as List<Object?>;
            final event = events.single! as Map<String, Object?>;
            return jsonEncode(<String, Object?>{
              'type': 'next_log_ack_v1',
              'batchId': decoded['batchId'],
              'committed': true,
              'eventIds': <Object?>[event['id']],
            });
          }
          return null;
        },
      );
      sockets.add(socket);
      return socket;
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
    expect(sockets.every((socket) => socket.isClosed), isTrue);
    await transport.close();

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
    final sockets = <_FakeCommitSocket>[];
    Future<CommitSocket> connector(
      Uri endpoint,
      Map<String, String> headers,
    ) async {
      final socket = _FakeCommitSocket(
        onSend: (value) {
          final decoded = jsonDecode(value) as Map<String, Object?>;
          return jsonEncode(<String, Object?>{
            'type': 'next_log_ack_v1',
            'batchId': decoded['batchId'],
            'committed': true,
            'eventIds': const <String>[],
          });
        },
      );
      sockets.add(socket);
      return socket;
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
    expect(sockets.single.isClosed, isTrue);
    await transport.close();
  });

  test('retains a durable acknowledgement when cleanup fails', () async {
    final socket = _FakeCommitSocket(
      failClose: true,
      onSend: (value) {
        final decoded = jsonDecode(value) as Map<String, Object?>;
        return jsonEncode(<String, Object?>{
          'type': 'next_log_ack_v1',
          'batchId': decoded['batchId'],
          'committed': true,
          'eventIds': <String>['late-event'],
        });
      },
    );
    final transport = _deadlineTransport((_, __) async => socket);
    await transport.send(_event());
    expect(socket.isClosed, isTrue);
    await transport.close();
  });

  test('closes a socket that connects after the deadline', () async {
    final connection = Completer<CommitSocket>();
    final lateSocket = _LateCommitSocket();
    final transport = _deadlineTransport((_, __) => connection.future);
    await expectLater(
        transport.send(_event()), throwsA(isA<SupabaseLogCommitException>()));
    connection.complete(lateSocket);
    await lateSocket.closed.future.timeout(const Duration(seconds: 1));
    expect(lateSocket.sent, isFalse);
    await transport.close();
  });

  test('consumes a late connection error after the deadline', () async {
    final connection = Completer<CommitSocket>();
    final transport = _deadlineTransport((_, __) => connection.future);
    await expectLater(
        transport.send(_event()), throwsA(isA<SupabaseLogCommitException>()));
    connection.completeError(StateError('synthetic-sensitive-connector-error'));
    await Future<void>.delayed(Duration.zero);
    await transport.close();
  });

  test('does not expose connector diagnostic values', () async {
    final transport = _deadlineTransport((_, __) async {
      throw StateError('synthetic-sensitive-connector-error');
    });
    await expectLater(
        transport.send(_event()),
        throwsA(predicate<Object>(
          (error) =>
              error is SupabaseLogCommitException &&
              !error.toString().contains('synthetic-sensitive-connector-error'),
        )));
    await transport.close();
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
  _FakeCommitSocket({required this.onSend, this.failClose = false});

  final StreamController<Object?> _controller = StreamController<Object?>();
  final String? Function(String value) onSend;
  final bool failClose;
  bool get isClosed => _controller.isClosed;

  @override
  Stream<Object?> get messages => _controller.stream;

  @override
  void send(String value) {
    final response = onSend(value);
    if (response != null) {
      _controller.add(response);
    }
  }

  @override
  Future<void> close() async {
    await _controller.close();
    if (failClose) {
      throw StateError('synthetic-cleanup-error');
    }
  }
}

SupabaseLogEnvelope _event() => SupabaseLogEnvelope(
      id: 'late-event',
      tenantId: 'tenant-test',
      sessionId: 'session-test',
      occurredAt: DateTime.utc(2026, 9, 12),
      level: 'info',
      message: 'deadline-test',
    );

SupabaseLogCommitTransport _deadlineTransport(
        CommitSocketConnector connector) =>
    SupabaseLogCommitTransport(
        SupabaseLogCommitTransportOptions(
          endpoint: Uri.parse('wss://collector.example/v1/logs'),
          ticketProvider: () async => 'synthetic-ticket',
          connectTimeout: const Duration(milliseconds: 5),
          maxRetries: 0,
        ),
        connector: connector);

final class _LateCommitSocket implements CommitSocket {
  final closed = Completer<void>();
  bool sent = false;
  @override
  Stream<Object?> get messages => const Stream.empty();
  @override
  void send(String value) {
    sent = true;
  }

  @override
  Future<void> close() async {
    closed.complete();
  }
}
