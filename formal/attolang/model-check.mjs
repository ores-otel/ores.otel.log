import assert from "node:assert/strict";

// Finite abstract state machine, independent of the .atto source.
const limit = 3;
const capacity = 2;
const initial = Object.freeze({ phase: 0, accepted: 0, acknowledged: 0, queued: 0, inflight: 0, dropped: 0 });
function invariant(s) {
  assert.equal(s.accepted, s.acknowledged + s.queued + s.inflight + s.dropped, "delivery conservation");
  assert(s.accepted >= 0 && s.accepted <= limit, "accepted bound");
  assert(s.queued >= 0 && s.queued <= capacity, "queue bound");
  assert(s.inflight === 0 || s.inflight === 1, "one in-flight item");
  assert(s.phase >= 0 && s.phase <= 2, "phase bound");
  if (s.phase === 2) assert(s.queued === 0 && s.inflight === 0, "terminal close drained");
}
function transitions(s) {
  const out = [];
  if (s.phase === 0 && s.accepted < limit) {
    if (s.queued < capacity) out.push(["enqueue", { ...s, accepted: s.accepted + 1, queued: s.queued + 1 }]);
    else out.push(["overflow", { ...s, accepted: s.accepted + 1, dropped: s.dropped + 1 }]);
  }
  if (s.phase < 2 && s.queued > 0 && s.inflight === 0)
    out.push(["dispatch", { ...s, queued: s.queued - 1, inflight: 1 }]);
  if (s.inflight === 1) {
    out.push(["ack", { ...s, inflight: 0, acknowledged: s.acknowledged + 1 }]);
    out.push(["transportDrop", { ...s, inflight: 0, dropped: s.dropped + 1 }]);
  }
  if (s.phase === 0) out.push(["beginShutdown", { ...s, phase: 1 }]);
  if (s.phase === 1 && s.queued > 0)
    out.push(["shutdownDrop", { ...s, queued: s.queued - 1, dropped: s.dropped + 1 }]);
  if (s.phase === 1 && s.queued === 0 && s.inflight === 0)
    out.push(["close", { ...s, phase: 2 }]);
  return out;
}
const queue = [initial], visited = new Set([JSON.stringify(initial)]), coverage = new Set();
let edges = 0;
for (let i = 0; i < queue.length; ++i) {
  const s = queue[i];
  invariant(s);
  for (const [label, next] of transitions(s)) {
    coverage.add(label);
    invariant(next);
    edges++;
    const key = JSON.stringify(next);
    if (!visited.has(key)) { visited.add(key); queue.push(next); }
  }
}
for (const action of ["enqueue", "overflow", "dispatch", "ack", "transportDrop", "beginShutdown", "shutdownDrop", "close"])
  assert(coverage.has(action), "unreachable action: " + action);
const dispatched = queue.find(s => s.inflight === 1);
assert(dispatched, "dispatch witness must exist");
assert.throws(() => invariant({ ...dispatched, acknowledged: dispatched.acknowledged + 1 }),
  /delivery conservation/, "double-ack negative mutation must fail");
assert.throws(() => invariant({ ...dispatched, phase: 2 }), /terminal close drained/,
  "premature close negative mutation must fail");
console.log("PASS bounded-delivery-model", "states=" + visited.size, "edges=" + edges,
  "mutations=2", "guest=NOT_EXECUTED");
