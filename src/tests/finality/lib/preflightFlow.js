// FCR startup-preflight primitives (FCR-02). The `safe` probe runs when the fcr
// watcher boots, so these set the mock's `safe` mode, restart the watcher, and
// assert on its logs — then restore `safe`→follow and restart to leave the
// stack healthy.
//
// Distinguishes (per FCR_PLAN.md §5):
//   safe → JSON-RPC -32602 (unsupported)  ⇒ fail loud, retry, NO silent downgrade
//   safe → result: null   (legit-empty)   ⇒ treat as None → finalized fallback

import { safeUnsupported, safeNull, followSafe } from "./setMockState.js";
import { restartService, waitForLog } from "./dockerControl.js";

// Defaults target the amb affirmation watcher (ETH = foreign = fcr under P2).
const DEFAULTS = {
  service: "bridge_affirmation_amb",
  container: "docker-bridge_affirmation_amb-1",
};

export async function assertSafeUnsupportedFailsLoud({
  source = "eth",
  service = DEFAULTS.service,
  container = DEFAULTS.container,
  timeoutMs = 90000,
} = {}) {
  try {
    await safeUnsupported(source);
    console.log(`[preflight:${source}] safe → unsupported (-32602); restarting ${service}…`);
    await restartService(service);

    const line = await waitForLog(
      container,
      /Block tag probe failed[^\n]*"tag":"safe"[^\n]*unsupported/i,
      { timeoutMs },
    );
    console.log(`[preflight:${source}] FAIL-LOUD ✓ (probe retried, no silent downgrade)`);
    return { ok: true, line };
  } finally {
    await followSafe(source);
    await restartService(service);
    console.log(`[preflight:${source}] restored safe → follow; ${service} restarted`);
  }
}

export async function assertSafeNullFallsBack({
  source = "eth",
  service = DEFAULTS.service,
  container = DEFAULTS.container,
  timeoutMs = 90000,
} = {}) {
  try {
    await safeNull(source);
    console.log(`[preflight:${source}] safe → null; restarting ${service}…`);
    await restartService(service);

    // Distinctive null-handling path (NOT the -32602 "probe failed" path).
    const nullLine = await waitForLog(
      container,
      /Block tag returned null[^\n]*"tag":"safe"/i,
      { timeoutMs },
    );
    console.log(`[preflight:${source}] NULL-DETECTED ✓ (legit-empty safe)`);

    // Finalized fallback: watcher keeps operating on `finalized` (not crashed).
    const finalizedLine = await waitForLog(
      container,
      /(Last|Latest) finalized block|All blocks already processed/i,
      { timeoutMs },
    );
    console.log(`[preflight:${source}] FINALIZED-FALLBACK ✓ (still processing on finalized)`);
    return { ok: true, nullLine, finalizedLine };
  } finally {
    await followSafe(source);
    await restartService(service);
    console.log(`[preflight:${source}] restored safe → follow; ${service} restarted`);
  }
}
