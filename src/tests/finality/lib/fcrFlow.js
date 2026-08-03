// FCR scenario primitive (Layer B) — synchronize on validator state, never sleep.
//
// FCR processes at `safe` (fast) and revalidates at `finality`. To observe the
// pending→confirmed lifecycle we make the mock hold `safe` at the tip (so the
// watcher processes the deposit) while pinning `finalized` below it (so the
// checker cannot prune yet):
//
//   1. reset source mock → NORMAL
//   2. pin `finalized` at the current tip; `safe` keeps following the tip
//   3. deposit on the fcr chain → tx mined at block X (safe ≥ X, finalized < X)
//   4. wait for observer.pending(X)          ← synchronization, not sleep
//   5. advance the tip past X, `finalized` follows → checker validates hash
//   6. wait for observer.confirmed(X)         ← happy path (hash matches, no reorg)
//
// FCR detection is post-hoc: the bridge itself completes via `safe` regardless;
// what we assert is the checker's pending→confirmed bookkeeping.

import {
  resetMock,
  pinFinalized,
  getTip,
  advanceFinality,
  armReorg,
} from "./setMockState.js";
import { makeObserver, OBSERVER_CHAIN } from "../../../observer/index.js";
import { assert } from "../../../utils/validator.js";

// A syntactically-valid but bogus 32-byte block hash to reorg a block to.
const FAKE_HASH =
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, intervalMs, desc) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for ${desc} after ${timeoutMs}ms`);
}

// Happy path (FCR Condition 3): pending → confirmed. `source` is the fcr chain
// ("eth" | "gc"); `redisUrl` selects the oracle stack's Redis (amb / xdai).
export async function fcrHappyPathFlow({
  source = "eth",
  redisUrl,
  deposit, // async () => ({ blockNumber, receipt })
  pendingTimeoutMs = 90000,
  confirmTimeoutMs = 120000,
  pollIntervalMs = 3000,
  advanceBuffer = 3,
}) {
  const obsChain = OBSERVER_CHAIN[source];
  if (!obsChain) throw new Error(`Unknown fcr source chain "${source}"`);
  const observer = await makeObserver({ backend: "redis", url: redisUrl }).ready();

  try {
    // 1–2. NORMAL, then hold finalized below the upcoming deposit (safe follows).
    await resetMock(source);
    const tip0 = await getTip(source);
    await pinFinalized(source, tip0);
    console.log(`[fcr:${source}] pinned finalized at ${tip0}; safe follows tip`);

    // 3. Deposit — processed at safe, pending until finality.
    const { blockNumber: X } = await deposit();
    console.log(`[fcr:${source}] deposit mined at block ${X}`);
    assert(X > tip0, `deposit block ${X} above pinned finalized ${tip0}`);

    // 4. Observe pending.
    await waitFor(
      () => observer.pending(obsChain, X),
      pendingTimeoutMs,
      pollIntervalMs,
      `pending(${X})`,
    );
    const hash = await observer.pendingHash(obsChain, X);
    console.log(`[fcr:${source}] PENDING ✓ (blockHash ${hash})`);
    assert(
      !(await observer.falsePositive(obsChain, X, hash)),
      `no false positive recorded while pending`,
    );

    // 5. Advance finality past X → checker validates the (unchanged) hash.
    const newTip = await advanceFinality(source, X - tip0 + advanceBuffer);
    console.log(`[fcr:${source}] advanced finality → tip ${newTip} (≥ X=${X})`);

    // 6. Observe confirmed (pruned, not a false positive).
    await waitFor(
      () => observer.confirmed(obsChain, X, hash),
      confirmTimeoutMs,
      pollIntervalMs,
      `confirmed(${X})`,
    );
    assert(
      !(await observer.falsePositive(obsChain, X, hash)),
      `confirmed, not a false positive`,
    );
    console.log(`[fcr:${source}] CONFIRMED ✓ (pruned, no false positive)`);

    await resetMock(source);
    return { source, blockNumber: X, blockHash: hash };
  } finally {
    await observer.close();
  }
}

// FCR Condition 4 — reorg → false positive. Same setup as the happy path, but
// AFTER the block is pending (the real hash already stored at `safe`) we arm a
// reorg for block X. When finality crosses X the checker fetches block X, sees
// the mutated hash ≠ the stored hash, and records a false positive (nothing is
// undone on-chain — a false positive is detector-only).
export async function fcrReorgFalsePositiveFlow({
  source = "eth",
  redisUrl,
  deposit,
  fakeHash = FAKE_HASH,
  pendingTimeoutMs = 90000,
  falsePositiveTimeoutMs = 120000,
  pollIntervalMs = 3000,
  advanceBuffer = 3,
}) {
  const obsChain = OBSERVER_CHAIN[source];
  if (!obsChain) throw new Error(`Unknown fcr source chain "${source}"`);
  const observer = await makeObserver({ backend: "redis", url: redisUrl }).ready();

  try {
    await resetMock(source);
    const tip0 = await getTip(source);
    await pinFinalized(source, tip0);
    console.log(`[fcr:${source}] pinned finalized at ${tip0}; safe follows tip`);

    const { blockNumber: X } = await deposit();
    console.log(`[fcr:${source}] deposit mined at block ${X}`);
    assert(X > tip0, `deposit block ${X} above pinned finalized ${tip0}`);

    // Wait until the watcher has stored the REAL hash at safe.
    await waitFor(
      () => observer.pending(obsChain, X),
      pendingTimeoutMs,
      pollIntervalMs,
      `pending(${X})`,
    );
    const realHash = await observer.pendingHash(obsChain, X);
    console.log(`[fcr:${source}] PENDING ✓ (stored hash ${realHash})`);

    // Arm the reorg AFTER attestation — block X now returns a different hash.
    await armReorg(source, X, fakeHash);
    console.log(`[fcr:${source}] armed reorg on block ${X} → ${fakeHash}`);

    // Advance finality → checker revalidates X, hash mismatches → false positive.
    const newTip = await advanceFinality(source, X - tip0 + advanceBuffer);
    console.log(`[fcr:${source}] advanced finality → tip ${newTip} (≥ X=${X})`);

    await waitFor(
      () => observer.falsePositive(obsChain, X, realHash),
      falsePositiveTimeoutMs,
      pollIntervalMs,
      `falsePositive(${X})`,
    );
    const records = await observer.falsePositiveRecords(obsChain);
    console.log(`[fcr:${source}] FALSE POSITIVE ✓ recorded:`, JSON.stringify(records));

    await resetMock(source);
    return { source, blockNumber: X, realHash, fakeHash, records };
  } finally {
    await observer.close();
  }
}
