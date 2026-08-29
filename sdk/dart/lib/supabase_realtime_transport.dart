import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:math';

import 'package:web_socket_channel/status.dart' as status;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'next_loggers.dart';

const String supabaseRealtimeBatchSchema = 'next-loggers/realtime-batch/v1';

typedef SupabaseAccessTokenProvider = FutureOr<String?> Function();
typedef SupabaseRealtimeSocketFactory = SupabaseRealtimeSocket Function(
  Uri endpoint,
);

abstract interface class SupabaseRealtimeSocket {
  Future<void> get ready;
  Stream<Object?> get messages;
  void send(String message);
  Future<void> close([int? code, String? reason]);
}

class _WebSocketChannelSocket implements SupabaseRealtimeSocket {
  _WebSocketChannelSocket(Uri endpoint)
      : _channel = WebSocketChannel.connect(endpoint);

  final WebSocketChannel _channel;

  @override
  Future<void> get ready => _channel.ready;

  @override
  Stream<Object?> get messages => _channel.stream;

  @override
  void send(String message) => _channel.sink.add(message);

  @override
  Future<void> close([int? code, String? reason]) async {
    await _channel.sink.close(code, reason);
  }
}

class SupabaseRealtimeDrop {
  const SupabaseRealtimeDrop({
    required this.reason,
    required this.record,
    required this.droppedTotal,
  });

  final String reason;
  final LogRecord record;
  final int droppedTotal;
}

class SupabaseRealtimeSnapshot {
  const SupabaseRealtimeSnapshot({
    required this.queued,
    required this.dropped,
    required this.failures,
    required this.reconnectAttempts,
    required this.accepting,
    required this.connected,
    required this.joined,
    required this.closed,
  });

  final int queued;
  final int dropped;
  final int failures;
  final int reconnectAttempts;
  final bool accepting;
  final bool connected;
  final bool joined;
  final bool closed;
}

class SupabaseRealtimeTransport implements LogTransport {
  SupabaseRealtimeTransport({
    required Uri url,
    required String publishableKey,
    required String channel,
    this.accessToken,
    this.allowUnauthenticated = false,
    this.privateChannel = true,
    this.event = 'next-loggers-batch',
    this.batchSize = 40,
    this.maxQueueSize = 2000,
    this.maxRecordBytes = 128 * 1024,
    this.maxBatchBytes = 240 * 1024,
    this.flushInterval = const Duration(milliseconds: 750),
    this.connectTimeout = const Duration(seconds: 8),
    this.ackTimeout = const Duration(seconds: 8),
    this.heartbeatInterval = const Duration(seconds: 25),
    this.retryBase = const Duration(milliseconds: 500),
    this.retryMax = const Duration(seconds: 30),
    this.fallbackAfterFailures = 3,
    this.fallback,
    this.awaitDelivery = false,
    SupabaseRealtimeSocketFactory? socketFactory,
    DateTime Function()? clock,
    Random? random,
    this.onDrop,
    this.onError,
  })  : assert(batchSize > 0),
        assert(maxQueueSize > 0),
        assert(maxRecordBytes > 0),
        assert(maxBatchBytes > 1024),
        assert(maxRecordBytes < maxBatchBytes),
        assert(!flushInterval.isNegative),
        assert(!connectTimeout.isNegative),
        assert(!ackTimeout.isNegative),
        assert(!heartbeatInterval.isNegative),
        assert(!retryBase.isNegative),
        assert(!retryMax.isNegative),
        assert(fallbackAfterFailures >= 0),
        _topic = 'realtime:${_assertTopic(channel)}',
        _socketFactory = socketFactory ?? _WebSocketChannelSocket.new,
        _clock = clock ?? DateTime.now,
        _random = random ?? Random.secure(),
        endpoint = _realtimeEndpoint(
          url,
          _assertClientCredential(publishableKey, 'a publishable key'),
        );

