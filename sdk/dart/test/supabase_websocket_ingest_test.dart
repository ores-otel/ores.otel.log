import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';
import 'package:test/test.dart';

class FakeChannel implements OresWebSocketChannel {
  FakeChannel({this.onSend});

  final void Function(Map<String, Object?> message, FakeChannel channel)?
  onSend;
  final StreamController<Object?> _messages =
      StreamController<Object?>.broadcast(sync: true);
  final List<Map<String, Object?>> sent = <Map<String, Object?>>[];
  bool closed = false;

  @override
  Future<void> get ready => Future<void>.value();

  @override
  Stream<Object?> get stream => _messages.stream;

  @override
  void add(Object? data) {
    if (closed) throw StateError('socket is closed');
    final decoded = jsonDecode(data! as String);
    if (decoded is! Map<String, Object?>) {
      throw StateError('outbound WebSocket message must be an object');
    }
    sent.add(decoded);
    onSend?.call(decoded, this);
  }

  void emit(Map<String, Object?> message) {
    if (!closed) _messages.add(jsonEncode(message));
  }

  @override
  Future<void> close([int? code, String? reason]) async {
    if (closed) return;
    closed = true;
    await _messages.close();
  }
}

const SupabaseTelemetrySession session = SupabaseTelemetrySession(
  appName: 'test-app',
  runtime: 'flutter',
  sessionId: 'session-pseudonymous',
  clientInstanceId: 'client-instance',
);

LogRecord logRecord([String id = 'log-1']) => LogRecord(
  id: id,
  timestamp: '2026-08-24T00:00:00.000Z',
  level: LogLevel.info,
  runtime: 'flutter',
  appName: 'test-app',
  message: 'hello',
  values: const <Object?>[],
  fields: const <String, Object?>{},
);

SupabaseWebSocketTicket ticket({String scheme = 'wss'}) =>
    SupabaseWebSocketTicket(
      url: Uri.parse(
        '$scheme://project.functions.supabase.co/telemetry-stream',
      ),
      ticket: 'one-time-ticket-1234567890',
    );

Map<String, Object?> commitAck(
  Map<String, Object?> batch, {
  String? batchId,
  int? accepted,
  int duplicates = 0,
}) => <String, Object?>{
  'type': 'commit_ack',
  'protocol': oresSupabaseWebSocketProtocol,
  'batchId': batchId ?? batch['batchId']! as String,
  'sequence': batch['sequence']! as int,
  'accepted': accepted ?? (batch['records']! as List<Object?>).length,
  'duplicates': duplicates,
  'committedAt': '2026-08-24T00:00:01.000Z',
};

