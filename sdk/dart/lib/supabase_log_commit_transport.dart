import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

typedef SupabaseLogTicketProvider = Future<String> Function();
typedef CommitSocketConnector = Future<CommitSocket> Function(
  Uri endpoint,
  Map<String, String> headers,
);

abstract interface class CommitSocket {
  Stream<Object?> get messages;

  void send(String value);

  Future<void> close();
}

final class SupabaseLogEnvelope {
  const SupabaseLogEnvelope({
    required this.id,
    required this.tenantId,
    required this.sessionId,
    required this.occurredAt,
    required this.level,
    required this.message,
    this.attributes = const <String, Object?>{},
  });

  final String id;
  final String tenantId;
  final String sessionId;
  final DateTime occurredAt;
  final String level;
  final String message;
  final Map<String, Object?> attributes;

  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'tenantId': tenantId,
        'sessionId': sessionId,
        'occurredAt': occurredAt.toUtc().toIso8601String(),
        'level': level,
        'message': message,
        'attributes': attributes,
      };
}

final class SupabaseLogCommitTransportOptions {
  const SupabaseLogCommitTransportOptions({
    required this.endpoint,
    required this.ticketProvider,
    this.connectTimeout = const Duration(seconds: 8),
    this.ackTimeout = const Duration(seconds: 12),
    this.maxBatchSize = 50,
    this.maxRetries = 3,
  });

  final Uri endpoint;
  final SupabaseLogTicketProvider ticketProvider;
  final Duration connectTimeout;
  final Duration ackTimeout;
  final int maxBatchSize;
  final int maxRetries;

  void validate() {
    if (endpoint.scheme != 'wss' || endpoint.host.isEmpty) {
      throw const FormatException('Collector endpoint must use WSS.');
    }
    if (endpoint.userInfo.isNotEmpty || endpoint.hasFragment) {
      throw const FormatException(
        'Collector endpoint may not contain credentials or fragments.',
      );
    }
    if (endpoint.path.contains('/realtime/v1/websocket')) {
      throw const FormatException(
        'Supabase Realtime broker acknowledgements are not durable commit acknowledgements.',
      );
    }
    if (maxBatchSize < 1 || maxBatchSize > 200) {
      throw RangeError.range(maxBatchSize, 1, 200, 'maxBatchSize');
    }
    if (maxRetries < 0 || maxRetries > 8) {
      throw RangeError.range(maxRetries, 0, 8, 'maxRetries');
    }
  }
}

final class SupabaseLogCommitException implements Exception {
  const SupabaseLogCommitException(this.message);

  final String message;

  @override
  String toString() => 'SupabaseLogCommitException: $message';
}

/// Durable WebSocket transport for a trusted collector that commits rows to
/// Supabase before issuing `next_log_ack_v1`.
///
/// Event IDs and batch IDs remain stable across retries. The collector must
/// enforce tenant scope from the short-lived ticket and upsert/dedupe on event
/// ID. A Supabase Realtime Broadcast `phx_reply` is deliberately not treated as
/// database durability evidence.
final class SupabaseLogCommitTransport {
  SupabaseLogCommitTransport(
    this.options, {
    CommitSocketConnector? connector,
    Random? random,
  })  : _connector = connector ?? _connectIo,
        _random = random ?? Random.secure() {
    options.validate();
  }

  final SupabaseLogCommitTransportOptions options;
  final CommitSocketConnector _connector;
  final Random _random;

  Future<void> _tail = Future<void>.value();
  bool _closed = false;

  Future<void> send(SupabaseLogEnvelope envelope) =>
      sendBatch(<SupabaseLogEnvelope>[envelope]);

  Future<void> sendBatch(List<SupabaseLogEnvelope> envelopes) {
    final immutable = List<SupabaseLogEnvelope>.unmodifiable(envelopes);
    final result = _tail.then<void>((_) => _sendAll(immutable));
    _tail = result.then<void>(
      (_) {},
      onError: (Object _, StackTrace __) {},
    );
    return result;
  }

  Future<void> _sendAll(List<SupabaseLogEnvelope> envelopes) async {
    if (_closed) {
      throw const SupabaseLogCommitException('Transport is closed.');
    }
    if (envelopes.isEmpty) {
      return;
    }

    final identifiers = envelopes.map((event) => event.id).toSet();
    if (identifiers.length != envelopes.length ||
        identifiers.any((id) => id.trim().isEmpty)) {
      throw const SupabaseLogCommitException(
        'Every event must have a non-empty, stable, unique ID.',
      );
    }
    if (envelopes.any(
      (event) =>
          event.tenantId.trim().isEmpty || event.sessionId.trim().isEmpty,
    )) {
      throw const SupabaseLogCommitException(
        'Every event must have tenant and session context.',
      );
    }

    for (var offset = 0;
        offset < envelopes.length;
        offset += options.maxBatchSize) {
      final end = min(offset + options.maxBatchSize, envelopes.length);
      final chunk = envelopes.sublist(offset, end);
      await _sendChunk(chunk, batchId: _newBatchId());
    }
  }

