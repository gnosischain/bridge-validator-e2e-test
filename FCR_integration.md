# Block-Processing-Mode E2E Tests — Integration Overview

This document outlines the technical architecture for end-to-end testing of the bridge
validator's two **block-processing modes**(fcr and block-finality), and the scenarios those tests are intended to cover.

---

## 1. The two block-processing modes

The validator can process source-chain events at one of two block tags:

- **`block-finality`** — process events at the **`finalized`** block. A finalized block cannot
  reorg, so attesting to a finalized event is never wrong. The only observable behavior is
  **latency**: the validator must _wait_ for finality before attesting.

- **`fcr` (Fast Confirmation Rule)** — process events at the **`safe`** block (much faster than
  finality). A `safe` block can still be reorged out, and a signature can't be un-signed. So a
  revalidation step re-checks every safe-processed block once it finalizes and, on a block-hash
  mismatch, records a **false positive**.

Both modes read their block tag off the **execution-layer (EL) JSON-RPC**
(`eth_getBlockByNumber("safe" | "finalized", …)`) — there is **no beacon-chain dependency**.

Because mode is a per-chain axis and there are two chains (ETH and Gnosis), there are **four setup
profiles** (2×2), each assigning a mode to each chain. Two well-chosen profiles already exercise
every `(chain, mode)` behavior pair; the other two add same-mode-on-both-chains coverage.

---

## 2. Why a mock is needed

The tests run against forked networks (Tenderly Virtual TestNets) with real bridge transactions.
Forked networks handle transaction-level concerns well — transactions, `eth_call`, events,
receipts, gas — but they **cannot** advance finality on demand, produce reorgs, or let a test
control the `safe` / `finalized` pointers. Those are exactly the inputs both modes depend on.

The solution splits responsibilities:

| Concern                                             | Owner                                     |
| --------------------------------------------------- | ----------------------------------------- |
| transactions, `eth_call`, events, receipts, gas     | **Fork network** (proxied verbatim)       |
| `safe` / `finalized` pointers, block hashes, reorgs | **EL mock server** (synthesized)          |
| advancing the chain tip in bulk                     | **Fork admin RPC** (`evm_increaseBlocks`) |

The mock is a thin **EL JSON-RPC proxy**: it forwards every call to the real fork verbatim and
intercepts only `eth_getBlockByNumber` for the `safe` / `finalized` tags (and for reorged block
numbers, where it mutates the returned block hash). It never re-implements a node — real responses
pass through untouched, and only the one field under test is synthesized.

---

## 3. Architecture

Two layers of test, kept strictly separate:

- **Layer A — mode × basic scenario.** _Does normal bridging still complete under this mode?_
  Reuses the **existing** bridging test suite unchanged; the only difference is the setup profile
  (mock URL + per-chain mode written into the environment). No test files are duplicated.

- **Layer B — mode-specific behavior.** The logic that differs per mode. New, thin test drivers.

Supporting infrastructure:

- **EL mock proxy** — always in the RPC path for both chains under every profile. In its default
  (NORMAL) state it is a transparent passthrough, so Layer A passes untouched. Its state model is
  composable (`safe` / `finalized` pointers can _follow_ the tip or be _pinned_ to a fixed block;
  reorgs and transport faults can be armed) and is driven at runtime via a small admin endpoint.

- **Observer (FCR only)** — an FCR false positive is **never observable on-chain** (nothing is
  un-signed on a reorg). So FCR tests read validator state directly (via the validator's state
  store) to synchronize on and assert `pending` / `confirmed` / `false-positive`. Block-finality
  needs **no observer** — its behavior (stall, then complete) is asserted purely on-chain.

Proposed layout in this repo:

```
src/
  mock/        # EL JSON-RPC proxy + composable state (safe/finalized/reorgs/chaos)
  observer/    # reads validator state — FCR only (backend behind a stable interface)
  tests/
    xdai/ omni/ mixed/   # existing suite — reused as Layer A under each profile
    finality/            # Layer B — mode-specific behavior drivers
  utils/       # existing helpers reused unchanged
```

Setup (`setup.js`) gains per-chain mode flags. For any mode it repoints the validator's EL RPC at
the mock and sets the per-chain mode env var, while keeping the real fork URL for the mock to proxy
to.

