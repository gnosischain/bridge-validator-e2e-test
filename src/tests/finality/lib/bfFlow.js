// Block-finality scenario primitive (Layer B) — asserts on-chain, no observer.
//
// The invariant under test: a validator in `block-finality` mode must NOT
// attest to a source event until that event's block is `finalized`. We prove it
// by owning the `finalized` pointer via the mock:
//
//   1. reset the source mock → NORMAL
//   2. pin `finalized` at the current tip (so any fresh deposit lands above it)
//   3. deposit on the source chain → tx mined at real block X (> pinned finalized)
//   4. NEGATIVE assertion: over a bounded window the bridge does NOT complete
//   5. advance the tip past X and let `finalized` follow → finalized ≥ X
//   6. POSITIVE assertion: the bridge completes
//
// bf-1 (stallsUntilFinalized) runs steps 1–4 with stopAfterStall.
// bf-2 (completesAfterFinalized) runs the whole flow.

import {
  resetMock,
  pinFinalized,
  getTip,
  advanceFinality,
} from "./setMockState.js";
import { assert } from "../../../utils/validator.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `isComplete` for `windowMs`; return true if it ever becomes true.
async function pollComplete(isComplete, windowMs, intervalMs) {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (await isComplete()) return true;
    await sleep(intervalMs);
  }
  return (await isComplete()) === true;
}

// Assert `isComplete` stays false for the whole window (fails fast if it flips).
async function assertStaysIncomplete(isComplete, windowMs, intervalMs) {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (await isComplete()) return false; // completed early → stall broken
    await sleep(intervalMs);
  }
  return true;
}

export async function blockFinalityFlow({
  source, // "eth" | "gc" — the chain in block-finality mode
  deposit, // async () => ({ relayTx, blockNumber, receipt })
  makeIsComplete, // (depositResult) => (async () => boolean)
  negativeWindowMs = 45000, // long enough to beat a normal relay, quick for CI
  completeTimeoutMs = 180000,
  pollIntervalMs = 5000,
  advanceBuffer = 3, // blocks to over-shoot X by when advancing finality
  stopAfterStall = false,
}) {
  // 1–2. NORMAL, then freeze finalized at the current tip.
  await resetMock(source);
  const tipBefore = await getTip(source);
  await pinFinalized(source, tipBefore);
  console.log(`[bf:${source}] pinned finalized at ${tipBefore} (tip before deposit)`);

  // 3. Deposit — mines above the pinned finalized.
  const depositResult = await deposit();
  const X = depositResult.blockNumber;
  console.log(`[bf:${source}] deposit mined at block ${X}`);
  assert(X > tipBefore, `deposit block ${X} is above pinned finalized ${tipBefore}`);

  const isComplete = makeIsComplete(depositResult);

  // 4. NEGATIVE: must not complete while finalized < X.
  console.log(
    `[bf:${source}] asserting NO completion for ${negativeWindowMs / 1000}s (finalized pinned < X)…`,
  );
  const stalled = await assertStaysIncomplete(isComplete, negativeWindowMs, pollIntervalMs);
  assert(stalled, `bridge stalled while source block ${X} unfinalized`);

  if (stopAfterStall) {
    await resetMock(source);
    return { source, blockNumber: X, completed: false, depositResult };
  }

  // 5. Advance finality past X.
  const needed = X - tipBefore + advanceBuffer;
  const newTip = await advanceFinality(source, needed);
  console.log(`[bf:${source}] advanced finality → tip ${newTip} (≥ X=${X})`);

  // 6. POSITIVE: now it completes.
  console.log(`[bf:${source}] asserting completion within ${completeTimeoutMs / 1000}s…`);
  const completed = await pollComplete(isComplete, completeTimeoutMs, pollIntervalMs);
  assert(completed, `bridge completed after finalized crossed block ${X}`);

  await resetMock(source);
  return { source, blockNumber: X, completed: true, depositResult };
}
