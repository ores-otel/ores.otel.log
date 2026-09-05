"""Bounded drains and opt-in process lifecycle hooks for next-loggers."""

from __future__ import annotations

import atexit
import inspect
import os
import signal
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

DEFAULT_TIMEOUT = 5.0


class ShutdownError(RuntimeError):
    """Every transport failure seen during one drain, so none is lost to the first."""

    def __init__(self, operation: str, errors: Sequence[BaseException]) -> None:
        super().__init__(
            "{0} failed on {1} transport(s): {2}".format(
                operation,
                len(errors),
                "; ".join(
                    "{0}: {1}".format(type(error).__name__, error) for error in errors
                ),
            )
        )
        self.operation = operation
        self.errors = list(errors)


def deadline_from(timeout: Optional[float]) -> Optional[float]:
    """Turn a relative budget into a monotonic instant; ``None`` means unbounded."""
    if timeout is None:
        return None
    return time.monotonic() + max(0.0, float(timeout))


def remaining_from(deadline: Optional[float]) -> Optional[float]:
    if deadline is None:
        return None
    return deadline - time.monotonic()


def _transport_name(transport: Any) -> str:
    return str(getattr(transport, "name", type(transport).__name__))


def _accepts_timeout(hook: Callable[..., Any]) -> bool:
    try:
        parameters = inspect.signature(hook).parameters
    except (TypeError, ValueError):
        return False
    for parameter in parameters.values():
        if parameter.kind is inspect.Parameter.VAR_KEYWORD:
            return True
        if parameter.name == "timeout" and parameter.kind in (
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        ):
            return True
    return False


def call_transport_hook(
    transport: Any,
    hook_name: str,
    deadline: Optional[float],
    args: Sequence[Any] = (),
) -> Optional[BaseException]:
    """Run one optional transport hook inside whatever budget is left.

    The budget is shared across transports rather than granted per call, so a
    slow first transport shortens — and never extends — the drain that follows.
    """
    hook = getattr(transport, hook_name, None)
    if not callable(hook):
        return None
    remaining = remaining_from(deadline)
    if remaining is not None and remaining <= 0:
        return TimeoutError(
            "shutdown budget expired before {0}.{1}()".format(
                _transport_name(transport), hook_name
            )
        )
    try:
        if remaining is not None and _accepts_timeout(hook):
            hook(*args, timeout=remaining)
        else:
            hook(*args)
    except Exception as error:
        return error
    return None


def raise_if_failed(operation: str, errors: Sequence[BaseException]) -> None:
    if errors:
        raise ShutdownError(operation, errors)


def _restore_and_reraise(signum: int) -> None:
    """Hand the signal back to the kernel default so the host stays killable."""
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)


class ProcessHooks:
    """Disposer returned by :func:`install_process_hooks`; call it to uninstall.

    ``hooks`` names what was actually attached and ``reason`` explains any hook
    the runtime refused, because a caller off the main thread silently gets an
    atexit-only drain that would otherwise look identical to the full install.
    """

    def __init__(
        self,
        hooks: Sequence[str],
        reason: str,
        uninstall: Callable[[], None],
    ) -> None:
        self.hooks: Tuple[str, ...] = tuple(hooks)
        self.reason = reason
        self._uninstall = uninstall

    def __call__(self) -> None:
        self._uninstall()


def install_process_hooks(
    logger: Any,
    *,
    timeout: float = DEFAULT_TIMEOUT,
    force_on_second_signal: bool = True,
) -> ProcessHooks:
    """Drain ``logger`` on interpreter exit, SIGTERM, and SIGINT.

    Nothing is installed by importing this module: hosts that embed the SDK own
    their own lifecycle. Previous SIGTERM/SIGINT handlers are chained after the
    drain instead of being replaced, and a second signal arriving while the
    drain is still running restores the default disposition and re-raises, so a
    wedged transport can never make the process unkillable.
    """
    state_lock = threading.Lock()
    draining = False
    previous_handlers: Dict[int, Any] = {}

    def drain() -> None:
        try:
            logger.close(timeout=timeout)
        except Exception as error:
            print(
                "next-loggers shutdown drain failed: {0}".format(error),
                file=sys.stderr,
            )

    def on_exit() -> None:
        drain()

    def on_signal(signum: int, frame: Any) -> None:
        nonlocal draining
        with state_lock:
            repeated = draining
            draining = True
        if repeated and force_on_second_signal:
            _restore_and_reraise(signum)
            return
        drain()
        previous = previous_handlers.get(signum)
        if callable(previous) and previous not in (signal.SIG_DFL, signal.SIG_IGN):
            previous(signum, frame)

    def uninstall() -> None:
        atexit.unregister(on_exit)
        for signum, previous in list(previous_handlers.items()):
            if signal.getsignal(signum) is on_signal:
                signal.signal(signum, previous)
        previous_handlers.clear()

    atexit.register(on_exit)
    hooks: List[str] = ["atexit"]
    reason = ""

    # signal.signal() is only legal on the main thread of the main interpreter.
    if threading.current_thread() is threading.main_thread():
        for attribute, hook in (("SIGTERM", "signal-sigterm"), ("SIGINT", "signal-sigint")):
            signum = getattr(signal, attribute, None)
            if signum is None:
                reason = "{0} is not available on this platform".format(attribute)
                continue
            try:
                previous_handlers[signum] = signal.signal(signum, on_signal)
            except (OSError, RuntimeError, ValueError) as error:
                reason = "{0} handler rejected by the runtime: {1}".format(attribute, error)
            else:
                hooks.append(hook)
    else:
        reason = (
            "signal handlers were skipped: install_process_hooks ran off the main thread"
        )

    return ProcessHooks(hooks, reason, uninstall)


__all__ = [
    "DEFAULT_TIMEOUT",
    "ProcessHooks",
    "ShutdownError",
    "call_transport_hook",
    "deadline_from",
    "install_process_hooks",
    "raise_if_failed",
    "remaining_from",
]