---

## 4. Test scenarios

| Mode | Scenario                              | Assertion                                  | Observer      |
| ---- | ------------------------------------- | ------------------------------------------ | ------------- |
| fcr  | `safe` supported (startup preflight)  | preflight passes                           | —             |
| fcr  | `safe` unsupported                    | preflight fails loud (no silent downgrade) | —             |
| fcr  | `safe` legitimately empty             | treated as absent → finalized fallback     | —             |
| fcr  | happy path (hash matches at finality) | entry confirmed                            | yes           |
| fcr  | reorg → false positive                | false positive recorded + alerted          | yes           |
| bf   | source block not yet finalized        | bridge does **not** complete               | no (on-chain) |
| bf   | source block finalized                | bridge completes                           | no (on-chain) |
| both | normal bridging (Layer A)             | bridge completes as usual                  | no            |

**FCR flow** synchronizes on validator state rather than sleeping: deposit → wait for the entry to
appear as `pending` → advance finality (with or without an armed reorg) → assert `confirmed` or
`false positive`. Detection is post-hoc: the assertion is _"attestation happened AND a false
positive was recorded"_, not _"the transaction was blocked"_.

**Block-finality flow** pins `finalized` below the deposit block, asserts the bridge does not
complete within a bounded window, then advances finality past the block and asserts completion.

---

## 5. To-do

- [x] **Preconditions** — confirm both modes read the block tag off the EL RPC (no beacon
      dependency); confirm bulk block advancement works on the fork networks.
- [x] **EL mock proxy** — proxy + tag synthesis + reorg/pin/null/unsupported presets; prove
      transparent passthrough in NORMAL state.
- [x] **Setup profiles + Layer A** — per-chain mode flags and profile scripts; repoint the
  validator EL RPC at the mock. Full 14-test Layer A suite PASSES under both P2 and P3 (amb + xdai
  stacks through the mock). Fixed a pre-existing xdai-env blocker (stale `ORACLE_*_START_BLOCK`).
- [x] **Block-finality behavior (Layer B)** — `tests/finality/lib/{deposit,setMockState,bfFlow}.js`
      + `block-finality/{stallsUntilFinalized,completesAfterFinalized}.js` (`npm run test:finality:bf`).
      Target GC→ETH (source = GC = block-finality under P2/fb); completion asserted on-chain via the
      validator signature (`AMBBridgeHelper.getSignatures`). Negative-assertion window: 45s for bf-1,
      20s for bf-2 (configurable) — comfortably beats a normal ~15–30s relay, quick for CI. Both
      PASSED live under P2: validator withheld the signature while GC `finalized` was pinned below
      the deposit block, then signed once `evm_increaseBlocks` pushed finality past it.
- [x] **FCR observer + happy path (Layer B)** — Redis observer (`src/observer/`, ioredis) reading
      the validator's `pendingSafeBlocks` / `safeTxFalsePositives` state; `lib/fcrFlow.js` +
      `fcr/happyPath.js` (`npm run test:finality:fcr:happy`). PASSED live under P2 (ETH=fcr): deposit
      seen `pending` at `safe`, then `confirmed` (pruned, no false positive) once finality crossed it.
- [x] **FCR preflight + reorg (Layer B)** — `fcr/{preflightSafeUnsupported,preflightSafeNull,
      reorgFalsePositive}.js` (`npm run test:finality:fcr`). All PASSED live under P2: `safe`→-32602
      fails loud (probe retries, no silent downgrade); `safe`→null falls back to `finalized`; a reorg
      armed after the block is pending yields a recorded false positive (checker hash-mismatch).
- [x] **Full matrix (P2 + P3)** — Layer A 14/14 and the mode-specific Layer B suite PASS under both
      P2 (ETH=fcr, GC=block-finality) and P3 (ETH=block-finality, GC=fcr), covering all four
      `(chain, mode)` behavior pairs. P1/P4 (same-mode-both-chains) left as optional interaction-only
      runs. Recommended CI scope: P2 + P3.
- [ ] **Later** — second observer backend + wiring once the alternate validator's FCR support ships.
