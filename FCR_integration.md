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
      + `block-finality/{stallsUntilFinalized,completesAfterFinalized}.js`
      (`npm run test:finality:ethfcr-gcbf:{stall,stall-complete}`).
      Target GC→ETH (source = GC = block-finality under P2/fb); completion asserted on-chain via the
      validator signature (`AMBBridgeHelper.getSignatures`). Negative-assertion window: 45s for bf-1,
      20s for bf-2 (configurable) — comfortably beats a normal ~15–30s relay, quick for CI. Both
      PASSED live under P2: validator withheld the signature while GC `finalized` was pinned below
      the deposit block, then signed once `evm_increaseBlocks` pushed finality past it.
- [x] **FCR observer + happy path (Layer B)** — Redis observer (`src/observer/`, ioredis) reading
      the validator's `pendingSafeBlocks` / `safeTxFalsePositives` state; `lib/fcrFlow.js` +
      `fcr/happyPath.js` (`npm run test:finality:ethfcr-gcbf:happy`). PASSED live under P2 (ETH=fcr): deposit
      seen `pending` at `safe`, then `confirmed` (pruned, no false positive) once finality crossed it.
- [x] **FCR preflight + reorg (Layer B)** — `fcr/{preflightSafeUnsupported,preflightSafeNull,
      reorgFalsePositive}.js` (the fcr half of `npm run test:finality:ethfcr-gcbf`). All PASSED live under P2: `safe`→-32602
      fails loud (probe retries, no silent downgrade); `safe`→null falls back to `finalized`; a reorg
      armed after the block is pending yields a recorded false positive (checker hash-mismatch).
- [x] **Full matrix (P2 + P3)** — Layer A 14/14 and the mode-specific Layer B suite PASS under both
      P2 (ETH=fcr, GC=block-finality) and P3 (ETH=block-finality, GC=fcr), covering all four
      `(chain, mode)` behavior pairs. P1/P4 (same-mode-both-chains) left as optional interaction-only
      runs. Recommended CI scope: P2 + P3.
- [ ] **Later** — second observer backend + wiring once the alternate validator's FCR support ships.

---

# Dev

Step-by-step commands for a full-coverage run (Layer A + Layer B, both modes on both chains)
against **either** validator. The test files are identical for both backends — which validator
they drive is pure infra, selected by env vars that the `:rust` npm scripts set for you.

## What "full coverage" means

Full coverage = the whole suite under **two profiles**:

| Profile        | ETH mode         | GC mode          | Covers                            |
| -------------- | ---------------- | ---------------- | --------------------------------- |
| `ethfcr-gcbf`  | `fcr`            | `block-finality` | ETH-as-fcr + GC-as-block-finality |
| `ethbf-gcfcr`  | `block-finality` | `fcr`            | GC-as-fcr + ETH-as-block-finality |

Together those four cells are every `(chain, mode)` behavior pair. `ethfcr-gcfcr` and `ethbf-gcbf`
are same-mode-on-both-chains and add interaction coverage only — optional, and they run with the
same commands (swap the `setup:profile:*` script; Layer B drivers pick their source chain by
profile, so under those two run whichever Layer B suite matches).

> **Legacy labels.** Older notes and commit messages call these profiles P1–P4:
> P1 = `ethfcr-gcfcr` (`ff`), P2 = `ethfcr-gcbf` (`fb`), P3 = `ethbf-gcfcr` (`bf`),
> P4 = `ethbf-gcbf` (`bb`). The scripts now spell the modes out, and the test aggregate always
> matches the setup script: `setup:profile:X` → `test:finality:X`.

Per profile:

- **Layer A** — `npm test` (14 tests: 4 xdai + 4 omni + 6 multicall). Backend-agnostic, all
  on-chain.
- **Layer B** — `npm run test:finality:<profile>` (the same name you passed to `setup:profile:`).
  The `:stall*` drivers assert on-chain; the fcr drivers read validator state, so they need the
  right observer backend.

## Prerequisites (once)

```bash
npm install
cp .env.example .env          # fill TENDERLY_API_TOKEN / ACCOUNT_ID / PROJECT
```

Only for the rust stack — the image is not buildable from this repo:

```bash
cd ../bridge-validator
docker build -f bridge_validator/Dockerfile -t bridge-validator:fcr .
cd -
```

## Step 1 — Setup the profile

