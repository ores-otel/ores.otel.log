import atexit
import os
import select
import signal
import subprocess
import sys
import textwrap
import threading
import time
import unittest
from pathlib import Path
from typing import Any, List, Optional, Sequence

from next_loggers import Logger, MemoryTransport, ShutdownError, install_process_hooks
from next_loggers import shutdown as shutdown_module

SRC = str(Path(__file__).resolve().parents[1] / "src")


class CountingTransport:
    name = "counting"

    def __init__(self) -> None:
        self.records: List[Any] = []
        self.flush_count = 0
        self.exit_count = 0
        self.close_count = 0

    def write(self, record: Any) -> None:
        self.records.append(record)

    def flush(self) -> None:
        self.flush_count += 1

    def flush_on_exit(self, records: Sequence[Any]) -> None:
        self.exit_count += 1

    def close(self) -> None:
        self.close_count += 1


class SlowTransport:
    name = "slow"

    def __init__(self, delay: float) -> None:
        self.delay = delay

    def write(self, record: Any) -> None:
        pass

    def flush(self) -> None:
        time.sleep(self.delay)

    def flush_on_exit(self, records: Sequence[Any]) -> None:
        time.sleep(self.delay)


class BudgetTransport:
    name = "budget"

    def __init__(self) -> None:
        self.budgets: List[Optional[float]] = []

    def write(self, record: Any) -> None:
        pass

    def flush(self, timeout: Optional[float] = None) -> None:
        self.budgets.append(timeout)


class FailingTransport:
    name = "failing"

    def __init__(self) -> None:
        self.flush_count = 0

    def write(self, record: Any) -> None:
        pass

    def flush(self) -> None:
        self.flush_count += 1
        raise RuntimeError("flush exploded")

    def flush_on_exit(self, records: Sequence[Any]) -> None:
        raise RuntimeError("exit flush exploded")

    def close(self) -> None:
        raise RuntimeError("close exploded")


class BlockingTransport:
    name = "blocking"

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()

    def write(self, record: Any) -> None:
        pass

    def flush_on_exit(self, records: Sequence[Any]) -> None:
        self.entered.set()
        self.release.wait(10)


