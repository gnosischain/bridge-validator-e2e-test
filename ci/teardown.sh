#!/usr/bin/env bash
# Clean up after ci/run.sh, whatever state it stopped in: save container logs to
# logs/, stop the mock and the stacks, and delete the Tenderly VNets.
# Safe to run more than once.
set -uo pipefail
cd "$(dirname "$0")/.."

mkdir -p logs
for stack in amb xdai rust; do
  compose="src/setup/docker/docker-compose-$stack.yml"
  if [ -n "$(docker compose -f "$compose" ps -aq 2>/dev/null)" ]; then
    docker compose -f "$compose" logs --no-color --timestamps > "logs/$stack.log" 2>&1
    docker compose -f "$compose" down -v --timeout 10
  fi
done

if [ -f logs/mock.pid ]; then
  kill "$(cat logs/mock.pid)" 2>/dev/null || true
  rm -f logs/mock.pid
fi

node src/setup/teardown.js