  final Uri endpoint;
  final SupabaseAccessTokenProvider? accessToken;
  final bool allowUnauthenticated;
  final bool privateChannel;
  final String event;
  final int batchSize;
  final int maxQueueSize;
  final int maxRecordBytes;
  final int maxBatchBytes;
  final Duration flushInterval;
  final Duration connectTimeout;
  final Duration ackTimeout;
  final Duration heartbeatInterval;
  final Duration retryBase;
  final Duration retryMax;
  final int fallbackAfterFailures;
  final LogTransport? fallback;
  final bool awaitDelivery;
  final void Function(SupabaseRealtimeDrop drop)? onDrop;
  final void Function(Object error, SupabaseRealtimeSnapshot snapshot)? onError;

  final String _topic;
  final SupabaseRealtimeSocketFactory _socketFactory;
  final DateTime Function() _clock;
  final Random _random;
  final ListQueue<_QueuedRecord> _queue = ListQueue<_QueuedRecord>();
  final Map<String, _PendingReply> _pendingReplies = <String, _PendingReply>{};

  SupabaseRealtimeSocket? _socket;
  StreamSubscription<Object?>? _subscription;
  Future<void>? _connectFuture;
  Future<void>? _drainFuture;
  Timer? _flushTimer;
  Timer? _retryTimer;
  Timer? _heartbeatTimer;
  String _joinRef = '';
  String? _lastAccessToken;
  bool _joined = false;
  bool _accepting = true;
  bool _closed = false;
  int _ref = 0;
  int _dropped = 0;
  int _failures = 0;
  int _reconnectAttempts = 0;

  SupabaseRealtimeSnapshot snapshot() => SupabaseRealtimeSnapshot(
        queued: _queue.length,
        dropped: _dropped,
        failures: _failures,
        reconnectAttempts: _reconnectAttempts,
        accepting: _accepting,
        connected: _socket != null,
        joined: _joined,
        closed: _closed,
      );

  @override
  Future<void> write(LogRecord record) async {
    if (!_enqueue(record)) return;
    if (_queue.length >= batchSize || awaitDelivery) {
      final delivery = flush();
      if (awaitDelivery) {
        await delivery;
      } else {
        unawaited(delivery.catchError((Object _) {}));
      }
    } else {
      _scheduleFlush();
    }
  }

  @override
  Future<void> flush() {
    final active = _drainFuture;
    if (active != null) return active;
    _flushTimer?.cancel();
    _flushTimer = null;
    var failed = false;
    final task = _drain().catchError((Object error, StackTrace stackTrace) {
      failed = true;
      _reportError(error);
      if (_accepting) _scheduleRetry();
      Error.throwWithStackTrace(error, stackTrace);
    }).whenComplete(() {
      _drainFuture = null;
      if (!failed && _queue.isNotEmpty && _accepting) _scheduleFlush();
    });
    _drainFuture = task;
    return task;
  }

  Future<void> flushOnExit(
      [Iterable<LogRecord> records = const <LogRecord>[]]) async {
    for (final record in records) {
      _enqueue(record);
    }
    final durableFallback = fallback;
    if (durableFallback != null) {
      await _drainToFallback(durableFallback);
      await Future<void>.sync(durableFallback.flush);
      return;
    }
    await flush();
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _accepting = false;
    _clearTimers();
    try {
      if (_queue.isNotEmpty) {
        final durableFallback = fallback;
        if (durableFallback != null) {
          await _drainToFallback(durableFallback);
        } else {
          await flush();
        }
      }
      if (_socket != null && _joined) {
        try {
          await _sendWithReply(
            _PhoenixMessage(
              topic: _topic,
              event: 'phx_leave',
              payload: const <String, Object?>{},
              ref: _nextRef(),
              joinRef: _joinRef,
            ),
          );
        } catch (_) {
          // Records are drained; channel leave is best effort.
        }
      }
      if (fallback != null) {
        await Future<void>.sync(fallback!.flush);
        await Future<void>.sync(fallback!.close);
      }
      _closed = true;
    } finally {
      await _disconnect(StateError('Supabase Realtime transport closed'));
    }
  }