class LifecycleTests(unittest.TestCase):
    def test_close_is_idempotent(self):
        transport = CountingTransport()
        logger = Logger(transports=[transport], console=False)

        logger.close()
        logger.close()

        self.assertEqual(transport.close_count, 1)
        self.assertEqual(transport.exit_count, 1)

    def test_concurrent_close_runs_once(self):
        transport = CountingTransport()
        logger = Logger(transports=[transport], console=False)
        start = threading.Barrier(4)

        def close() -> None:
            start.wait()
            logger.close()

        threads = [threading.Thread(target=close) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(transport.close_count, 1)

    def test_context_manager_closes(self):
        transport = CountingTransport()
        with Logger(transports=[transport], console=False) as logger:
            logger.info("inside").send()
        self.assertEqual(transport.close_count, 1)
        self.assertEqual(len(transport.records), 1)

    def test_timeout_stops_the_drain_after_the_budget_expires(self):
        slow = SlowTransport(0.2)
        memory = MemoryTransport()
        logger = Logger(transports=[slow, memory], console=False)

        started = time.monotonic()
        with self.assertRaises(ShutdownError) as caught:
            logger.flush(timeout=0.05)
        elapsed = time.monotonic() - started

        self.assertLess(elapsed, 2.0)
        self.assertEqual(memory.flush_count, 0)
        self.assertTrue(all(isinstance(error, TimeoutError) for error in caught.exception.errors))

    def test_timeout_budget_is_shared_across_transports(self):
        slow = SlowTransport(0.1)
        budget = BudgetTransport()
        logger = Logger(transports=[slow, budget], console=False)

        logger.flush(timeout=5.0)

        self.assertEqual(len(budget.budgets), 1)
        remaining = budget.budgets[0]
        self.assertIsNotNone(remaining)
        self.assertGreater(remaining, 0)
        self.assertLess(remaining, 5.0)

    def test_close_without_timeout_stays_unbounded(self):
        budget = BudgetTransport()
        logger = Logger(transports=[budget], console=False)

        logger.close()

        self.assertEqual(budget.budgets, [None])

    def test_one_failing_transport_does_not_skip_the_others(self):
        failing = FailingTransport()
        memory = MemoryTransport()
        logger = Logger(transports=[failing, memory], console=False)
        logger.warn("recovered on exit")

        with self.assertRaises(ShutdownError) as caught:
            logger.close()

        self.assertTrue(memory.closed)
        self.assertEqual(len(memory.exit_records), 1)
        self.assertEqual(memory.flush_count, 1)
        self.assertEqual(
            sorted(str(error) for error in caught.exception.errors),
            ["close exploded", "exit flush exploded", "flush exploded"],
        )

    def test_flush_reports_every_failure_it_saw(self):
        first = FailingTransport()
        second = FailingTransport()
        logger = Logger(transports=[first, second], console=False)

        with self.assertRaises(ShutdownError) as caught:
            logger.flush()

        self.assertEqual(len(caught.exception.errors), 2)
        self.assertEqual(first.flush_count, 1)
        self.assertEqual(second.flush_count, 1)


class ProcessHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_term = signal.getsignal(signal.SIGTERM)
        self.previous_int = signal.getsignal(signal.SIGINT)
        self.addCleanup(signal.signal, signal.SIGTERM, self.previous_term)
        self.addCleanup(signal.signal, signal.SIGINT, self.previous_int)

    def test_install_reports_hooks_and_uninstall_restores_handlers(self):
        transport = CountingTransport()
        logger = Logger(transports=[transport], console=False)

        hooks = install_process_hooks(logger)

        self.assertEqual(hooks.hooks, ("atexit", "signal-sigterm", "signal-sigint"))
        self.assertEqual(hooks.reason, "")
        self.assertIsNot(signal.getsignal(signal.SIGTERM), self.previous_term)
        self.assertIsNot(signal.getsignal(signal.SIGINT), self.previous_int)

        hooks()

        self.assertIs(signal.getsignal(signal.SIGTERM), self.previous_term)
        self.assertIs(signal.getsignal(signal.SIGINT), self.previous_int)

        # Uninstalling twice must not restore a handler a third party has since
        # installed, and must not raise.
        hooks()
        self.assertIs(signal.getsignal(signal.SIGTERM), self.previous_term)

    def _run_exit_probe(self, uninstall: bool) -> str:
        """Runs a real interpreter to exit, since atexit only fires on teardown.

        atexit._ncallbacks() is a private counter and is not dependable across
        CPython builds, so the atexit hook is verified by its observable effect
        rather than by inspecting the registry.
        """
        program = textwrap.dedent(
            """
            import sys
            sys.path.insert(0, {src!r})
            from next_loggers import Logger, install_process_hooks

            class Probe:
                name = "probe"

                def write(self, record):
                    pass

                def close(self, timeout=None):
                    print("DRAINED", flush=True)

            hooks = install_process_hooks(Logger(transports=[Probe()], console=False))
            if {uninstall!r}:
                hooks()
            """
        ).format(src=SRC, uninstall=uninstall)
        result = subprocess.run(
            [sys.executable, "-c", program],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_atexit_hook_drains_on_interpreter_exit(self):
        self.assertIn("DRAINED", self._run_exit_probe(uninstall=False))

    def test_uninstall_detaches_the_atexit_hook(self):
        self.assertNotIn("DRAINED", self._run_exit_probe(uninstall=True))

    def test_signal_drains_then_chains_the_previous_handler(self):
        chained: List[int] = []
        signal.signal(signal.SIGTERM, lambda signum, frame: chained.append(signum))
        transport = CountingTransport()
        logger = Logger(transports=[transport], console=False)
        hooks = install_process_hooks(logger, timeout=1.0)
        self.addCleanup(hooks)

        signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)

        self.assertEqual(transport.close_count, 1)
        self.assertEqual(chained, [signal.SIGTERM])

    def test_second_signal_restores_the_default_disposition(self):
        forced: List[int] = []
        blocking = BlockingTransport()
        logger = Logger(transports=[blocking], console=False)
        hooks = install_process_hooks(logger, timeout=10.0)
        self.addCleanup(hooks)
        self.addCleanup(blocking.release.set)
        handler = signal.getsignal(signal.SIGTERM)
        original_force = shutdown_module._restore_and_reraise
        shutdown_module._restore_and_reraise = forced.append
        self.addCleanup(setattr, shutdown_module, "_restore_and_reraise", original_force)

        drain = threading.Thread(target=handler, args=(signal.SIGTERM, None))
        drain.start()
        self.assertTrue(blocking.entered.wait(5))

        handler(signal.SIGTERM, None)

        self.assertEqual(forced, [signal.SIGTERM])
        blocking.release.set()
        drain.join(10)
        self.assertFalse(drain.is_alive())

    def test_second_signal_is_ignorable_when_force_is_disabled(self):
        forced: List[int] = []
        blocking = BlockingTransport()
        logger = Logger(transports=[blocking], console=False)
        hooks = install_process_hooks(logger, timeout=10.0, force_on_second_signal=False)
        self.addCleanup(hooks)
        self.addCleanup(blocking.release.set)
        handler = signal.getsignal(signal.SIGTERM)
        original_force = shutdown_module._restore_and_reraise
        shutdown_module._restore_and_reraise = forced.append
        self.addCleanup(setattr, shutdown_module, "_restore_and_reraise", original_force)

        drain = threading.Thread(target=handler, args=(signal.SIGTERM, None))
        drain.start()
        self.assertTrue(blocking.entered.wait(5))
        blocking.release.set()

        handler(signal.SIGTERM, None)

        self.assertEqual(forced, [])
        drain.join(10)
        self.assertFalse(drain.is_alive())

    def test_off_main_thread_install_falls_back_to_atexit(self):
        logger = Logger(transports=[CountingTransport()], console=False)
        captured: List[Any] = []

        def install() -> None:
            captured.append(install_process_hooks(logger))

        worker = threading.Thread(target=install)
        worker.start()
        worker.join()
        hooks = captured[0]
        self.addCleanup(hooks)

        self.assertEqual(hooks.hooks, ("atexit",))
        self.assertIn("main thread", hooks.reason)
        self.assertIs(signal.getsignal(signal.SIGTERM), self.previous_term)

    def test_atexit_hook_drains_the_logger(self):
        transport = CountingTransport()
        logger = Logger(transports=[transport], console=False)
        hooks = install_process_hooks(logger)
        self.addCleanup(hooks)

        atexit._run_exitfuncs()

        self.assertEqual(transport.close_count, 1)

    def test_drain_failures_do_not_escape_the_hook(self):
        logger = Logger(transports=[FailingTransport()], console=False)
        hooks = install_process_hooks(logger, timeout=1.0)
        self.addCleanup(hooks)

        signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)


