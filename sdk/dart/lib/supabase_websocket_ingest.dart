import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'next_loggers.dart';

const oresSupabaseWebSocketProtocol = 'ores-otel/ws-ingest/v1';

typedef SupabaseTicketProvider = FutureOr<SupabaseWebSocketTicket> Function();
typedef SupabaseChannelFactory = OresWebSocketChannel Function(Uri uri);
typedef SupabaseIdFactory = String Function();
typedef SupabaseExitFallback = Future<SupabaseWebSocketCommitAck> Function(
  SupabaseWebSocketBatch batch,
);

class SupabaseWebSocketTicket {
  const SupabaseWebSocketTicket({
    required this.url,
    required this.ticket,
    this.expiresAt,
  });

  final Uri url;
  final String ticket;
  final DateTime? expiresAt;
}

class SupabaseTelemetrySession {
  const SupabaseTelemetrySession({
    required this.appName,
    required this.runtime,
    required this.sessionId,
    required this.clientInstanceId,
    this.appVersion,
    this.release,
  });

  final String appName;
  final String runtime;
  final String sessionId;
  final String clientInstanceId;
  final String? appVersion;
  final String? release;

  JsonMap toJson() => <String, Object?>{
        'appName': appName,
        'runtime': runtime,
        'sessionId': sessionId,
        'clientInstanceId': clientInstanceId,
        if (appVersion != null) 'appVersion': appVersion,
        if (release != null) 'release': release,
      };
}

class SupabaseWebSocketRecord {
  const SupabaseWebSocketRecord({required this.recordId, required this.record});

  final String recordId;
  final LogRecord record;

  JsonMap toJson() => <String, Object?>{
        'recordId': recordId,
        'record': record.toJson(),
      };
}

class SupabaseWebSocketBatch {
  const SupabaseWebSocketBatch({
    required this.batchId,
    required this.sequence,
    required this.sentAt,
    required this.session,
    required this.records,
  });

  final String batchId;
  final int sequence;
  final DateTime sentAt;
  final SupabaseTelemetrySession session;
  final List<SupabaseWebSocketRecord> records;

  JsonMap toJson() => <String, Object?>{
        'type': 'telemetry_batch',
        'protocol': oresSupabaseWebSocketProtocol,
        'batchId': batchId,
        'sequence': sequence,
        'sentAt': sentAt.toUtc().toIso8601String(),
        'session': session.toJson(),
        'records':
            records.map((record) => record.toJson()).toList(growable: false),
      };
}

class SupabaseWebSocketCommitAck {
  const SupabaseWebSocketCommitAck({
    required this.batchId,
    required this.sequence,
    required this.accepted,
    required this.duplicates,
    required this.committedAt,
  });

  final String batchId;
  final int sequence;
  final int accepted;
  final int duplicates;
  final DateTime committedAt;

  factory SupabaseWebSocketCommitAck.fromJson(JsonMap value) {
    if (value['type'] != 'commit_ack' ||
        value['protocol'] != oresSupabaseWebSocketProtocol ||
        value['batchId'] is! String ||
        value['sequence'] is! int ||
        value['accepted'] is! int ||
        value['duplicates'] is! int ||
        value['committedAt'] is! String) {
      throw const FormatException('invalid ORES Supabase commit ACK');
    }
    return SupabaseWebSocketCommitAck(
      batchId: value['batchId']! as String,
      sequence: value['sequence']! as int,
      accepted: value['accepted']! as int,
      duplicates: value['duplicates']! as int,
      committedAt: DateTime.parse(value['committedAt']! as String),
    );
  }
}

class SupabaseWebSocketSnapshot {
  const SupabaseWebSocketSnapshot({
    required this.queued,
    required this.inFlight,
    required this.accepted,
    required this.duplicates,
    required this.replayedBatches,
    required this.dropped,
    required this.failures,
    required this.protocolErrors,
    required this.reconnects,
    required this.connected,
    required this.accepting,
    required this.closed,
    required this.lastAcknowledgedSequence,
  });

  final int queued;
  final int inFlight;
  final int accepted;
  final int duplicates;
  final int replayedBatches;
  final int dropped;
  final int failures;
  final int protocolErrors;
  final int reconnects;
  final bool connected;
  final bool accepting;
  final bool closed;
  final int lastAcknowledgedSequence;
}

abstract interface class OresWebSocketChannel {
  Future<void> get ready;
  Stream<Object?> get stream;
  void add(Object? data);
  Future<void> close([int? code, String? reason]);
}

class PackageWebSocketChannel implements OresWebSocketChannel {
  PackageWebSocketChannel(Uri uri) : _channel = WebSocketChannel.connect(uri);

  final WebSocketChannel _channel;