  bool _enqueue(LogRecord record) {
    if (!_accepting) {
      _drop(record, 'closed');
      return false;
    }
    final encoded = jsonEncode(record.toJson());
    final bytes = utf8.encode(encoded).length;
    if (bytes > maxRecordBytes) {
      _drop(record, 'record-too-large');
      return false;
    }
    if (_queue.length >= maxQueueSize) {
      _drop(_queue.removeFirst().record, 'queue-full');
    }
    _queue.addLast(_QueuedRecord(record, encoded, bytes));
    return true;
  }

  void _drop(LogRecord record, String reason) {
    _dropped += 1;
    try {
      onDrop?.call(
        SupabaseRealtimeDrop(
          reason: reason,
          record: record,
          droppedTotal: _dropped,
        ),
      );
    } catch (_) {
      // Diagnostics must not recursively fail logging.
    }
  }

  void _reportError(Object error) {
    try {
      onError?.call(error, snapshot());
    } catch (_) {
      // Diagnostics must not recursively fail logging.
    }
  }

  List<_QueuedRecord> _takeBatch() {
    final batch = <_QueuedRecord>[];
    var bytes = 768;
    while (batch.length < batchSize && _queue.isNotEmpty) {
      final item = _queue.removeFirst();
      final nextBytes = item.bytes + 1;
      if (batch.isNotEmpty && bytes + nextBytes > maxBatchBytes) {
        _queue.addFirst(item);
        break;
      }
      batch.add(item);
      bytes += nextBytes;
    }
    return batch;
  }

  void _restoreBatch(Iterable<_QueuedRecord> batch) {
    for (final item in batch.toList(growable: false).reversed) {
      _queue.addFirst(item);
    }
    while (_queue.length > maxQueueSize) {
      _drop(_queue.removeLast().record, 'queue-full');
    }
  }

  Future<void> _drain() async {
    while (_queue.isNotEmpty) {
      final batch = _takeBatch();
      if (batch.isEmpty) return;
      final bool usingFallback = _shouldUseFallback();
      try {
        if (usingFallback) {
          final durableFallback = fallback;
          if (durableFallback == null) {
            throw StateError('Supabase Realtime fallback is unavailable');
          }
          await _sendBatchToFallback(batch, durableFallback);
        } else {
          await _sendBatch(batch);
        }
        _failures = 0;
        _reconnectAttempts = 0;
      } catch (error) {
        _failures += 1;
        _restoreBatch(batch);
        // Retry a failed WebSocket batch once through the durable fallback
        // after crossing the threshold. A fallback failure must escape rather
        // than spinning forever while the collector is unavailable.
        if (!usingFallback && _shouldUseFallback() && fallback != null) {
          continue;
        }
        rethrow;
      }
    }
  }

  bool _shouldUseFallback() =>
      fallback != null && _failures >= fallbackAfterFailures;

  Future<void> _sendBatchToFallback(
    Iterable<_QueuedRecord> batch,
    LogTransport durableFallback,
  ) async {
    for (final item in batch) {
      await Future<void>.sync(() => durableFallback.write(item.record));
    }
    await Future<void>.sync(durableFallback.flush);
  }

  Future<void> _drainToFallback(LogTransport durableFallback) async {
    while (_queue.isNotEmpty) {
      final batch = _takeBatch();
      if (batch.isEmpty) return;
      try {
        await _sendBatchToFallback(batch, durableFallback);
      } catch (_) {
        _restoreBatch(batch);
        rethrow;
      }
    }
  }

  Future<void> _sendBatch(Iterable<_QueuedRecord> batch) async {
    await _connect();
    await _refreshAccessTokenIfNeeded();
    final items = batch.toList(growable: false);
    final batchId = _deterministicBatchId(items);
    await _sendWithReply(
      _PhoenixMessage(
        topic: _topic,
        event: 'broadcast',
        payload: <String, Object?>{
          'type': 'broadcast',
          'event': event.trim().isEmpty ? 'next-loggers-batch' : event.trim(),
          'payload': <String, Object?>{
            'schema': supabaseRealtimeBatchSchema,
            'batchId': batchId,
            'sentAt': _now().toUtc().toIso8601String(),
            'records': items
                .map((item) => jsonDecode(item.encoded))
                .toList(growable: false),
          },
        },
        ref: _nextRef(),
        joinRef: _joinRef,
      ),
    );
  }

