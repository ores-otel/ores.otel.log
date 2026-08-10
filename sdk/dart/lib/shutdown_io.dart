import 'shutdown.dart';

typedef IoShutdownBinding = ProcessShutdownController;

/// Installs native signal sources. In a TTY, the first SIGINT/SIGTERM starts
/// drain and a second signal or Ctrl-D/stdin EOF forces. In non-TTY processes,
/// one signal starts shutdown and the coordinator's deadline escalates it.
IoShutdownBinding installIoShutdownSignals(
  ProcessShutdownOptions options,
) =>
    installProcessShutdown(options);
