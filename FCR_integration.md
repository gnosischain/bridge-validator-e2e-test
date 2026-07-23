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
- [~] **Setup profiles + Layer A** — per-chain mode flags and profile scripts; repoint the
  validator EL RPC at the mock. Smoke subset passes end-to-end; full suite run still pending.
- [ ] **Block-finality behavior (Layer B)** — stall-until-finalized and completes-after-finalized
      drivers; pick the bounded negative-assertion window.
- [ ] **FCR observer + happy path (Layer B)** — state observer; deposit → pending → confirmed.
- [ ] **FCR preflight + reorg (Layer B)** — `safe` unsupported / empty preflight cases; reorg →
      false positive.
- [ ] **Full matrix** — run Layer A across all profiles, Layer B where relevant; decide CI scope.
- [ ] **Later** — second observer backend + wiring once the alternate validator's FCR support ships.