  Future<void> _sendChunk(
    List<SupabaseLogEnvelope> events, {
    required String batchId,
  }) async {
    Object? lastError;

    for (var attempt = 0; attempt <= options.maxRetries; attempt += 1) {
      CommitSocket? socket;
      try {
        final ticket = await options.ticketProvider();
        if (ticket.trim().isEmpty ||
            ticket.contains('\n') ||
            ticket.contains('\r')) {
          throw const SupabaseLogCommitException(
            'Collector ticket is invalid.',
          );
        }

        socket = await _connector(
          options.endpoint,
          <String, String>{'Authorization': 'Bearer $ticket'},
        ).timeout(options.connectTimeout);

        socket.send(
          jsonEncode(<String, Object?>{
            'type': 'next_log_batch_v1',
            'batchId': batchId,
            'events': events
                .map((event) => event.toJson())
                .toList(growable: false),
          }),
        );

        final ack = await socket.messages
            .map(_decodeMessage)
            .where((message) => message['type'] == 'next_log_ack_v1')
            .where((message) => message['batchId'] == batchId)
            .first
            .timeout(options.ackTimeout);

        _validateAck(ack, events);
        await socket.close();
        return;
      } on Object catch (error) {
        lastError = error;
        if (socket != null) {
          await socket.close();
        }
        if (attempt >= options.maxRetries) {
          break;
        }
        await Future<void>.delayed(_retryDelay(attempt));
      }
    }

    throw SupabaseLogCommitException(
      'Collector did not durably acknowledge batch $batchId: $lastError',
    );
  }

  static Map<String, Object?> _decodeMessage(Object? raw) {
    final text = switch (raw) {
      String value => value,
      List<int> bytes => utf8.decode(bytes),
      _ => throw const SupabaseLogCommitException(
          'Collector sent an unsupported frame.',
        ),
    };
    final decoded = jsonDecode(text);
    if (decoded is! Map<String, Object?>) {
      throw const SupabaseLogCommitException(
        'Collector frame must be a JSON object.',
      );
    }
    return decoded;
  }

  static void _validateAck(
    Map<String, Object?> ack,
    List<SupabaseLogEnvelope> events,
  ) {
    if (ack['committed'] != true) {
      throw const SupabaseLogCommitException(
        'Collector did not confirm commit.',
      );
    }

    final rawIds = ack['eventIds'];
    if (rawIds is! List<Object?>) {
      throw const SupabaseLogCommitException(
        'Commit acknowledgement lacks event IDs.',
      );
    }

    final committedIds = rawIds.whereType<String>().toSet();
    final expectedIds = events.map((event) => event.id).toSet();
    if (!committedIds.containsAll(expectedIds)) {
      throw const SupabaseLogCommitException(
        'Commit acknowledgement is incomplete.',
      );
    }
  }

  Duration _retryDelay(int attempt) {
    final exponential = min(8000, 250 * (1 << attempt));
    return Duration(milliseconds: exponential + _random.nextInt(250));
  }

  String _newBatchId() {
    final time =
        DateTime.now().toUtc().microsecondsSinceEpoch.toRadixString(36);
    final random = List<int>.generate(16, (_) => _random.nextInt(256))
        .map((value) => value.toRadixString(16).padLeft(2, '0'))
        .join();
    return 'nlb_$time$random';
  }

  Future<void> close() async {
    _closed = true;
    await _tail;
  }

  static Future<CommitSocket> _connectIo(
    Uri endpoint,
    Map<String, String> headers,
  ) async {
    final socket = await WebSocket.connect(
      endpoint.toString(),
      headers: headers,
    );
    socket.pingInterval = const Duration(seconds: 20);
    return _IoCommitSocket(socket);
  }
}

final class _IoCommitSocket implements CommitSocket {
  const _IoCommitSocket(this._socket);

  final WebSocket _socket;

  @override
  Stream<Object?> get messages => _socket;

  @override
  void send(String value) => _socket.add(value);

  @override
  Future<void> close() async {
    await _socket.close(WebSocketStatus.normalClosure, 'complete');
  }
}
