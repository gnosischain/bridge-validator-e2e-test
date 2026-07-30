// FCR startup-preflight primitives (FCR-02). The `safe` probe runs when the fcr
// watcher boots, so these set the mock's `safe` mode, restart the watcher, and
// assert on its logs — then restore `safe`→follow and restart to leave the
// stack healthy.
//
// Distinguishes:
//   safe → JSON-RPC -32602 (unsupported)  ⇒ alert loudly, then DOWNGRADE that
//                                           chain to block-finality for the
//                                           process lifetime
//   safe → result: null   (legit-empty)   ⇒ treat as None → finalized fallback
//
// The downgrade contract follows bridge-validator (`service/safe.rs`:
// `run_fcr_preflight` → `config.set_mode_for_chain(chain, BlockFinality)`): a
// provider that *rejects* the tag is a misconfiguration, and the operator must
// be told loudly — but the validator keeps bridging on `finalized` rather than
// dying or silently pretending it still has ~12s confirmation. The oracle is
// expected to match this; see ORACLE_FCR_DOWNGRADE_TODO.md.
//
// Backend selection: the assertions are backend-agnostic (the regexes accept
// both implementations' wording). Which stack they drive is infra, set by env:
//   FCR_SERVICE / FCR_CONTAINER  — e.g. `worker` / `bridge-worker` for rust
//   FCR_COMPOSE                  — compose file (see dockerControl.js)

import { safeUnsupported, safeNull, followSafe } from "./setMockState.js";
import { restartService, waitForLog } from "./dockerControl.js";

// Defaults target the amb affirmation watcher (ETH = foreign = fcr under `ethfcr-gcbf`).
const DEFAULTS = {
  service: "bridge_affirmation_amb",
  container: "docker-bridge_affirmation_amb-1",
};

// Env overrides win over the per-test oracle defaults, so the same assertions
// can be pointed at the rust worker without touching the test files.
const resolve = (arg, envKey, fallback) =>
  process.env[envKey] || arg || fallback;

// The `safe` tag was rejected outright (JSON-RPC error object present) — a
// misconfiguration, not a transient miss. Must be surfaced at error level.
const SAFE_REJECTED =
  /(rejects the 'safe' block tag|safe.{0,20}(tag|block).{0,20}(rejected|unsupported)|Block tag probe failed[^\n]*"tag":"safe")/i;

// The chain drops to block-finality for the rest of the process lifetime.
const DOWNGRADED = /(downgrad|demot)[a-z]*[^\n]*block[-_ ]finality/i;

// Still indexing afterwards, on the finalized tag — i.e. it neither crashed nor
// kept claiming fcr. Emitted every poll cycle in steady state, so this one only
// means anything when the log window is scoped to the boot under test (`since`).
const RUNNING_ON_FINALIZED =
  /(Last|Latest) finalized block|All blocks already processed/i;

// `safe` was ACCEPTED but is empty (result: null) — the legit-empty case, which
// must not be confused with the -32602 rejection above. Both alternatives are
// startup-preflight-scoped on purpose:
//   rust   — requires the [fcr-preflight:<chain>] prefix, so the runtime
//            resolver's per-cycle "accepted the 'safe' tag but has no safe
//            block yet" / "no safe block is available yet; falling back to the
//            finalized block this cycle" cannot satisfy it.
//   oracle — probeBlockByTag's startup null probe. Its pino fields may print
//            before or after the message depending on pino vs pino-pretty, so
//            the two parts are matched independently via lookaheads (which is
//            also why that branch matches empty-width — waitForLog tests one
//            line at a time, so `[^\n]*` spans the whole line).
export const SAFE_ACCEPTED_BUT_EMPTY = new RegExp(
  [
    "\\[fcr-preflight:[a-z0-9]+\\][^\\n]*accepts the 'safe' tag but has no safe block yet",
    "(?=[^\\n]*Block tag returned null)(?=[^\\n]*tag[\"':= ]+[\"']?safe)",
  ].join("|"),
  "i",
);

export async function assertSafeUnsupportedDowngrades({
  source = "eth",
  service: serviceArg,
  container: containerArg,
  timeoutMs = 90000,
} = {}) {
  const service = resolve(serviceArg, "FCR_SERVICE", DEFAULTS.service);
  const container = resolve(containerArg, "FCR_CONTAINER", DEFAULTS.container);
  try {
    await safeUnsupported(source);
    console.log(`[preflight:${source}] safe → unsupported (-32602); restarting ${service}…`);
    // `since` scopes every assertion below to THIS boot — otherwise a line from
    // a previous boot, still inside the default lookback, can satisfy one.
    const { since } = await restartService(service);

    // 1. Loud alert: the operator must learn the provider cannot serve `safe`.
    const rejectedLine = await waitForLog(container, SAFE_REJECTED, { timeoutMs, since });
    console.log(`[preflight:${source}] REJECTION-ALERTED ✓`);

    // 2. Explicit downgrade to block-finality (never a silent fcr that is
    //    actually running on finality).
    const downgradeLine = await waitForLog(container, DOWNGRADED, { timeoutMs, since });
    console.log(`[preflight:${source}] DOWNGRADED ✓ (fcr → block-finality)`);

    // 3. Still bridging, on `finalized`.
    const finalizedLine = await waitForLog(container, RUNNING_ON_FINALIZED, { timeoutMs, since });
    console.log(`[preflight:${source}] STILL-PROCESSING ✓ (on finalized)`);

    return { ok: true, rejectedLine, downgradeLine, finalizedLine };
  } finally {
    await followSafe(source);
    await restartService(service);
    console.log(`[preflight:${source}] restored safe → follow; ${service} restarted`);
  }
}

export async function assertSafeNullFallsBack({
  source = "eth",
  service: serviceArg,
  container: containerArg,
  timeoutMs = 90000,
} = {}) {
  const service = resolve(serviceArg, "FCR_SERVICE", DEFAULTS.service);
  const container = resolve(containerArg, "FCR_CONTAINER", DEFAULTS.container);
  try {
    await safeNull(source);
    console.log(`[preflight:${source}] safe → null; restarting ${service}…`);
    const { since } = await restartService(service);

    // Distinctive null-handling path (NOT the -32602 rejection path).
    const nullLine = await waitForLog(container, SAFE_ACCEPTED_BUT_EMPTY, {
      timeoutMs,
      since,
    });
    console.log(`[preflight:${source}] NULL-DETECTED ✓ (legit-empty safe)`);

    // Finalized fallback: watcher keeps operating on `finalized` (not crashed).
    const finalizedLine = await waitForLog(container, RUNNING_ON_FINALIZED, {
      timeoutMs,
      since,
    });
    console.log(`[preflight:${source}] FINALIZED-FALLBACK ✓ (still processing on finalized)`);
    return { ok: true, nullLine, finalizedLine };
  } finally {
    await followSafe(source);
    await restartService(service);
    console.log(`[preflight:${source}] restored safe → follow; ${service} restarted`);
  }
}
