# Gnosis Chain Bridge E2E Tests

End-to-end tests for the Gnosis Chain canonical bridges (xDAI Bridge & Omnibridge) running on
Tenderly Virtual TestNets.

This repo is a **test harness only** — nothing under test lives here. The system under test is one
of two external validator implementations, shipped as Docker images:

| Implementation                        | Compose file                                         | FCR state store                   | Read by                    |
| ------------------------------------- | ---------------------------------------------------- | --------------------------------- | -------------------------- |
| Node.js oracle (`tokenbridge-oracle`) | `docker-compose-amb.yml` + `docker-compose-xdai.yml` | Redis (`:6379` amb, `:6378` xdai) | `src/observer/redis.js`    |
| Rust `bridge-validator`               | `docker-compose-rust.yml`                            | Postgres (`:5432`)                | `src/observer/postgres.js` |

The chains are Tenderly Virtual TestNets — forks of Ethereum mainnet and Gnosis Chain, created
fresh by every setup run.

---

## Architecture

```mermaid
graph LR
  subgraph host["Host (your machine)"]
    T["Test scripts<br/>src/tests/**"]
    M["EL mock proxy<br/>:8545 ETH · :8546 GC"]
    O["observer lib<br/>(imported, not a process)"]
  end
  subgraph docker["Docker"]
    V["Validator stack<br/>oracle OR rust"]
    S[("state store<br/>Redis / Postgres")]
  end
  subgraph tenderly["Tenderly VNets"]
    E["ETH fork"]
    G["GC fork"]
  end

  T -->|"tx + balance reads<br/>(direct, real view)"| E
  T --> G
  T -->|"POST /admin<br/>lie about safe/finalized"| M
  T -->|"evm_increaseBlocks<br/>(Admin RPC)"| E
  T -->|"docker restart + logs"| V
  M -->|proxy| E
  M -->|proxy| G
  V -->|"all EL reads"| M
  V --> S
  O -->|read| S
  T --> O
```

**The key idea:** the tests see the _real_ chain (they talk to Tenderly directly), while the
validator sees a _manipulated_ view (through the mock). That asymmetry is what makes finality
behavior testable — the test knows the deposit landed at block X while the validator has been told
`finalized` is still below X.

### Components

| Component       | Path                           | What it is                                                                                        |
| --------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Setup           | `src/setup/setup.js`           | Creates the two VNets, funds Alice + validator, registers the validator, writes every `.env` file |
| Docker composes | `src/setup/docker/`            | The validator stacks (oracle amb + xdai, or rust)                                                 |
| EL mock         | `src/mock/`                    | JSON-RPC proxy with a control plane that can lie about `safe` / `finalized` / block hashes        |
| Observer        | `src/observer/`                | **A client library, not a process.** FCR tests import it to read the validator's own state store  |
| Layer A tests   | `src/tests/{xdai,omni,mixed}/` | Normal bridging — the pre-existing suite                                                          |
| Layer B tests   | `src/tests/finality/`          | Block-processing-mode behavior (block-finality gate, FCR lifecycle, FCR startup preflight)        |
| Shared utils    | `src/utils/`                   | viem clients, signature collection / claim helpers, `assert`, multicall builders                  |

### The mock is not a "mode" — it's four independent knobs

`src/mock/state.js`; drive it with `POST /admin`, inspect with `GET /admin/state`.

| Knob             | Values                                                   | Used by                 |
| ---------------- | -------------------------------------------------------- | ----------------------- |
| `finalized`      | `follow` (tip − lag) \| `pin(N)`                         | block-finality tests    |
| `safe`           | `follow` \| `pin(N)` \| `null` \| `unsupported` (-32602) | FCR preflight tests     |
| `reorgs`         | `{ blockNumber: fakeHash }`                              | FCR false-positive test |
| `transportChaos` | `NONE \| ERROR_500 \| MALFORMED \| JSONRPC_ERROR`        | defined, not yet used   |

Default state = both pointers follow the tip, no reorgs, no chaos → **transparent passthrough**,
which is why the whole Layer A suite passes through the mock unchanged.

### Two test layers

