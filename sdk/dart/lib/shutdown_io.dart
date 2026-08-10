import 'dart:async';
import 'dart:io';

import 'shutdown.dart';

final class IoShutdownBinding {
  IoShutdownBinding(this._subscriptions);
  final List<StreamSubscription<dynamic>> _subscriptions;

  Future<void> dispose() async {
    for (final subscription in _subscriptions) {
      await subscription.cancel();
    }
  }
}

/// Installs native signal sources. In a TTY, the first SIGINT/SIGTERM starts
/// drain and a second signal or Ctrl-D/stdin EOF forces. In non-TTY processes,
/// one signal starts shutdown and the coordinator's deadline escalates it.
IoShutdownBinding installIoShutdownSignals(
  ShutdownCoordinator coordinator, {
  bool? interactive,
  bool listenForStdinEof = true,
  Stream<List<int>>? stdinStream,
}) {
  final isInteractive = interactive ?? stdin.hasTerminal;
  final subscriptions = <StreamSubscription<dynamic>>[];

  void request(ShutdownTrigger trigger) {
    unawaited(
      coordinator.request(
        trigger,
        force: coordinator.phase == ShutdownPhase.draining,
        interactive: isInteractive,
      ),
    );
  }

  subscriptions.add(
    ProcessSignal.sigint.watch().listen((_) {
      request(ShutdownTrigger.sigint);
    }),
  );

  if (!Platform.isWindows) {
    subscriptions.add(
      ProcessSignal.sigterm.watch().listen((_) {
        request(ShutdownTrigger.sigterm);
      }),
    );
  }

  if (isInteractive && listenForStdinEof) {
    subscriptions.add(
      (stdinStream ?? stdin).listen(
        (_) {},
        onDone: () => request(ShutdownTrigger.stdinEof),
        cancelOnError: false,
      ),
    );
  }

  return IoShutdownBinding(subscriptions);
}