Future<void> waitUntil(bool Function() predicate) async {
  final deadline = DateTime.now().add(const Duration(seconds: 1));
  while (!predicate()) {
    if (DateTime.now().isAfter(deadline)) {
      throw TimeoutException('condition timed out');
    }
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
}

SupabaseWebSocketIngestTransport transportFor(
  SupabaseChannelFactory factory, {
  int maxReconnectAttempts = 0,
  SupabaseTicketProvider? ticketProvider,
  SupabaseExitFallback? exitFallback,
}) => SupabaseWebSocketIngestTransport(
  ticketProvider: ticketProvider ?? () => ticket(),
  session: session,
  channelFactory: factory,
  exitFallback: exitFallback,
  batchSize: 1,
  awaitAcknowledgement: true,
  acknowledgementTimeout: const Duration(milliseconds: 500),
  reconnectBase: Duration.zero,
  reconnectMax: Duration.zero,
  maxReconnectAttempts: maxReconnectAttempts,
  recordIdFactory: () => 'record-stable',
  batchIdFactory: () => 'batch-stable',
  random: _ZeroRandom(),
);

class _ZeroRandom implements Random {
  @override
  bool nextBool() => false;

  @override
  double nextDouble() => 0;

  @override
  int nextInt(int max) => 0;
}

void main() {
  test('retains records until a matching database commit ACK', () async {
    late FakeChannel socket;
    final transport = transportFor((_) {
      socket = FakeChannel();
      return socket;
    });

    final delivery = transport.write(logRecord());
    await waitUntil(
      () => socket.sent.any((message) => message['type'] == 'telemetry_batch'),
    );
    final batch = socket.sent.firstWhere(
      (message) => message['type'] == 'telemetry_batch',
    );

    expect(transport.snapshot().inFlight, 1);
    expect(transport.snapshot().accepted, 0);
    socket.emit(commitAck(batch));
    await delivery;

    expect(transport.snapshot().inFlight, 0);
    expect(transport.snapshot().accepted, 1);
    expect(transport.snapshot().lastAcknowledgedSequence, 1);
    await transport.close();
  });

  test('replays the identical batch after disconnect before ACK', () async {
    var connection = 0;
    final batches = <Map<String, Object?>>[];
    final transport = transportFor((_) {
      connection += 1;
      return FakeChannel(
        onSend: (message, channel) {
          if (message['type'] != 'telemetry_batch') return;
          batches.add(message);
          if (connection == 1) {
            scheduleMicrotask(() => channel.close(1012, 'worker rotation'));
          } else {
            scheduleMicrotask(() => channel.emit(commitAck(message)));
          }
        },
      );
    }, maxReconnectAttempts: 1);

    await transport.write(logRecord());

    expect(batches, hasLength(2));
    expect(batches[0]['batchId'], batches[1]['batchId']);
    expect(batches[0]['sequence'], batches[1]['sequence']);
    expect(batches[0]['records'], batches[1]['records']);
    expect(transport.snapshot().replayedBatches, 1);
    expect(transport.snapshot().accepted, 1);
    await transport.close();
  });

  test('rejects a mismatched ACK without clearing the batch', () async {
    final transport = transportFor(
      (_) => FakeChannel(
        onSend: (message, channel) {
          if (message['type'] == 'telemetry_batch') {
            scheduleMicrotask(
              () => channel.emit(commitAck(message, batchId: 'wrong-batch')),
            );
          }
        },
      ),
    );

    await expectLater(
      transport.write(logRecord()),
      throwsA(isA<FormatException>()),
    );
    expect(transport.snapshot().protocolErrors, 1);
    expect(transport.snapshot().inFlight, 1);
    expect(transport.snapshot().accepted, 0);
  });

  test('uses the exact in-flight batch for HTTPS exit fallback', () async {
    SupabaseWebSocketBatch? persisted;
    final transport = SupabaseWebSocketIngestTransport(
      ticketProvider: () => ticket(),
      session: session,
      channelFactory: (_) => FakeChannel(),
      exitFallback: (batch) async {
        persisted = batch;
        return SupabaseWebSocketCommitAck(
          batchId: batch.batchId,
          sequence: batch.sequence,
          accepted: batch.records.length,
          duplicates: 0,
          committedAt: DateTime.utc(2026, 8, 24),
        );
      },
      batchSize: 50,
      awaitAcknowledgement: false,
      recordIdFactory: () => 'record-stable',
      batchIdFactory: () => 'batch-stable',
    );

    await transport.write(logRecord());
    await transport.flushOnExit();

    expect(persisted?.batchId, 'batch-stable');
    expect(persisted?.records.single.recordId, 'record-stable');
    expect(transport.snapshot().accepted, 1);
    expect(transport.snapshot().inFlight, 0);
    await transport.close();
  });

  test('requires WSS and a non-empty short-lived ticket', () async {
    final transport = transportFor(
      (_) => FakeChannel(),
      ticketProvider: () => ticket(scheme: 'ws'),
    );

    await expectLater(
      transport.write(logRecord()),
      throwsA(isA<ArgumentError>()),
    );
    expect(transport.snapshot().inFlight, 1);
  });
}
