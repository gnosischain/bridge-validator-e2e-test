# Bridge validator timing monitor

Measures how quickly each bridge validator implementation reacts to bridge
events on mainnet, without touching the real bridges.

Each validator is pointed at its own **contract K**
([`EventAccountingContract.sol`](./EventAccountingContract.sol)) on Gnosis Chain.
K accepts the same calls the real Home bridges accept, does nothing, and emits a
receipt. An indexer reconciles those receipts against the real
`UserRequestForAffirmation` / `UserRequestForSignature` events and reports how
long each one took.

```
Ethereum      UserRequestForAffirmation ─┐
Gnosis Chain  UserRequestForSignature  ──┤
                                         ├─> indexer ─> Redis ─> HTML
Gnosis Chain  contract K receipts      ──┘
```

## What counts as on time

| direction | source event | validator call | receipt | default limit |
|---|---|---|---|---|
| `eth->gc` | `UserRequestForAffirmation` (ETH) | `executeAffirmation` | `SignedForAffirmation` | 36 s (`ETH_MAX_DELAY_S`) |
| `gc->eth` | `UserRequestForSignature` (GC) | `submitSignature` | `SignedForSignature` | 300 s (`GC_MAX_DELAY_S`) |

The delay is `receipt block timestamp − source block timestamp`, so it includes
the validator's poll interval and Gnosis Chain inclusion time, not just its
decision latency.

A source event stays "awaiting verdict" until either a receipt appears or it is
older than `GRACE_S` (default 30 min), at which point it is counted **missed**.
Staleness is measured against the last indexed Gnosis Chain block, not the wall
clock — if the indexer falls behind, it reports nothing rather than a wave of
false misses.

## Contract K

Both bridges and both directions land on the Home (Gnosis Chain) side, so **one
contract K per validator** covers everything. It is stateless — every metric is
derived off-chain.

| call | selector | emits |
|---|---|---|
| `executeAffirmation(bytes)` | `0xe7a2c01f` | `SignedForAffirmation(0, messageId)` |
| `executeAffirmation(address,uint256,bytes32)` | `0x995b2cff` | `SignedForAffirmation(1, nonce)` |
| `submitSignature(bytes,bytes)` | `0x630cea8e` | `SignedForSignature(bridge, id)` |

All three selectors were verified against live validator transactions on the
real Home bridges.

`submitSignature` is shared by AMB and xDAI, so the bridge is inferred from the
message shape:

* xDAI — fixed length, `recipient(20) | value(32) | nonce(32) | foreignBridge(20) | token(20)`
  = 124 bytes (104 before the USDS upgrade, which appended `token`). The id is
  the nonce at offset 52.
* AMB — variable length, begins with a 32-byte `messageId` whose first two bytes
  are the AMB version `0x0005`. The id is that messageId.

The version prefix is checked as well as the length, so an AMB message that
happens to be 124 bytes is still classified as AMB.

> The AMB `messageId` and the xDAI `nonce` counters are independent per
> direction — nonce `0x1336` exists both `eth->gc` and `gc->eth`. Keys are
> namespaced by direction, so the two never collide.

### Deploy

```bash
cd contracts
forge test                       # 8 tests, run against captured mainnet payloads

forge create EventAccountingContract.sol:EventAccountingContract \
  --rpc-url "$GC_RPC" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --constructor-args <VALIDATOR_ADDRESS>
```

Deploy twice — once per validator address — then point each validator's Home
bridge config at its own K. K only accepts calls from the address passed to the
constructor.

## Metrics

`GET /api/metrics` returns everything the UI renders:

| metric | where |
|---|---|
| total events from ETH / from GC | `global.src.eth` / `global.src.gc` |
| total signed from ETH / from GC | `validators[].signed.eth` / `.gc` |
| processed on time (ETH & GC) | `validators[].ontime.*` |
| delayed (ETH & GC) | `validators[].delayed.*` |
| missed (ETH & GC) | `validators[].missed.*` |
| delayed / missed tx hashes | `validators[].delayedSamples`, `.missedSamples` |

