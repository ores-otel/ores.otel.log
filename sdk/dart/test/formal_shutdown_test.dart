import 'dart:convert';
import 'dart:io';

import 'package:oresoftware_next_loggers/shutdown.dart';
import 'package:test/test.dart';

ShutdownPhase parsePhase(String value) => switch (value) {
      'running' => ShutdownPhase.running,
      'draining' => ShutdownPhase.draining,
      'forced' => ShutdownPhase.forced,
      'closed' => ShutdownPhase.closed,
      _ => throw FormatException('unknown shutdown phase: $value'),
    };

ShutdownStateEvent parseEvent(String value) => switch (value) {
      'trigger' => ShutdownStateEvent.trigger,
      'force-now' => ShutdownStateEvent.forceNow,
      'mark-closed' => ShutdownStateEvent.markClosed,
      _ => throw FormatException('unknown shutdown event: $value'),
    };

ShutdownAction parseAction(String value) => switch (value) {
      'begin-graceful' => ShutdownAction.beginGraceful,
      'force' => ShutdownAction.force,
      'close' => ShutdownAction.close,
      'ignore' => ShutdownAction.ignore,
      _ => throw FormatException('unknown shutdown action: $value'),
    };

void main() {
  test('Dart shutdown relation refines every shared formal vector', () async {
    final file = File('../../formal/shutdown-transitions.v1.json');
    final document =
        jsonDecode(await file.readAsString()) as Map<String, Object?>;

    expect(document['schema'], 'ores.otel.log/shutdown-transition-vectors/v1');
    expect(document['machine'], 'server-shutdown/v1');

    final cases = document['cases']! as List<Object?>;
    expect(cases, hasLength(12));
    for (final rawCase in cases) {
      final vector = rawCase! as Map<String, Object?>;
      final actual = transitionShutdownState(
        parsePhase(vector['phase']! as String),
        parseEvent(vector['event']! as String),
      );
      expect(
        actual.phase,
        parsePhase(vector['expectedPhase']! as String),
        reason: '${vector['id']} phase',
      );
      expect(
        actual.action,
        parseAction(vector['expectedAction']! as String),
        reason: '${vector['id']} action',
      );
    }
  });

  test('Dart state machine remains terminal after forced shutdown', () {
    final machine = ShutdownStateMachine(interactive: false);
    expect(machine.forceNow(), ShutdownAction.force);
    expect(machine.phase, ShutdownPhase.forced);
    expect(machine.trigger(ShutdownCause.sigterm), ShutdownAction.ignore);
    expect(machine.markClosed(), isFalse);
    expect(machine.phase, ShutdownPhase.forced);
  });
}