One run writes env for **both** stacks (`.env.testnet`, `src/setup/docker/.env.oracle.{amb,xdai}`,
`src/setup/docker/.env.bridge.validator`), so the profile is chosen once regardless of which
validator you then start:

```bash
npm run setup:profile:ethfcr-gcbf      # ETH=fcr, GC=block-finality
```

This creates two **new** Tenderly VNs each time it runs. Everything downstream (mock, docker
stacks, persisted validator state) is now stale — steps 2 and 3 exist to deal with that.

## Step 2 — Start the EL mock

```bash
pkill -9 -f "src/mock/startMocks.js"   # a stale mock still holds :8545/:8546
npm run mock &                          # :8545 = ETH, :8546 = GC
```

**Restart the mock after every `setup:profile:*`** — it reads the upstream fork URLs from
`.env.testnet` at boot. `kill %1` does not reach a mock backgrounded from a different shell;
kill by pattern. Sanity check: the mock's `eth_blockNumber` must equal the tip of
`TENDERLY_ETHEREUM_RPC` read directly.

## Step 3 — Start ONE validator stack (cold)

Both stacks persist progress, and that state is keyed to the previous VNs' block heights. A stale
high-water mark above the new tip makes the validator report "all blocks already processed" and
never see a deposit — so start cold.

### Option A — Oracle (Node.js, Redis-backed)

```bash
cd src/setup/docker
docker compose -f docker-compose-amb.yml up -d --force-recreate
docker compose -f docker-compose-xdai.yml up -d --force-recreate

# Flush the persisted high-water mark WITHOUT racing the watchers — stop every
# watcher/sender first, flush, then start:
docker compose -f docker-compose-amb.yml stop \
  bridge_request_amb bridge_affirmation_amb bridge_senderhome_amb \
  bridge_senderforeign_amb bridge_shutdown_amb bridge_fcrvalidator_amb
docker exec docker-redis_amb-1 redis-cli FLUSHALL     # then DBSIZE must be 0
docker compose -f docker-compose-amb.yml start

# Same for the xdai stack (its redis is published on :6378):
docker compose -f docker-compose-xdai.yml stop \
  bridge_request_xdai bridge_affirmation_xdai bridge_senderhome_xdai \
  bridge_senderforeign_xdai bridge_shutdown_xdai bridge_fcrvalidator_xdai
docker exec docker-redis_xdai-1 redis-cli FLUSHALL
docker compose -f docker-compose-xdai.yml start
cd -
```

A plain `restart` is not enough: the old watcher rewrites its in-memory progress after the flush.
Confirm the watcher logs show `fromRedis:null` and a `headBlock` equal to the new tip.
`bridge_fcrvalidator_{amb,xdai}` is the fcrTxsChecker — the service the fcr happy-path and reorg
tests are actually asserting on; it must be up for those two.

Container names assume the default compose project name (`docker`, from the directory). Check with
`docker compose -f docker-compose-amb.yml ps` if `docker exec` says no such container.

### Option B — Rust bridge-validator (Postgres-backed)

```bash
docker compose -f src/setup/docker/docker-compose-rust.yml down -v   # -v drops the postgres volume
npm run setup:docker-rust
docker logs -f bridge-worker    # wait for it to index up to the new tip, then Ctrl-C
```

`down -v` is the cold start here — it discards `event_logs` rows carrying block numbers from the
previous VNs.

### Verify the observer can reach the validator's state store

```bash
npm run observer:check
```

This is the fastest way to catch a backend mismatch: an FCR test that dials Redis while only the
rust stack is up fails with `ECONNREFUSED`. It prints which store is reachable and the matching
scripts.

## Step 4 — Run the suite

### Oracle

```bash
# after `npm run setup:profile:ethfcr-gcbf`
npm test                             # Layer A — 14 tests
npm run test:finality:ethfcr-gcbf    # Layer B — gate ×2 + fcr ×4 (preflight ×2, happy, reorg)

# after re-running steps 1-3 with `npm run setup:profile:ethbf-gcfcr`
npm test
npm run test:finality:ethbf-gcfcr    # Layer B — fcr ×4 (GC source) + gate ×1 (ETH source)
```

### Rust bridge-validator

Same tests, `:rust` variants for the FCR ones:

```bash
# after `npm run setup:profile:ethfcr-gcbf`
npm test                                 # Layer A — unchanged, backend-agnostic
npm run test:finality:ethfcr-gcbf:rust   # same 6, with the 4 fcr ones on Postgres

# after `npm run setup:profile:ethbf-gcfcr`
npm test
npm run test:finality:ethbf-gcfcr:rust
```