Each is also broken down by bridge under `byBridge`. `unmatched` counts receipts
with no known source event — normally events that predate the start block.

### Redis layout

| key | type | purpose |
|---|---|---|
| `cursor:{eth,gc}` | string | next block to index |
| `head:{eth,gc}` | string | last indexed block + timestamp (the clock) |
| `src:{bridge}:{dir}:{id}` | string | source event, TTL `EVENT_TTL_S` |
| `sig:{validator}:{bridge}:{dir}:{id}` | string | contract K receipt |
| `pending:{validator}` | zset | open events, scored by source timestamp |
| `metrics:global`, `metrics:{validator}` | hash | counters (permanent) |
| `delayed:{validator}`, `missed:{validator}` | list | capped sample of tx hashes |

Writes use `SET NX`, so re-indexing a range never double-counts. Counters are
permanent; only the per-event records expire.

## Run it

```bash
cd contracts
cp .env.example .env      # fill in ETH_RPC, GC_RPC, VALIDATORS
docker compose up -d
open http://127.0.0.1:8080
```

Two containers: the indexer/UI (one Node process, `ioredis` its only dependency)
and Redis.

**RPCs** must tolerate `eth_getLogs` over a few thousand blocks — public
endpoints reject this. The load is small: a recent live backfill of 8 000 ETH
blocks and 15 000 GC blocks found 104 events and took 2.4 s.

**Start block.** By default indexing starts at the current head. Only set
`ETH_START_BLOCK` / `GC_START_BLOCK` for a window in which the validators were
already running — backfilling further back marks every event in it as missed,
because no receipts exist.

## DigitalOcean

A 1 GB / 1 vCPU droplet is enough; use 2 GB if you plan to backfill months.

**1. Create the droplet** — Ubuntu 24.04 LTS, SSH key auth, in a region close to
your RPC provider.

**2. Install Docker**

```bash
ssh root@<droplet-ip>
apt-get update && apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

**3. Deploy**

```bash
git clone <this-repo> /opt/bridge-monitor
cd /opt/bridge-monitor/contracts
cp .env.example .env && nano .env      # RPCs + the two contract K addresses
docker compose up -d
docker compose logs -f monitor
```

`restart: unless-stopped` plus Docker's own systemd unit brings both containers
back after a reboot. Redis runs with AOF on a named volume, so the block cursor
and any open events survive a restart — without that, a redeploy silently skips
every event in the gap.

**4. Firewall.** The UI is bound to `127.0.0.1:8080`, so it is not reachable from
the internet by default. Keep it that way and tunnel:

```bash
ufw allow OpenSSH && ufw enable
ssh -N -L 8080:127.0.0.1:8080 root@<droplet-ip>   # then open http://localhost:8080
```

To expose it instead, put Caddy in front — it handles TLS and basic auth in four
lines. Publish the port only through Caddy, never by changing the compose
binding to `0.0.0.0`.

```bash
apt-get install -y caddy
cat > /etc/caddy/Caddyfile <<'EOF'
monitor.example.com {
    basic_auth {
        admin <bcrypt-hash-from: caddy hash-password>
    }
    reverse_proxy 127.0.0.1:8080
}
EOF
systemctl reload caddy && ufw allow 80,443/tcp
```

**5. Health.** `GET /healthz` returns 503 when the last tick failed — point
DigitalOcean Monitoring or an uptime check at it.

## Layout

```
contracts/
  EventAccountingContract.sol     contract K
  foundry.toml
  test/
    EventAccountingContract.t.sol real captured payloads, no forge-std needed
    BridgeEventEmitter.sol        test-only source-event emitter
  monitor/
    src/config.js                 addresses, topics, thresholds
    src/rpc.js                    JSON-RPC + range splitting
    src/indexer.js                logs -> Redis
    src/reconcile.js              matching, classification, counters
    src/snapshot.js               counters -> UI payload
    src/index.js                  tick loop + HTTP server
    public/index.html             the UI
  docker-compose.yml
```
