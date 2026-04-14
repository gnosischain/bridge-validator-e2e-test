# Gnosis Chain Bridge E2E Tests

End-to-end tests for Gnosis Chain canonical bridges infrastructure (xDAI Bridge & Omnibridge) running on Tenderly Virtual TestNets.

## Prerequisites

- Node.js
- Docker & Docker Compose
- A [Tenderly](https://tenderly.co/) account with API access
- Docker image for bridge validator

## Step 1: Configure Tenderly Credentials

Copy the example env file and fill in your Tenderly credentials:

```bash
cp .env.example .env
```

Edit `.env` and set:

```
TENDERLY_API_TOKEN=<your-tenderly-api-token>
TENDERLY_ACCOUNT_ID=<your-tenderly-account-id>
TENDERLY_PROJECT=<your-tenderly-project-name>
```

## Step 2: Install Dependencies

```bash
npm install
```

## Step 3: Run Setup

The setup script creates Tenderly Virtual TestNets (Ethereum + Gnosis Chain forks), generates test accounts, funds them, registers a bridge validator, and writes all the required `.env` files for Docker.

**Standard mode** (manual claim on destination chain):

```bash
npm run setup
```

**Autoclaim mode** (validator automatically claims tokens on behalf of the user):

```bash
npm run setup:autoclaim
```

This generates:

- `.env.testnet` - RPC URLs and private keys for test scripts
- `src/setup/docker/.env.oracle.xdai` - xDAI oracle config
- `src/setup/docker/.env.oracle.amb` - AMB oracle config
- `src/setup/docker/.env.bridge.validator` - Rust validator config

## Step 4: Start Bridge Validators

Navigate to the Docker directory:

```bash
cd src/setup/docker
```

### Option A: Node.js Oracle (tokenbridge-oracle)

Start both the xDAI and AMB oracle validators:

```bash
docker compose -f docker-compose-xdai.yml up -d
docker compose -f docker-compose-amb.yml up -d
```

This starts RabbitMQ, Redis, and oracle watcher/sender services for each bridge.

### Option B: Rust Validator

```bash
docker compose -f docker-compose-rust.yml up -d
```

This starts PostgreSQL and the Rust bridge validator worker.

### Verify validators are running

```bash
docker compose -f docker-compose-xdai.yml ps
docker compose -f docker-compose-amb.yml ps
# or
docker compose -f docker-compose-rust.yml ps
```

## Step 5: Run Tests

Go back to the project root:

```bash
cd ../../..
```

### Run all tests

```bash
npm test                     # all xDAI + Omnibridge tests
npm run test:autoclaim       # all tests with autoclaim enabled
```

### Run by bridge type

```bash
npm run test:xdai            # all xDAI bridge tests
npm run test:omni            # all Omnibridge tests
```

### Run individual tests

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

**With autoclaim** (append `:autoclaim` to GC-to-Ethereum tests):

```bash
npm run test:xdai:xdai-to-usds:autoclaim
npm run test:xdai:xdai-to-dai:autoclaim
npm run test:omni:weth-to-eth:autoclaim
npm run test:omni:gno-gc-to-eth:autoclaim
```

## Cleanup

Stop the validators when done:

```bash
cd src/setup/docker
docker compose -f docker-compose-xdai.yml down
docker compose -f docker-compose-amb.yml down
# or
docker compose -f docker-compose-rust.yml down
```

## Modes: Manual Claim vs Autoclaim

- **Manual claim (default):** Tests bridge the tokens from the source chain, collect validator signatures, and manually execute the claim transaction on the destination chain.
- **Autoclaim:** The bridge validator automatically executes the claim on the destination chain on behalf of the user. Use `npm run setup:autoclaim` and the `:autoclaim` test variants.