The `:rust` scripts exist only to set infra env vars, never to change an assertion:

| Env var                       | Value for the rust stack                       | Used by                        |
| ----------------------------- | ---------------------------------------------- | ------------------------------ |
| `OBSERVER_BACKEND`            | `postgres`                                     | `src/observer/index.js`        |
| `FCR_COMPOSE`                 | `src/setup/docker/docker-compose-rust.yml`     | `lib/dockerControl.js`         |
| `FCR_SERVICE` / `FCR_CONTAINER` | `worker` / `bridge-worker`                   | `lib/preflightFlow.js`         |

Equivalent long form, if you want to run a single file directly:

```bash
OBSERVER_BACKEND=postgres node src/tests/finality/fcr/happyPath.js

FCR_COMPOSE=src/setup/docker/docker-compose-rust.yml \
FCR_SERVICE=worker FCR_CONTAINER=bridge-worker \
node src/tests/finality/fcr/preflightSafeUnsupported.js
```

> **Gotcha:** these must be real env vars on the command line. Putting `OBSERVER_BACKEND` in
> `.env` does **not** work — `src/observer/index.js` reads it at module-eval time, which happens
> before the test file's own `dotenv.config()` body runs. Same for `FCR_*`.

Individual Layer B tests, both backends. Prefix with `npm run`; `<p>` is the profile you set up
(`ethfcr-gcbf` or `ethbf-gcfcr`).

| Scenario                                 | Oracle                                    | Rust                                           |
| ---------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| fcr preflight, `safe` -32602             | `test:finality:<p>:preflight-unsupported` | `test:finality:<p>:preflight-unsupported:rust` |
| fcr preflight, `safe` null               | `test:finality:<p>:preflight-null`        | `test:finality:<p>:preflight-null:rust`        |
| fcr happy path                           | `test:finality:<p>:happy`                 | `test:finality:<p>:happy:rust`                 |
| fcr reorg → false positive               | `test:finality:<p>:reorg`                 | `test:finality:<p>:reorg:rust`                 |
| block-finality gate, negative only       | `test:finality:ethfcr-gcbf:stall`         | same (on-chain)                                |
| block-finality gate, negative + positive | `test:finality:<p>:stall-complete`        | same (on-chain)                                |
| everything for the profile               | `test:finality:<p>`                       | `test:finality:<p>:rust`                       |

`:stall` exists only under `ethfcr-gcbf` (GC source); `ethbf-gcfcr` folds both halves into its
`:stall-complete` (ETH source).

## Step 5 — Teardown

```bash
pkill -9 -f "src/mock/startMocks.js"
docker compose -f src/setup/docker/docker-compose-amb.yml down
docker compose -f src/setup/docker/docker-compose-xdai.yml down
docker compose -f src/setup/docker/docker-compose-rust.yml down -v
```

## Known per-backend status

- **Oracle** — Layer A 14/14 and the full Layer B suite pass under P2 and P3. Its `safe`-preflight
  reaches the same end state (demote to `block-finality`), but gets there differently from
  bridge-validator; the alignment gaps are tracked in `ORACLE_FCR_DOWNGRADE_TODO.md`.
- **Rust bridge-validator** — Layer A and the fcr **preflight** tests pass. The fcr **state** tests
  (`happy`, `reorg`) currently time out through no fault of the harness:
  `on_chain_sender.rs::delete_event_log` deletes the `event_logs` row on delivery, destroying the
  row carrying `fcr_status='pending'` before `fcr_checker` (polling on `finalized`) can resolve it.
  On a Tenderly VN `safe` == tip, so delivery always beats the checker's window. Needs a
  soft-delete, or deferred deletion until the checker resolves the row, on the validator side.

## Alternate wiring knobs

Rarely needed — the defaults cover both stacks as configured here.

| Env var                              | Default                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| `REDIS_URL_AMB` / `REDIS_URL_XDAI`   | `redis://localhost:6379` / `:6378`                                   |
| `POSTGRES_URL`                       | `postgresql://bridge:bridge_password@localhost:5432/bridge_validator` |
| `BRIDGE_VALIDATOR_IMAGE`             | `bridge-validator:fcr`                                               |
| `FCR_CHECK_INTERVAL_SECS`            | `10` in `.env.bridge.validator` (validator default 30s)              |