  @override
  Future<void> get ready => _channel.ready;

  @override
  Stream<Object?> get stream => _channel.stream;

  @override
  void add(Object? data) => _channel.sink.add(data);

  @override
  Future<void> close([int? code, String? reason]) async {
    await _channel.sink.close(code, reason);
  }
}

class SupabaseWebSocketIngestTransport implements LogTransport {
  SupabaseWebSocketIngestTransport({
    required this.ticketProvider,
    required this.session,
    this.channelFactory = _defaultChannelFactory,
    this.exitFallback,
    this.allowedHosts = const <String>[],
    this.batchSize = 50,
    this.maxQueueSize = 2000,
    this.maxRecordBytes = 128 * 1024,
    this.flushInterval = const Duration(seconds: 1),
    this.acknowledgementTimeout = const Duration(seconds: 10),
    this.reconnectBase = const Duration(milliseconds: 250),
    this.reconnectMax = const Duration(seconds: 10),
    this.maxReconnectAttempts = 8,
    this.awaitAcknowledgement = false,
    this.recordIdFactory,
    this.batchIdFactory,
    this.clock,
    this.random,
    this.onDrop,
    this.onError,
  }) {
    if (batchSize < 1 || maxQueueSize < 1 || maxRecordBytes < 1) {
      throw ArgumentError('batch and queue limits must be positive');
    }
    if (maxReconnectAttempts < 0) {
      throw ArgumentError.value(maxReconnectAttempts, 'maxReconnectAttempts');
    }
    _validateSession(session);
  }

  final SupabaseTicketProvider ticketProvider;
  final SupabaseTelemetrySession session;
  final SupabaseChannelFactory channelFactory;
  final SupabaseExitFallback? exitFallback;
  final List<String> allowedHosts;
  final int batchSize;
  final int maxQueueSize;
  final int maxRecordBytes;
  final Duration flushInterval;
  final Duration acknowledgementTimeout;
  final Duration reconnectBase;
  final Duration reconnectMax;
  final int maxReconnectAttempts;
  final bool awaitAcknowledgement;
  final SupabaseIdFactory? recordIdFactory;
  final SupabaseIdFactory? batchIdFactory;
  final DateTime Function()? clock;
  final Random? random;
  final void Function(LogRecord record, String reason, int droppedTotal)?
      onDrop;
  final void Function(Object error, SupabaseWebSocketSnapshot snapshot)?
      onError;

  final List<SupabaseWebSocketRecord> _queue = <SupabaseWebSocketRecord>[];
  OresWebSocketChannel? _channel;
  // Durable until `_disconnect` cancels it (same-function cancel would drop the socket).
  // ignore: cancel_subscriptions
  StreamSubscription<Object?>? _subscription;
  SupabaseWebSocketBatch? _inFlight;
  Completer<SupabaseWebSocketCommitAck>? _ackCompleter;
  Future<void>? _flushFuture;
  Timer? _flushTimer;
  int _nextSequence = 1;
  int _accepted = 0;
  int _duplicates = 0;
  int _replayedBatches = 0;
  int _dropped = 0;
  int _failures = 0;
  int _protocolErrors = 0;
  int _reconnects = 0;
  int _lastAcknowledgedSequence = 0;
  bool _accepting = true;
  bool _closed = false;

  SupabaseWebSocketSnapshot snapshot() => SupabaseWebSocketSnapshot(
        queued: _queue.length,
        inFlight: _inFlight?.records.length ?? 0,
        accepted: _accepted,
        duplicates: _duplicates,
        replayedBatches: _replayedBatches,
        dropped: _dropped,
        failures: _failures,
        protocolErrors: _protocolErrors,
        reconnects: _reconnects,
        connected: _channel != null,
        accepting: _accepting,
        closed: _closed,
        lastAcknowledgedSequence: _lastAcknowledgedSequence,
      );

  @override
  Future<void> write(LogRecord record) async {
    if (!_enqueue(record)) return;
    if (awaitAcknowledgement || _queue.length >= batchSize) {
      final delivery = flush();
      if (awaitAcknowledgement) {
        await delivery;
      } else {
        unawaited(delivery.catchError(_reportError));
      }
    } else {
      _scheduleFlush();
    }
  }

  @override
  Future<void> flush() {
    final active = _flushFuture;
    if (active != null) return active;
    _flushTimer?.cancel();
    _flushTimer = null;
    late final Future<void> task;
    task = _drain().whenComplete(() {
      if (identical(_flushFuture, task)) _flushFuture = null;
      if (_accepting && _queue.isNotEmpty) _scheduleFlush();
    });
    _flushFuture = task;
    return task;
  }

