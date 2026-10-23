#!/usr/bin/env bash
# Run one CI profile end to end against fresh Tenderly VNets:
#   setup (new VNets + random keys) → EL mock (finality profiles) → oracle
#   stack → wait until ready → tests.
# Always pair with ci/teardown.sh, which deletes the VNets and collects logs.
#
#   ci/run.sh plain          Layer A (normal bridging), validator direct to Tenderly
#   ci/run.sh ethfcr-gcbf    Layer A + Layer B, ETH=fcr  GC=block-finality
#   ci/run.sh ethbf-gcfcr    Layer A + Layer B, ETH=block-finality GC=fcr
#
# Env: TENDERLY_API_TOKEN, TENDERLY_ACCOUNT_ID, TENDERLY_PROJECT (required),
#      ORACLE_IMAGE (oracle image under test, default gnosischain/tokenbridge).
set -euo pipefail
cd "$(dirname "$0")/.."

profile="${1:-}"
AMB=src/setup/docker/docker-compose-amb.yml
XDAI=src/setup/docker/docker-compose-xdai.yml
mkdir -p logs

case "$profile" in
  plain)
    npm run setup
    use_mock=false
    suites=(test)
    ;;
  ethfcr-gcbf|ethbf-gcfcr)
    npm run "setup:profile:$profile"
    use_mock=true
    suites=(test "test:finality:$profile")
    ;;
  *)
    echo "Usage: $0 plain|ethfcr-gcbf|ethbf-gcfcr" >&2
    exit 2
    ;;
esac

if $use_mock; then
  echo "Starting EL mock..."
  nohup node src/mock/startMocks.js > logs/mock.log 2>&1 &
  echo $! > logs/mock.pid
fi

echo "Starting oracle stacks (image: ${ORACLE_IMAGE:-gnosischain/tokenbridge})..."
docker compose -f "$AMB" up -d --quiet-pull
docker compose -f "$XDAI" up -d --quiet-pull

ready_args=()
$use_mock && ready_args+=(--mock)
if ! node ci/waitReady.js "${ready_args[@]}"; then
  docker compose -f "$AMB" ps -a
  docker compose -f "$XDAI" ps -a
  exit 1
fi

SUITE_TITLE="$profile" node ci/runSuite.js "${suites[@]}"