  Future<void> _connect() {
    if (_closed) {
      return Future<void>.error(
        StateError('Supabase Realtime transport is closed'),
      );
    }
    if (_socket != null && _joined) return Future<void>.value();
    final active = _connectFuture;
    if (active != null) return active;
    final task = _performConnect();
    _connectFuture = task.whenComplete(() => _connectFuture = null);
    return _connectFuture!;
  }

  Future<void> _performConnect() async {
    final socket = _socketFactory(endpoint);
    _socket = socket;
    _joined = false;
    _joinRef = '';
    await _subscription?.cancel();
    _subscription = null;
    _subscription = socket.messages.listen(
      _handleMessage,
      onError: (Object error, StackTrace stackTrace) {
        _handleDisconnected(socket, error);
      },
      onDone: () {
        _handleDisconnected(
          socket,
          StateError('Supabase Realtime WebSocket closed'),
        );
      },
      cancelOnError: false,
    );
    try {
      await socket.ready.timeout(connectTimeout);
      await _joinChannel();
      _joined = true;
      _reconnectAttempts = 0;
      _startHeartbeat();
    } catch (error) {
      await _disconnect(_asError(error), expected: socket);
      rethrow;
    }
  }

  Future<void> _joinChannel() async {
    final token = _assertClientToken(
      await _resolveAccessToken(),
      allowUnauthenticated,
    );
    _lastAccessToken = token;
    final ref = _nextRef();
    _joinRef = ref;
    await _sendWithReply(
      _PhoenixMessage(
        topic: _topic,
        event: 'phx_join',
        payload: <String, Object?>{
          'config': <String, Object?>{
            'broadcast': <String, Object?>{'ack': true, 'self': false},
            'presence': <String, Object?>{'enabled': false},
            'postgres_changes': const <Object?>[],
            'private': privateChannel,
          },
          if (token != null) 'access_token': token,
        },
        ref: ref,
        joinRef: ref,
      ),
      requireJoined: false,
    );
  }

  Future<void> _refreshAccessTokenIfNeeded() async {
    final token = _assertClientToken(
      await _resolveAccessToken(),
      allowUnauthenticated,
    );
    if (token == null || token == _lastAccessToken) return;
    await _sendWithReply(
      _PhoenixMessage(
        topic: _topic,
        event: 'access_token',
        payload: <String, Object?>{'access_token': token},
        ref: _nextRef(),
        joinRef: _joinRef,
      ),
    );
    _lastAccessToken = token;
  }

  Future<String?> _resolveAccessToken() async {
    final provider = accessToken;
    if (provider == null) return null;
    final token = await provider();
    return token?.trim().isEmpty == true ? null : token?.trim();
  }

  Future<void> _sendWithReply(
    _PhoenixMessage message, {
    bool requireJoined = true,
  }) {
    final socket = _socket;
    if (socket == null || (requireJoined && !_joined)) {
      return Future<void>.error(
        StateError('Supabase Realtime channel is not connected'),
      );
    }
    final completer = Completer<void>();
    final timer = Timer(ackTimeout, () {
      _pendingReplies.remove(message.ref);
      if (!completer.isCompleted) {
        completer.completeError(
          TimeoutException(
            'Supabase Realtime acknowledgement timed out for ref '
            '${message.ref}',
            ackTimeout,
          ),
        );
      }
    });
    _pendingReplies[message.ref] = _PendingReply(completer, timer);
    try {
      socket.send(jsonEncode(message.toJson()));
    } catch (error, stackTrace) {
      timer.cancel();
      _pendingReplies.remove(message.ref);
      completer.completeError(error, stackTrace);
    }
    return completer.future;
  }