  Future<void> flushOnExit([
    List<LogRecord> records = const <LogRecord>[],
  ]) async {
    for (final record in records) {
      _enqueue(record);
    }
    final fallback = exitFallback;
    if (fallback == null) {
      await flush();
      return;
    }
    _flushTimer?.cancel();
    _flushTimer = null;
    while (_inFlight != null || _queue.isNotEmpty) {
      final batch = _inFlight ?? _createBatch();
      if (batch == null) return;
      _inFlight = batch;
      _commit(batch, await fallback(batch));
    }
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _accepting = false;
    _flushTimer?.cancel();
    try {
      await flushOnExit();
    } finally {
      _closed = true;
      _rejectAck(StateError('Supabase WebSocket transport closed'));
      await _disconnect(1000, 'transport closed');
    }
  }

  bool _enqueue(LogRecord record) {
    if (!_accepting) {
      _drop(record, 'closed');
      return false;
    }
    final bytes = utf8.encode(jsonEncode(record.toJson())).length;
    if (bytes > maxRecordBytes) {
      _drop(record, 'record-too-large');
      return false;
    }
    if (_queue.length >= maxQueueSize) {
      final displaced = _queue.removeAt(0);
      _drop(displaced.record, 'queue-full');
    }
    _queue.add(
      SupabaseWebSocketRecord(
        recordId: recordIdFactory?.call() ?? _randomId('record'),
        record: record,
      ),
    );
    return true;
  }

  SupabaseWebSocketBatch? _createBatch() {
    if (_queue.isEmpty) return null;
    final count = min(batchSize, _queue.length);
    final records = List<SupabaseWebSocketRecord>.unmodifiable(
      _queue.getRange(0, count),
    );
    _queue.removeRange(0, count);
    return SupabaseWebSocketBatch(
      batchId: batchIdFactory?.call() ?? _randomId('batch'),
      sequence: _nextSequence,
      sentAt: (clock?.call() ?? DateTime.now()).toUtc(),
      session: session,
      records: records,
    );
  }

  Future<void> _drain() async {
    var attempts = 0;
    while (_inFlight != null || _queue.isNotEmpty) {
      final replay = _inFlight != null;
      final batch = _inFlight ?? _createBatch();
      if (batch == null) return;
      _inFlight = batch;
      if (replay) _replayedBatches += 1;
      try {
        await _connect();
        _commit(batch, await _sendAndWait(batch));
        attempts = 0;
      } catch (error) {
        _failures += 1;
        _reportError(error);
        await _disconnect(1012, 'retrying unacknowledged batch');
        if (attempts >= maxReconnectAttempts) rethrow;
        attempts += 1;
        _reconnects += 1;
        await Future<void>.delayed(_reconnectDelay(attempts));
      }
    }
  }

  Future<void> _connect() async {
    if (_channel != null) return;
    final ticket = await ticketProvider();
    _validateTicket(ticket);
    final channel = channelFactory(ticket.url);
    _channel = channel;
    try {
      await channel.ready.timeout(acknowledgementTimeout);
      // Durable until `_disconnect` cancels it; same-function cancel would
      // drop the socket on the first message.
      // ignore: cancel_subscriptions
      _subscription = channel.stream.listen(
        _handleMessage,
        onError: (Object error, StackTrace stackTrace) {
          _rejectAck(error);
        },
        onDone: () {
          _channel = null;
          _rejectAck(StateError('Supabase WebSocket closed before commit ACK'));
        },
        cancelOnError: false,
      );
      channel.add(
        jsonEncode(<String, Object?>{
          'type': 'hello',
          'protocol': oresSupabaseWebSocketProtocol,
          'ticket': ticket.ticket,
          'session': session.toJson(),
        }),
      );
    } catch (_) {
      _channel = null;
      rethrow;
    }
  }

  Future<SupabaseWebSocketCommitAck> _sendAndWait(
    SupabaseWebSocketBatch batch,
  ) async {
    final channel = _channel;
    if (channel == null)
      throw StateError('Supabase WebSocket is not connected');
    if (_ackCompleter != null) {
      throw StateError('only one Supabase telemetry batch may be in flight');
    }
    final completer = Completer<SupabaseWebSocketCommitAck>();
    _ackCompleter = completer;
    channel.add(jsonEncode(batch.toJson()));
    try {
      return await completer.future.timeout(acknowledgementTimeout);
    } on TimeoutException {
      _rejectAck(
        TimeoutException(
          'Supabase commit ACK timed out for ${batch.batchId}',
          acknowledgementTimeout,
        ),
      );
      rethrow;
    }
  }

