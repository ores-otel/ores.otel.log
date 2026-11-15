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

// Check event-to-event deltas independently of the state invariants. A buggy
// transition can conserve totals yet still admit work after shutdown or issue
// a second ACK; conservation alone cannot detect those protocol violations.
const deltaByAction = Object.freeze({
  enqueue:       {accepted: 1, acknowledged: 0, queued: 1, inflight: 0, dropped: 0, phase: 0},
  overflow:      {accepted: 1, acknowledged: 0, queued: 0, inflight: 0, dropped: 1, phase: 0},
  dispatch:      {accepted: 0, acknowledged: 0, queued: -1, inflight: 1, dropped: 0, phase: 0},
  ack:           {accepted: 0, acknowledged: 1, queued: 0, inflight: -1, dropped: 0, phase: 0},
  transportDrop: {accepted: 0, acknowledged: 0, queued: 0, inflight: -1, dropped: 1, phase: 0},
  beginShutdown: {accepted: 0, acknowledged: 0, queued: 0, inflight: 0, dropped: 0, phase: 1},
  shutdownDrop:  {accepted: 0, acknowledged: 0, queued: -1, inflight: 0, dropped: 1, phase: 0},
  close:         {accepted: 0, acknowledged: 0, queued: 0, inflight: 0, dropped: 0, phase: 1}
});

function checkStep(before, after, label) {
  const expected = deltaByAction[label];
  assert(expected !== undefined, "unknown modeled transition");
  assert(before.phase < 2, "closed is terminal");
  if (label === "enqueue" || label === "overflow" || label === "beginShutdown")
    assert(before.phase === 0, "no admission after shutdown");
  if (label === "dispatch")
    assert(before.queued > 0 && before.inflight === 0,
      "dispatch requires a queued item and free flight slot");
  if (label === "ack" || label === "transportDrop")
    assert(before.inflight === 1, "ack/drop requires an in-flight item");
  if (label === "shutdownDrop")
    assert(before.phase === 1 && before.queued > 0,
      "shutdown drops only queued items after shutdown begins");
  if (label === "close")
    assert(before.phase === 1 && before.queued === 0 && before.inflight === 0,
      "close requires completed shutdown and drained work");
  for (const [key, delta] of Object.entries(expected))
    assert.equal(after[key] - before[key], delta,
      "incorrect " + label + " transition delta: " + key);
}

const queue = [initial], visited = new Set([JSON.stringify(initial)]), coverage = new Set();
let edges = 0;
for (let i = 0; i < queue.length; ++i) {
  const s = queue[i];
  invariant(s);
  for (const [label, next] of transitions(s)) {
    coverage.add(label);
    invariant(next);
    checkStep(s, next, label);
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
const stopping = queue.find(s => s.phase === 1 && s.accepted < limit && s.queued < capacity);
assert(stopping, "must reach a shutting-down state with spare capacity");
assert.throws(() => checkStep(stopping,
  { ...stopping, accepted: stopping.accepted + 1, queued: stopping.queued + 1 },
  "enqueue"), /no admission after shutdown/,
  "a conserved but unauthorized post-shutdown enqueue must fail");
const idle = queue.find(s => s.phase === 1 && s.inflight === 0);
assert(idle, "must reach shutdown state without in-flight work");
assert.throws(() => checkStep(idle,
  { ...idle, acknowledged: idle.acknowledged + 1, inflight: -1 },
  "ack"), /ack\/drop requires an in-flight item/,
  "double acknowledgement must fail even if counters offset");
console.log("PASS bounded-delivery-model", "states=" + visited.size, "edges=" + edges,
  "mutations=4", "guest=NOT_EXECUTED");