  void _handleMessage(Object? data) {
    Object? decoded;
    try {
      decoded = jsonDecode(data.toString());
    } catch (_) {
      return;
    }
    if (decoded is! Map<Object?, Object?>) return;
    final eventName = decoded['event'];
    if (eventName == 'phx_error' || eventName == 'phx_close') {
      unawaited(
        _disconnect(
          StateError('Supabase Realtime sent $eventName'),
        ),
      );
      return;
    }
    if (eventName != 'phx_reply') return;
    final ref = decoded['ref'];
    if (ref is! String) return;
    final pending = _pendingReplies.remove(ref);
    if (pending == null) return;
    pending.timer.cancel();
    final payload = decoded['payload'];
    final statusValue =
        payload is Map<Object?, Object?> ? payload['status'] : null;
    if (statusValue == 'ok') {
      pending.completer.complete();
    } else {
      pending.completer.completeError(
        StateError('Supabase Realtime rejected ref $ref'),
      );
    }
  }

  void _handleDisconnected(SupabaseRealtimeSocket socket, Object error) {
    if (!identical(_socket, socket)) return;
    _rejectPending(_asError(error));
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _socket = null;
    _subscription = null;
    _joined = false;
    _joinRef = '';
    if (_accepting && _queue.isNotEmpty) _scheduleRetry();
  }

  Future<void> _disconnect(
    Object error, {
    SupabaseRealtimeSocket? expected,
  }) async {
    final socket = _socket;
    if (expected != null && !identical(expected, socket)) return;
    _rejectPending(_asError(error));
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _socket = null;
    _joined = false;
    _joinRef = '';
    final subscription = _subscription;
    _subscription = null;
    await subscription?.cancel();
    try {
      await socket?.close(status.normalClosure, 'next-loggers closed');
    } catch (_) {
      // A broken transport is already disconnected.
    }
  }

  void _rejectPending(Object error) {
    final failure = _asError(error);
    for (final pending in _pendingReplies.values) {
      pending.timer.cancel();
      if (!pending.completer.isCompleted) {
        pending.completer.completeError(failure);
      }
    }
    _pendingReplies.clear();
  }

  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(heartbeatInterval, (_) {
      if (_socket == null) return;
      unawaited(
        _sendWithReply(
          _PhoenixMessage(
            topic: 'phoenix',
            event: 'heartbeat',
            payload: const <String, Object?>{},
            ref: _nextRef(),
          ),
          requireJoined: false,
        ).catchError((Object error) async {
          await _disconnect(error);
        }),
      );
    });
  }

  void _scheduleFlush() {
    if (!_accepting ||
        _flushTimer != null ||
        _retryTimer != null ||
        _queue.isEmpty) {
      return;
    }
    _flushTimer = Timer(flushInterval, () {
      _flushTimer = null;
      unawaited(flush().catchError((Object _) {}));
    });
  }

  void _scheduleRetry() {
    if (!_accepting || _retryTimer != null || _queue.isEmpty) return;
    _flushTimer?.cancel();
    _flushTimer = null;
    final exponent = min(_reconnectAttempts, 20);
    final exponentialMillis = min(
      retryMax.inMilliseconds,
      retryBase.inMilliseconds * pow(2, exponent).toInt(),
    );
    final delayMillis =
        (exponentialMillis * (0.8 + _random.nextDouble() * 0.4)).round();
    _reconnectAttempts += 1;
    _retryTimer = Timer(Duration(milliseconds: delayMillis), () {
      _retryTimer = null;
      unawaited(() async {
        await _disconnect(StateError('Supabase Realtime reconnecting'));
        await flush();
      }()
          .catchError((Object _) {}));
    });
  }

  void _clearTimers() {
    _flushTimer?.cancel();
    _flushTimer = null;
    _retryTimer?.cancel();
    _retryTimer = null;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
  }

  String _nextRef() => '${++_ref}';

  DateTime _now() {
    try {
      final value = _clock();
      return value;
    } catch (_) {
      return DateTime.now();
    }
  }
}

class _QueuedRecord {
  const _QueuedRecord(this.record, this.encoded, this.bytes);

  final LogRecord record;
  final String encoded;
  final int bytes;
}

class _PendingReply {
  const _PendingReply(this.completer, this.timer);

  final Completer<void> completer;
  final Timer timer;
}