WEDGED_CHILD = """
import sys, time
sys.path.insert(0, {src!r})
from next_loggers import Logger, install_process_hooks


class Wedged:
    name = "wedged"

    def write(self, record):
        pass

    def flush_on_exit(self, records):
        print("draining", flush=True)
        time.sleep(120)


logger = Logger(transports=[Wedged()], console=False)
install_process_hooks(logger, timeout=120)
print("ready", flush=True)
while True:
    time.sleep(0.05)
"""


@unittest.skipUnless(os.name == "posix", "signal delivery requires a POSIX host")
class ForcedExitTests(unittest.TestCase):
    def _read_line(self, stream, timeout: float) -> str:
        ready, _, _ = select.select([stream], [], [], timeout)
        self.assertTrue(ready, "child produced no output within {0}s".format(timeout))
        return stream.readline().strip()

    def test_second_signal_kills_a_wedged_drain(self):
        child = subprocess.Popen(
            [sys.executable, "-c", WEDGED_CHILD.format(src=SRC)],
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(self._read_line(child.stdout, 20), "ready")
            child.send_signal(signal.SIGINT)
            self.assertEqual(self._read_line(child.stdout, 20), "draining")
            child.send_signal(signal.SIGINT)
            self.assertEqual(child.wait(timeout=20), -signal.SIGINT)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=10)
            child.stdout.close()


if __name__ == "__main__":
    unittest.main()
