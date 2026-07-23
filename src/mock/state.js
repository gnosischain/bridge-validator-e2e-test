// EL mock state model — see FCR_integration.md.
//
// State is composable, not one scalar "mode". Each of the four axes is
// independently controllable so a single mock can express every FCR /
// block-finality scenario:
//
//   transportChaos : inject RPC-transport failures scoped to a tag / all traffic
//   safe           : where the `safe` pointer comes from (follow | pin | null | unsupported)
//   finalized      : where the `finalized` pointer comes from (follow | pin)
//   reorgs         : per-block-number hash overrides (armed reorgs)
//
// NORMAL = both pointers `follow` the upstream tip, no reorgs, no chaos.
// Under NORMAL the mock is a transparent proxy → the existing Layer A suite
// passes untouched.

export const initialState = () => ({
  transportChaos: { kind: "NONE", scope: "all" }, // kind: NONE|ERROR_500|MALFORMED|JSONRPC_ERROR
  safe: { source: "follow", value: null, lag: 0 }, // follow => latest - lag
  finalized: { source: "follow", value: null, lag: 0 },
  reorgs: {}, // { [blockNumber:number]: "0x<hash>" }
});

// Shallow-merge a patch into state. Nested objects (safe/finalized/
// transportChaos/reorgs) are merged one level deep so callers can patch a
// single field (e.g. { finalized: { source: "pin", value: 123 } }) without
// clobbering the others. A patch of `null`/`undefined` is a no-op.
export function applyPatch(state, patch) {
  if (!patch || typeof patch !== "object") return state;
  for (const key of Object.keys(patch)) {
    const val = patch[key];
    if (key === "reorgs") {
      // merge reorg entries; an explicit null value clears one
      for (const [n, hash] of Object.entries(val || {})) {
        if (hash === null) delete state.reorgs[n];
        else state.reorgs[n] = hash;
      }
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      state[key] = { ...state[key], ...val };
    } else {
      state[key] = val;
    }
  }
  return state;
}

// Resolve a `safe`/`finalized` tag against current state + the upstream tip.
// Returns a discriminated result:
//   { kind: "number", number }   → proxy getBlock(number) for a real hash/txs
//   { kind: "null" }             → return JSON-RPC result: null (legit-empty)
//   { kind: "unsupported" }      → return JSON-RPC error -32602 (rejected tag)
export function resolveTag(state, tag, latestNumber) {
  const cfg = tag === "safe" ? state.safe : state.finalized;
  switch (cfg.source) {
    case "unsupported":
      return { kind: "unsupported" };
    case "null":
      return { kind: "null" };
    case "pin":
      return { kind: "number", number: Number(cfg.value) };
    case "follow":
    default:
      return { kind: "number", number: latestNumber - (cfg.lag || 0) };
  }
}

// Return the armed reorg hash for a numbered block, or undefined if none.
export function hashOverride(state, blockNumber) {
  return state.reorgs[blockNumber] ?? state.reorgs[String(blockNumber)];
}

// Return the active transport-chaos descriptor if it applies to `scope`
// ("safe" | "finalized" | the method name), else null. A chaos scoped to
// "all" applies to everything.
export function chaosFor(state, scope) {
  const c = state.transportChaos;
  if (!c || c.kind === "NONE") return null;
  if (c.scope === "all" || c.scope === scope) return c;
  return null;
}

// ─── Preset patch builders ──────────────────────────────────────────────
// Each returns a patch object to POST to /admin (or pass to applyPatch).

// Freeze `finalized` at an absolute block number (test controls when
// finalized crosses block X).
export const pinFinalized = (n) => ({ finalized: { source: "pin", value: Number(n) } });

// Freeze `safe` at an absolute block number.
export const pinSafe = (n) => ({ safe: { source: "pin", value: Number(n) } });

// Arm a reorg: block `n` will return `hash` instead of its real hash.
export const armReorg = (n, hash) => ({ reorgs: { [Number(n)]: hash } });

// FCR preflight: `safe` tag returns JSON-RPC result: null (legit-empty →
// treated as None → finalized fallback).
export const safeNull = () => ({ safe: { source: "null" } });

// FCR preflight: `safe` tag returns JSON-RPC error -32602 (unsupported →
// fail loud, no silent downgrade).
export const safeUnsupported = () => ({ safe: { source: "unsupported" } });

// Full reset back to NORMAL/follow.
export const reset = () => initialState();