|                   | Layer A                            | Layer B                                                                   |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| Location          | `src/tests/{xdai,omni,mixed}/`     | `src/tests/finality/`                                                     |
| Question          | "does normal bridging still work?" | "does the mode-specific logic behave correctly?"                          |
| Assertion surface | on-chain balances + events         | on-chain (bf), validator state store (fcr), or container logs (preflight) |
| Count             | 14 (4 xdai + 4 omni + 6 multicall) | 5 scenarios × 2 source-chain directions                                   |
| Backend-aware?    | No — identical for oracle and rust | fcr tests are; the `:rust` scripts flip env vars only                     |

Layer B is thin drivers over three primitives in `src/tests/finality/lib/`:

- **`bfFlow.js`** — pin `finalized` → deposit → assert **NOT** complete for a window → advance
  finality → assert complete.
- **`fcrFlow.js`** — pin `finalized` while `safe` follows the tip → deposit → wait for `pending(X)`
  in the store → (optionally arm a reorg) → advance finality → wait for `confirmed(X)` or
  `falsePositive(X)`.
- **`preflightFlow.js`** — set `safe` → `null`/`unsupported` → `docker compose restart <watcher>` →
  grep its logs → restore `safe` → follow and restart.

---

## Which path do I run?

```mermaid
flowchart TD
  A["Which validator?"] -->|oracle| B["Which layer?"]
  A -->|rust| B
  B -->|"Layer A only,<br/>no finality logic"| L1["npm run setup<br/>(or setup:autoclaim)<br/>NO mock needed"]
  B -->|"anything finality-related<br/>(or Layer A under a mode)"| L2["npm run setup:profile:ethfcr-gcbf<br/>(or :ethbf-gcfcr)"]

  L1 --> D["start ONE validator stack"]
  L2 --> C["npm run mock  ← mandatory"] --> D

  D --> E["cold-start hygiene:<br/>flush Redis / down -v Postgres"]
  E --> F{"what to test?"}
  F -->|"normal bridging"| G["npm test"]
  F -->|"everything for the profile"| P["test:finality:&lt;profile&gt;<br/>(+ :rust)"]
  F -->|"block-finality gate"| H["…:stall / …:stall-complete"]
  F -->|"fcr startup probe"| I["…:preflight-unsupported / …:preflight-null"]
  F -->|"fcr pending/confirmed"| J["npm run observer:check → then<br/>…:happy / …:reorg"]
```

**Script naming:** `test:finality:<profile>[:<scenario>][:rust]`, where `<profile>` is exactly the
name you passed to `setup:profile:`. So the pairing rule is: **whatever you ran as
`setup:profile:X`, run `test:finality:X`.**

Note:

- **`npm run setup` (no flags) ≠ `setup:profile:*`.** No-flag setup wires the validators **direct
  to Tenderly** — no mock, no `*_BLOCK_PROCESSING_MODE`. Profile setup inserts the mock in front of
  them. Same test files, different wiring.
- **The mock is not "only for finality tests."** It is required for _any_ run that used
  `setup:profile:*`, including plain Layer A — setup repoints the validators at
  `host.docker.internal:8545/8546`, so without the mock they have no RPC at all.

And one FAQ: **you never start the observer.** `src/observer/` is a library the FCR tests import;
`npm run observer:check` is only a connectivity doctor.

---

## Prerequisites