class _PhoenixMessage {
  const _PhoenixMessage({
    required this.topic,
    required this.event,
    required this.payload,
    required this.ref,
    this.joinRef,
  });

  final String topic;
  final String event;
  final Map<String, Object?> payload;
  final String ref;
  final String? joinRef;

  Map<String, Object?> toJson() => <String, Object?>{
        'topic': topic,
        'event': event,
        'payload': payload,
        'ref': ref,
        if (joinRef != null) 'join_ref': joinRef,
      };
}

String _assertTopic(String value) {
  final topic = value.trim().replaceFirst(RegExp(r'^realtime:'), '');
  if (topic.isEmpty ||
      topic.length > 180 ||
      RegExp(r'[\x00-\x1f\x7f]').hasMatch(topic)) {
    throw ArgumentError.value(
      value,
      'channel',
      'must be 1-180 printable characters',
    );
  }
  return topic;
}

Uri _realtimeEndpoint(Uri input, String publishableKey) {
  final sourceScheme = input.scheme.toLowerCase();
  final scheme = switch (sourceScheme) {
    'https' => 'wss',
    'http' => 'ws',
    'wss' => 'wss',
    'ws' => 'ws',
    _ => throw ArgumentError.value(
        input,
        'url',
        'must use https, http, wss, or ws',
      ),
  };
  if (input.userInfo.isNotEmpty) {
    throw ArgumentError.value(input, 'url', 'must not contain credentials');
  }
  if (scheme == 'ws' &&
      !const <String>{'localhost', '127.0.0.1', '::1'}.contains(input.host)) {
    throw ArgumentError.value(input, 'url', 'requires WSS outside loopback');
  }
  var path = input.path.replaceFirst(RegExp(r'/+$'), '');
  if (!path.contains('/realtime/v1/websocket') &&
      !path.contains('/socket/websocket')) {
    path = '$path/realtime/v1/websocket';
  }
  return input.replace(
    scheme: scheme,
    path: path,
    queryParameters: <String, String>{
      ...input.queryParameters,
      'apikey': publishableKey,
      'vsn': '1.0.0',
    },
  ).removeFragment();
}

String _assertClientCredential(String value, String label) {
  final normalized = value.trim();
  if (normalized.isEmpty) {
    throw ArgumentError('SupabaseRealtimeTransport requires $label');
  }
  if (normalized.startsWith('sb_secret_') ||
      RegExp(r'service[_-]?role', caseSensitive: false).hasMatch(normalized) ||
      _decodeJwtRole(normalized) == 'service_role') {
    throw ArgumentError(
      'Secret/service-role Supabase credentials must never be used as $label',
    );
  }
  return normalized;
}

String? _assertClientToken(String? token, bool allowUnauthenticated) {
  if (token == null || token.isEmpty) {
    if (!allowUnauthenticated) {
      throw StateError(
        'Supabase Realtime telemetry requires a user access token; '
        'allow unauthenticated delivery only for a deliberately public gateway',
      );
    }
    return null;
  }
  return _assertClientCredential(token, 'a user access token');
}

String? _decodeJwtRole(String token) {
  final parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    final normalized = base64Url.normalize(parts[1]);
    final payload = jsonDecode(utf8.decode(base64Url.decode(normalized)));
    if (payload is Map<Object?, Object?> && payload['role'] is String) {
      return payload['role'] as String;
    }
  } catch (_) {
    return null;
  }
  return null;
}

String _deterministicBatchId(Iterable<_QueuedRecord> records) {
  var left = 0x811c9dc5;
  var right = 0x9e3779b9;
  var count = 0;
  for (final item in records) {
    count += 1;
    for (var index = 0; index < item.encoded.length; index += 1) {
      final code = item.encoded.codeUnitAt(index);
      left = ((left ^ code) * 0x01000193) & 0xffffffff;
      right = ((right ^ (code + index)) * 0x85ebca6b) & 0xffffffff;
    }
  }
  return 'nl-rt-$count-${left.toRadixString(16).padLeft(8, '0')}'
      '${right.toRadixString(16).padLeft(8, '0')}';
}

Object _asError(Object error) => error;
