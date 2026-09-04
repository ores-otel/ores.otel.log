package cloud.oresoftware.nextloggers;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/** Lifecycle coverage for the cloud.oresoftware artifact. */
public final class NextLoggersShutdownTest {
  public static void main(String[] args) throws Exception {
    closeIsIdempotent();
    everyTransportIsDrainedEvenAfterOneFails();
    shutdownHookInstallsAndUninstalls();
    System.out.println("cloud NextLoggersShutdownTest: ok");
  }

  private static final class CountingTransport implements NextLoggers.Transport {
    final List<Map<String, Object>> records = new ArrayList<>();
    final AtomicInteger exits = new AtomicInteger();
    final AtomicInteger closes = new AtomicInteger();
    private final boolean failOnClose;

    CountingTransport(boolean failOnClose) {
      this.failOnClose = failOnClose;
    }

    @Override
    public void write(Map<String, Object> record) {
      records.add(record);
    }

    @Override
    public void flushOnExit(List<Map<String, Object>> pending) {
      exits.incrementAndGet();
      records.addAll(pending);
    }

    @Override
    public void close() throws Exception {
      closes.incrementAndGet();
      if (failOnClose) throw new IllegalStateException("close exploded");
    }
  }

  private static void closeIsIdempotent() {
    CountingTransport transport = new CountingTransport(false);
    NextLoggers.Logger logger = new NextLoggers.Logger("shutdown", List.of(transport));
    logger.close();
    logger.close();
    expect(transport.exits.get() == 1, "exit flush ran " + transport.exits.get() + " times");
    expect(transport.closes.get() == 1, "close ran " + transport.closes.get() + " times");
    expect(logger.isClosed(), "logger should report itself closed");
  }

  private static void everyTransportIsDrainedEvenAfterOneFails() {
    CountingTransport broken = new CountingTransport(true);
    CountingTransport healthy = new CountingTransport(false);
    NextLoggers.Logger logger = new NextLoggers.Logger("shutdown", List.of(broken, healthy));
    RuntimeException caught = null;
    try {
      logger.close();
    } catch (RuntimeException error) {
      caught = error;
    }
    expect(caught != null, "a failing transport must surface");
    expect(healthy.closes.get() == 1, "a failing transport must not skip the next one");
  }

  private static void shutdownHookInstallsAndUninstalls() {
    NextLoggers.Logger logger =
        new NextLoggers.Logger("shutdown", List.of(new CountingTransport(false)));
    NextLoggers.ShutdownHookHandle handle =
        NextLoggers.installShutdownHook(logger, Duration.ofSeconds(1));
    expect(handle.uninstall(), "an installed hook should be removable");
    expect(!handle.uninstall(), "removing twice should report false, not throw");
  }

  private static void expect(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
}
