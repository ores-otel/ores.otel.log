package com.oresoftware.nextloggers;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/** Lifecycle coverage: idempotent close, error accumulation, and the JVM hook. */
public final class NextLoggersShutdownTest {
  public static void main(String[] args) throws Exception {
    closeIsIdempotent();
    everyTransportIsDrainedEvenAfterOneFails();
    flushOnExitWritesTheRecordsTheCallerStillHolds();
    shutdownHookInstallsAndUninstalls();
    System.out.println("NextLoggersShutdownTest: ok");
  }

  private static final class CountingTransport implements NextLoggers.Transport {
    final List<NextLoggers.LogRecord> records = new ArrayList<>();
    final AtomicInteger flushes = new AtomicInteger();
    final AtomicInteger exits = new AtomicInteger();
    final AtomicInteger closes = new AtomicInteger();
    private final String failOn;

    CountingTransport(String failOn) {
      this.failOn = failOn;
    }

    @Override
    public void write(NextLoggers.LogRecord record) {
      records.add(record);
    }

    @Override
    public void flush() throws Exception {
      flushes.incrementAndGet();
      if ("flush".equals(failOn)) throw new IllegalStateException("flush exploded");
    }

    @Override
    public void flushOnExit(List<NextLoggers.LogRecord> pending) throws Exception {
      exits.incrementAndGet();
      records.addAll(pending);
      if ("flushOnExit".equals(failOn)) throw new IllegalStateException("exit flush exploded");
    }

    @Override
    public void close() throws Exception {
      closes.incrementAndGet();
      if ("close".equals(failOn)) throw new IllegalStateException("close exploded");
    }
  }

  private static NextLoggers.Logger loggerWith(NextLoggers.Transport... transports) {
    NextLoggers.Options options = new NextLoggers.Options();
    options.appName = "shutdown";
    options.console = false;
    options.transports = List.of(transports);
    return new NextLoggers.Logger(options);
  }

  private static void closeIsIdempotent() {
    CountingTransport transport = new CountingTransport(null);
    NextLoggers.Logger logger = loggerWith(transport);
    logger.close();
    logger.close();
    logger.close();
    expect(transport.exits.get() == 1, "exit flush ran " + transport.exits.get() + " times");
    expect(transport.closes.get() == 1, "close ran " + transport.closes.get() + " times");
    expect(logger.isClosed(), "logger should report itself closed");
  }

  private static void everyTransportIsDrainedEvenAfterOneFails() {
    CountingTransport broken = new CountingTransport("close");
    CountingTransport healthy = new CountingTransport(null);
    NextLoggers.Logger logger = loggerWith(broken, healthy);
    RuntimeException caught = null;
    try {
      logger.close();
    } catch (RuntimeException error) {
      caught = error;
    }
    expect(caught != null, "a failing transport must surface");
    expect(caught.getSuppressed().length == 1, "the failure should be suppressed onto the summary");
    expect(healthy.closes.get() == 1, "a failing transport must not skip the next one");
  }

  private static void flushOnExitWritesTheRecordsTheCallerStillHolds() {
    CountingTransport transport = new CountingTransport(null);
    NextLoggers.Logger logger = loggerWith(transport);
    logger.info("live").send();
    int before = transport.records.size();
    logger.flushOnExit(List.copyOf(transport.records));
    expect(transport.records.size() == before * 2, "held records should be written on exit");
  }

  private static void shutdownHookInstallsAndUninstalls() {
    NextLoggers.Logger logger = loggerWith(new CountingTransport(null));
    NextLoggers.ShutdownHookHandle handle =
        NextLoggers.installShutdownHook(logger, Duration.ofSeconds(1));
    expect(handle.uninstall(), "an installed hook should be removable");
    expect(!handle.uninstall(), "removing twice should report false, not throw");
  }

  private static void expect(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
}