- Node.js
- Docker & Docker Compose
- A [Tenderly](https://tenderly.co/) account with API access
- A local Docker image for the validator you want to test (`bridge-validator:fcr` for the rust
  stack, overridable via `BRIDGE_VALIDATOR_IMAGE`)

Once, before anything else:

```bash
cp .env.example .env      # then fill in:
#   TENDERLY_API_TOKEN=<your-tenderly-api-token>
#   TENDERLY_ACCOUNT_ID=<your-tenderly-account-id>
#   TENDERLY_PROJECT=<your-tenderly-project-name>
npm install
```

---

# Path 1 — Layer A only (normal bridging, no mock)

## Step 1: Setup

Creates the VNets, generates and funds accounts, registers the bridge validator with
`requiredSignatures = 1`, and writes every env file.

```bash
npm run setup            # manual claim on the destination chain
npm run setup:autoclaim  # validator executes the claim on the user's behalf
```

Generates:

- `.env.testnet` — RPC URLs and private keys for the test scripts
- `src/setup/docker/.env.oracle.xdai` — xDAI oracle config
- `src/setup/docker/.env.oracle.amb` — AMB oracle config
- `src/setup/docker/.env.bridge.validator` — rust validator config

## Step 2: Start ONE validator stack

```bash
cd src/setup/docker

# Option A — Node.js oracle (RabbitMQ + Redis + watcher/sender services per bridge)
docker compose -f docker-compose-xdai.yml up -d
docker compose -f docker-compose-amb.yml up -d

# Option B — Rust validator (Postgres + worker)
docker compose -f docker-compose-rust.yml up -d

docker compose -f docker-compose-amb.yml ps   # verify
cd ../../..
```

## Step 3: Run the tests

```bash
npm test                     # all 14: xdai + omni + multicall
npm run test:autoclaim       # the same, autoclaim variants where applicable

npm run test:xdai            # 4 xDAI bridge tests
npm run test:omni            # 4 Omnibridge tests
npm run test:multicall       # 6 batched/multicall tests
```

**xDAI Bridge:**

| Command                          | Direction                              |
| -------------------------------- | -------------------------------------- |
| `npm run test:xdai:usds-to-gc`   | USDS (Ethereum) -> xDAI (Gnosis Chain) |
| `npm run test:xdai:dai-to-gc`    | DAI (Ethereum) -> xDAI (Gnosis Chain)  |
| `npm run test:xdai:xdai-to-usds` | xDAI (Gnosis Chain) -> USDS (Ethereum) |
| `npm run test:xdai:xdai-to-dai`  | xDAI (Gnosis Chain) -> DAI (Ethereum)  |

**Omnibridge:**

| Command                           | Direction                              |
| --------------------------------- | -------------------------------------- |
| `npm run test:omni:eth-to-weth`   | ETH (Ethereum) -> WETH (Gnosis Chain)  |
| `npm run test:omni:weth-to-eth`   | WETH (Gnosis Chain) -> WETH (Ethereum) |
| `npm run test:omni:gno-eth-to-gc` | GNO (Ethereum) -> GNO (Gnosis Chain)   |
| `npm run test:omni:gno-gc-to-eth` | GNO (Gnosis Chain) -> GNO (Ethereum)   |

**Omnibridge implementation upgrade** — flip both mediator proxies to the new implementations and
re-verify the WETH GC→ETH claim paths. Neither script needs a validator container; see
[`src/tests/omni/upgrade/README.md`](src/tests/omni/upgrade/README.md).

| Command                              | What it does                                                        |
| ------------------------------------ | ------------------------------------------------------------------- |
| `npm run upgrade:omnibridge`         | `upgradeTo` on the Foreign + Home proxies, asserts storage preserved |
| `npm run test:omni:upgrade:weth-eth` | WETH (GC) → ETH across every `ForeignAMB` relay path                |

**Multicall / batched:**

| Command                                  | What it batches                           |
| ---------------------------------------- | ----------------------------------------- |
| `npm run test:multicall:usds-to-gc`      | USDS -> xDAI, batched                     |
| `npm run test:multicall:xdai-to-usds`    | xDAI -> USDS, batched                     |
| `npm run test:multicall:gno-eth-to-gc`   | GNO ETH -> GC, batched                    |
| `npm run test:multicall:gno-gc-to-eth`   | GNO GC -> ETH, batched                    |
| `npm run test:multicall:mixed-eth-to-gc` | xDAI + Omnibridge in one batch, ETH -> GC |
| `npm run test:multicall:mixed-gc-to-eth` | xDAI + Omnibridge in one batch, GC -> ETH |

**With autoclaim** — append `:autoclaim`. Only the GC→Ethereum directions have a variant (that's
the claim side), and it requires `npm run setup:autoclaim`:

```bash
npm run test:xdai:xdai-to-usds:autoclaim
npm run test:xdai:xdai-to-dai:autoclaim
npm run test:omni:weth-to-eth:autoclaim
npm run test:omni:gno-gc-to-eth:autoclaim
npm run test:multicall:xdai-to-usds:autoclaim
npm run test:multicall:gno-gc-to-eth:autoclaim
npm run test:multicall:mixed-gc-to-eth:autoclaim
```

- **Manual claim (default):** the test bridges from the source chain, collects validator
  signatures, and executes the claim on the destination chain itself.
- **Autoclaim:** the validator executes the claim. The destination balance increase alone proves it.

---

# Path 2 — Block-processing modes (finality testing)

The mode is **per chain**, so a "profile" is a pair. One setup run writes env for _both_ validator
stacks, so pick the profile once regardless of which validator you then start.

| Profile        | ETH              | GC               | Covers                            | Has Layer B tests |
| -------------- | ---------------- | ---------------- | --------------------------------- | ----------------- |
| `ethfcr-gcbf`  | `fcr`            | `block-finality` | ETH-as-fcr + GC-as-block-finality | yes — 6 tests     |
| `ethbf-gcfcr`  | `block-finality` | `fcr`            | GC-as-fcr + ETH-as-block-finality | yes — 5 tests     |
| `ethfcr-gcfcr` | `fcr`            | `fcr`            | both-fcr interaction only         | no                |
| `ethbf-gcbf`   | `block-finality` | `block-finality` | both-bf interaction only          | no                |

```bash
npm run setup:profile:ethfcr-gcbf   # then: npm run test:finality:ethfcr-gcbf
npm run setup:profile:ethbf-gcfcr   # then: npm run test:finality:ethbf-gcfcr
```

**`ethfcr-gcbf` + `ethbf-gcfcr` together cover all four `(chain, mode)` pairs** — that is the
recommended CI scope. The two same-mode profiles add only interaction coverage and have no Layer B
suite of their own; run Layer A (`npm test`) under them.

The two Layer B suites are mirror images:

| Suite                       | Contents                                                  | fcr source | block-finality source |
| --------------------------- | --------------------------------------------------------- | ---------- | --------------------- |
| `test:finality:ethfcr-gcbf` | `stall`, `stall-complete`, preflight ×2, `happy`, `reorg` | ETH → GC   | GC → ETH              |
| `test:finality:ethbf-gcfcr` | preflight ×2, `happy`, `reorg`, `stall-complete`          | GC → ETH   | ETH → GC              |

`ethfcr-gcbf` has one extra test because it splits the block-finality gate across `stall`
(negative only) and `stall-complete` (negative + positive); `ethbf-gcfcr` folds both into a single
`stall-complete`.

## Step 1: Setup the profile

```bash
npm run setup:profile:ethfcr-gcbf      # ETH=fcr, GC=block-finality
```

This creates two **new** VNets every time it runs. Everything downstream (mock, docker stacks,
persisted validator state) is now stale — steps 2 and 3 exist to deal with that.

## Step 2: Start the EL mock — mandatory

```bash
pkill -9 -f "src/mock/startMocks.js"   # a stale mock still holds :8545/:8546
npm run mock &                         # :8545 = ETH (foreign), :8546 = GC (home)
```

Restart the mock after **every** `setup:profile:*` — it reads the upstream fork URLs from
`.env.testnet` at boot. `kill %1` does not reach a mock backgrounded from another shell; kill by
pattern. Sanity check: the mock's `eth_blockNumber` must equal the tip of `TENDERLY_ETHEREUM_RPC`
read directly.

## Step 3: Start ONE validator stack — cold

### Option A — Oracle (Redis-backed)

```bash
cd src/setup/docker
docker compose -f docker-compose-amb.yml up -d --force-recreate
docker compose -f docker-compose-xdai.yml up -d --force-recreate

# Flush the high-water mark WITHOUT racing the watchers: stop, flush, start.
# A plain `restart` is not enough — the old watcher rewrites its in-memory progress after the flush.
docker compose -f docker-compose-amb.yml stop \
  bridge_request_amb bridge_affirmation_amb bridge_senderhome_amb \
  bridge_senderforeign_amb bridge_shutdown_amb bridge_fcrvalidator_amb
docker exec docker-redis_amb-1 redis-cli FLUSHALL     # then DBSIZE must be 0
docker compose -f docker-compose-amb.yml start

# Same for the xdai stack (its redis is published on :6378)
docker compose -f docker-compose-xdai.yml stop \
  bridge_request_xdai bridge_affirmation_xdai bridge_senderhome_xdai \
  bridge_senderforeign_xdai bridge_shutdown_xdai bridge_fcrvalidator_xdai
docker exec docker-redis_xdai-1 redis-cli FLUSHALL
docker compose -f docker-compose-xdai.yml start
```

Confirm the watcher logs show `fromRedis:null` and a `headBlock` equal to the new tip.
`bridge_fcrvalidator_{amb,xdai}` is the fcrTxsChecker — the service the fcr happy-path and reorg
tests actually assert on; it must be up for those two.

Container names assume the default compose project name (`docker`, from the directory). Check with
`docker compose -f docker-compose-amb.yml ps` if `docker exec` says no such container.

### Option B — Rust bridge-validator (Postgres-backed)

```bash
docker compose -f src/setup/docker/docker-compose-rust.yml down -v   # -v drops the postgres volume
npm run setup:docker-rust
docker logs -f bridge-worker    # wait until it has indexed up to the new tip, then Ctrl-C
```

`down -v` is the cold start here — it discards `event_logs` rows carrying block numbers from the
previous VNets.

### Verify the observer can reach the state store

```bash
npm run observer:check
```

Fastest way to catch a backend mismatch: an FCR test that dials Redis while only the rust stack is
up fails with `ECONNREFUSED`. It prints which store is reachable and the matching scripts.

## Step 4: Run the suite

### Oracle

```bash
# after npm run setup:profile:ethfcr-gcbf
npm test                             # Layer A — 14 tests
npm run test:finality:ethfcr-gcbf    # Layer B — gate ×2 + fcr ×4 (preflight ×2, happy, reorg)

# after re-running steps 1-3 with npm run setup:profile:ethbf-gcfcr
npm test
npm run test:finality:ethbf-gcfcr    # Layer B — fcr ×4 (GC source) + gate ×1 (ETH source)
```

### Rust bridge-validator

Same tests, `:rust` variants for the FCR ones:

```bash
# after npm run setup:profile:ethfcr-gcbf
npm test                                 # Layer A — unchanged, backend-agnostic
npm run test:finality:ethfcr-gcbf:rust   # same 6, with the 4 fcr ones on Postgres

# after npm run setup:profile:ethbf-gcfcr
npm test
npm run test:finality:ethbf-gcfcr:rust
```

The `:stall` / `:stall-complete` tests are identical in both aggregates — they assert on-chain, so
there is no backend-specific variant of them.

The `:rust` scripts exist only to set infra env vars, never to change an assertion:

| Env var                         | Value for the rust stack                   | Read by                 |
| ------------------------------- | ------------------------------------------ | ----------------------- |
| `OBSERVER_BACKEND`              | `postgres`                                 | `src/observer/index.js` |
| `FCR_COMPOSE`                   | `src/setup/docker/docker-compose-rust.yml` | `lib/dockerControl.js`  |
| `FCR_SERVICE` / `FCR_CONTAINER` | `worker` / `bridge-worker`                 | `lib/preflightFlow.js`  |

> **Gotcha:** these must be real env vars on the command line. Putting `OBSERVER_BACKEND` in `.env`
> does **not** work — `src/observer/index.js` reads it at module-eval time, which happens before
> the test file's own `dotenv.config()` runs. Same for `FCR_*`.

Long form, to run a single file directly:

```bash
OBSERVER_BACKEND=postgres node src/tests/finality/fcr/happyPath.js

FCR_COMPOSE=src/setup/docker/docker-compose-rust.yml \
FCR_SERVICE=worker FCR_CONTAINER=bridge-worker \
node src/tests/finality/fcr/preflightSafeUnsupported.js
```

### Individual Layer B tests, both backends

Prefix every command with `npm run`. `<p>` is the profile you set up.

| Scenario                                 | Oracle                                    | Rust                                           |
| ---------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| fcr preflight, `safe` -32602             | `test:finality:<p>:preflight-unsupported` | `test:finality:<p>:preflight-unsupported:rust` |
| fcr preflight, `safe` null               | `test:finality:<p>:preflight-null`        | `test:finality:<p>:preflight-null:rust`        |
| fcr happy path                           | `test:finality:<p>:happy`                 | `test:finality:<p>:happy:rust`                 |
| fcr reorg → false positive               | `test:finality:<p>:reorg`                 | `test:finality:<p>:reorg:rust`                 |
| block-finality gate, negative only       | `test:finality:ethfcr-gcbf:stall`         | same (on-chain)                                |
| block-finality gate, negative + positive | `test:finality:<p>:stall-complete`        | same (on-chain)                                |
| everything for the profile               | `test:finality:<p>`                       | `test:finality:<p>:rust`                       |

`:stall` exists only under `ethfcr-gcbf`; `ethbf-gcfcr` covers both halves in its
`:stall-complete`.

---

## Pass conditions

**Layer A** (e.g. `src/tests/xdai/bridgeXdaiToUsds.js`) — four gates, all via `assert()` in
`src/utils/validator.js`:

1. relay tx `status === "success"` and logs emitted;
2. source balance decreased;
3. _(manual mode only)_ validator signature collectible from the home bridge →
   `claimOnForeignBridge` succeeds;
4. destination balance increased, polled 5 × 12s.

In autoclaim mode step 3 is skipped and step 4 alone proves the validator executed the claim.

**block-finality gate** (`:stall`, `:stall-complete`) — one negative plus one positive:

- _stall_: with `finalized` pinned below deposit block X, `isComplete()` must stay false for the
  whole window (45s in `:stall`, 20s in `:stall-complete`, which only needs to confirm the gate was
  shut before proving it opens). Flipping true early = FAIL.
- _complete_: after `evm_increaseBlocks` pushes the tip past X and `finalized` follows again,
  `isComplete()` must become true within 180s.

`isComplete` is `isMessageSigned(...)` for GC→ETH, and a GC balance increase for ETH→GC.

**FCR happy path (Condition 3)** — read from the validator's own state store:

- `pending(chain, X)` appears within 90s, with a stored `pendingHash`;
- no `falsePositive` recorded while pending;
- after finality crosses X: `confirmed(chain, X, hash)` within 120s (row pruned), still no false
  positive.

**FCR reorg (Condition 4)** — same up to `pending`, then arm `reorgs[X] = 0xdeadbeef…` _after_ the
real hash is stored. When finality crosses X the checker must record
`falsePositive(chain, X, realHash)` within 120s. Detector-only — nothing is undone on-chain, so do
not look for a reverted transfer.

**FCR preflight, `safe` → -32602 (Conditions 1–2)** — three log lines from the restarted watcher,
each within 90s: (1) the rejection is alerted loudly, (2) an explicit **downgrade to
block-finality**, (3) it is still indexing, on `finalized`. The point: no crash, and no silent
`fcr` that is really running on finality.

**FCR preflight, `safe` → null** — must take the _other_ branch: a null / "no safe block yet" line,
then still processing on `finalized`, with no permanent downgrade.

Both preflight tests restore `safe → follow` and restart the service in a `finally`, so they leave
the stack healthy even when they fail.

---

## Teardown

```bash
pkill -9 -f "src/mock/startMocks.js"
docker compose -f src/setup/docker/docker-compose-amb.yml down
docker compose -f src/setup/docker/docker-compose-xdai.yml down
docker compose -f src/setup/docker/docker-compose-rust.yml down -v
```

---

## Known-red — don't debug the harness for these

- **Rust + FCR state tests (`happy`, `reorg`) time out.** Not a harness bug:
  `on_chain_sender.rs::delete_event_log` deletes the `event_logs` row on delivery, destroying the
  row carrying `fcr_status='pending'` before `fcr_checker` (polling on `finalized`) can resolve it.
  On a Tenderly VNet `safe == tip`, so delivery always beats the checker's window. Needs a
  soft-delete, or deferred deletion, on the validator side. Rust preflight and Layer A do pass.
- **Compose `environment:` blocks with `${VAR}`** clobber `env_file` values with empty strings if
  the var is unset in your shell — a known footgun in the oracle composes.

## Alternate wiring knobs

Rarely needed — the defaults cover both stacks as configured here.

| Env var                            | Default                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| `REDIS_URL_AMB` / `REDIS_URL_XDAI` | `redis://localhost:6379` / `:6378`                                    |
| `POSTGRES_URL`                     | `postgresql://bridge:bridge_password@localhost:5432/bridge_validator` |
| `MOCK_ETH_URL` / `MOCK_GC_URL`     | `http://localhost:8545` / `:8546` (host side)                         |
| `MOCK_ETH_PORT` / `MOCK_GC_PORT`   | `8545` / `8546`                                                       |
| `BRIDGE_VALIDATOR_IMAGE`           | `bridge-validator:fcr`                                                |
| `FCR_CHECK_INTERVAL_SECS`          | `10` in `.env.bridge.validator` (validator default 30s)               |
