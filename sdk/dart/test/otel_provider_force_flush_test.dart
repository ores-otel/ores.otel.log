import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:oresoftware_next_loggers/next_loggers.dart';
import 'package:test/test.dart';

final class _AppOwnedProvider {
  _AppOwnedProvider([this.gate]);

  final Completer<void>? gate;
  int forceFlushCalls = 0;
  int shutdownCalls = 0;

  Future<void> forceFlush() async {
    forceFlushCalls += 1;
    await gate?.future;
  }

  Future<void> shutdown() async {
    shutdownCalls += 1;
  }
}

void main() {
  test('Dart refines the shared app-owned provider lifecycle corpus', () async {
    final corpus = jsonDecode(
      await File('../../formal/app_owned_provider_flush.v1.json')
          .readAsString(),
    ) as Map<String, Object?>;
    expect(corpus['schema'], 'ores.otel.log/app-owned-provider-flush/v1');
    expect(corpus['maximumCallbacks'], 32);
    expect(
      (corpus['invariants'] as Map<String, Object?>).values.every(
            (value) => value == true,
          ),
      isTrue,
    );

    for (final raw in corpus['vectors'] as List<Object?>) {
      final vector = raw as Map<String, Object?>;
      final gate = Completer<void>();
      final providers = List.generate(
        vector['callbackCount'] as int,
        (_) => _AppOwnedProvider(gate),
      );
      late final OpenTelemetryTransport transport;
      try {
        transport = OpenTelemetryTransport(
          (_) {},
          forceFlushCallbacks:
              providers.map((provider) => provider.forceFlush).toList(),
        );
      } on RangeError catch (error) {
        expect(vector['expectedValid'], isFalse,
            reason: vector['id'] as String);
        expect(error.toString(), contains('forceFlushCallbacks.length'));
        continue;
      }
      expect(vector['expectedValid'], isTrue, reason: vector['id'] as String);
      final flushes = List.generate(
        vector['concurrentFlushCallers'] as int,
        (_) => transport.flush(),
      );
      await Future<void>.delayed(Duration.zero);
      for (final provider in providers) {
        expect(
          provider.forceFlushCalls,
          vector['expectedForceFlushCallsPerProvider'],
          reason: vector['id'] as String,
        );
        expect(
          provider.shutdownCalls,
          vector['expectedShutdownCalls'],
          reason: vector['id'] as String,
        );
      }
      gate.complete();
      await Future.wait(flushes);
    }
  });

  test(
    'logger close force-flushes but never shuts down app-owned providers',
    () async {
      final provider = _AppOwnedProvider();
      final logger = Logger(
        console: false,
        transports: [
          OpenTelemetryTransport(
            (_) {},
            forceFlushCallbacks: [provider.forceFlush],
          ),
        ],
      );
      await logger.info('before logout').send();
      await logger.close();
      expect(provider.forceFlushCalls, 1);
      expect(provider.shutdownCalls, 0);
    },
  );

  test(
      'strict flush reports provider failures while ordinary flush stays fail-open',
      () async {
    var calls = 0;
    final logger = Logger(
      console: false,
      transports: [
        OpenTelemetryTransport(
          (_) {},
          forceFlushCallbacks: [
            () async {
              calls += 1;
              throw StateError('provider unavailable');
            },
          ],
        ),
      ],
    );
    await logger.flush();
    await expectLater(
      logger.flush(throwOnError: true),
      throwsA(isA<StateError>()),
    );
    expect(calls, 2);
  });
}