  void _handleMessage(Object? raw) {
    JsonMap value;
    try {
      final decoded = jsonDecode(
        raw is String ? raw : utf8.decode(raw as List<int>),
      );
      if (decoded is! Map<String, Object?>) return;
      value = decoded;
    } catch (error) {
      _protocolFailure(error);
      return;
    }
    if (value['type'] != 'commit_ack') return;
    try {
      final ack = SupabaseWebSocketCommitAck.fromJson(value);
      final batch = _inFlight;
      if (batch == null ||
          ack.batchId != batch.batchId ||
          ack.sequence != batch.sequence) {
        throw const FormatException('commit ACK batchId or sequence mismatch');
      }
      final completer = _ackCompleter;
      if (completer == null || completer.isCompleted) {
        throw const FormatException('commit ACK has no in-flight waiter');
      }
      _ackCompleter = null;
      completer.complete(ack);
    } catch (error) {
      _protocolFailure(error);
    }
  }

  void _commit(SupabaseWebSocketBatch batch, SupabaseWebSocketCommitAck ack) {
    if (ack.batchId != batch.batchId || ack.sequence != batch.sequence) {
      throw const FormatException('commit ACK batchId or sequence mismatch');
    }
    if (ack.accepted < 0 ||
        ack.duplicates < 0 ||
        ack.accepted + ack.duplicates != batch.records.length) {
      throw const FormatException(
        'commit ACK does not account for complete batch',
      );
    }
    _accepted += ack.accepted;
    _duplicates += ack.duplicates;
    _lastAcknowledgedSequence = batch.sequence;
    _nextSequence = batch.sequence + 1;
    _inFlight = null;
  }

  void _protocolFailure(Object error) {
    _protocolErrors += 1;
    _rejectAck(error);
    unawaited(_disconnect(1002, 'invalid commit ACK'));
  }

  void _rejectAck(Object error) {
    final completer = _ackCompleter;
    _ackCompleter = null;
    if (completer != null && !completer.isCompleted)
      completer.completeError(error);
  }

  Future<void> _disconnect(int code, String reason) async {
    final subscription = _subscription;
    _subscription = null;
    await subscription?.cancel();
    final channel = _channel;
    _channel = null;
    if (channel != null) await channel.close(code, reason);
  }

  void _scheduleFlush() {
    if (_flushTimer != null || !_accepting || _queue.isEmpty) return;
    _flushTimer = Timer(flushInterval, () {
      _flushTimer = null;
      unawaited(flush().catchError(_reportError));
    });
  }

  Duration _reconnectDelay(int attempt) {
    final exponent = min(20, max(0, attempt - 1));
    final baseMillis = min(
      reconnectMax.inMilliseconds,
      reconnectBase.inMilliseconds * pow(2, exponent).toInt(),
    );
    final jitter = 0.5 + (random ?? Random()).nextDouble() * 0.5;
    return Duration(milliseconds: (baseMillis * jitter).round());
  }

  void _drop(LogRecord record, String reason) {
    _dropped += 1;
    try {
      onDrop?.call(record, reason, _dropped);
    } catch (_) {
      // Diagnostics must not recurse through the logger.
    }
  }

  void _reportError(Object error) {
    try {
      onError?.call(error, snapshot());
    } catch (_) {
      // Diagnostics must not recurse through the logger.
    }
  }

  String _randomId(String prefix) {
    final value = (random ?? Random.secure()).nextInt(1 << 32);
    return '$prefix-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}-${value.toRadixString(36)}';
  }

  static OresWebSocketChannel _defaultChannelFactory(Uri uri) =>
      PackageWebSocketChannel(uri);

  static void _validateSession(SupabaseTelemetrySession session) {
    for (final value in <String>[
      session.appName,
      session.runtime,
      session.sessionId,
      session.clientInstanceId,
    ]) {
      if (value.trim().isEmpty) {
        throw ArgumentError(
          'Supabase telemetry session values must be non-empty',
        );
      }
    }
  }

  void _validateTicket(SupabaseWebSocketTicket ticket) {
    if (ticket.url.scheme != 'wss') {
      throw ArgumentError.value(
        ticket.url,
        'url',
        'Supabase telemetry requires wss',
      );
    }
    if (ticket.url.userInfo.isNotEmpty) {
      throw ArgumentError('Supabase WebSocket URL must not embed credentials');
    }
    if (ticket.ticket.trim().length < 16) {
      throw ArgumentError('Supabase WebSocket ticket is too short');
    }
    if (ticket.expiresAt != null &&
        !ticket.expiresAt!.toUtc().isAfter(DateTime.now().toUtc())) {
      throw StateError('Supabase WebSocket ticket is expired');
    }
    if (allowedHosts.isNotEmpty && !allowedHosts.contains(ticket.url.host)) {
      throw ArgumentError.value(ticket.url.host, 'url', 'host is not allowed');
    }
  }
}
