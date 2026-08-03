// Minimal docker-compose control for the FCR preflight tests — those assert on
// a validator's STARTUP behavior, so a test must restart the watcher and read
// its logs. Coupled to the amb oracle stack by default; override per call.

import { execFile } from "child_process";
import { promisify } from "util";

const pexec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const AMB_COMPOSE = "src/setup/docker/docker-compose-amb.yml";
export const RUST_COMPOSE = "src/setup/docker/docker-compose-rust.yml";

// Which stack the preflight tests drive. Infra, not assertion: set
// FCR_COMPOSE=src/setup/docker/docker-compose-rust.yml for the rust validator.
const DEFAULT_COMPOSE = process.env.FCR_COMPOSE || AMB_COMPOSE;

// The new instance's `State.StartedAt`, in daemon time — the same clock that
// stamps log lines, so it is directly usable as a `docker logs --since` bound.
async function containerStartedAt(compose, service) {
  const { stdout: ids } = await pexec("docker", [
    "compose", "-f", compose, "ps", "-q", service,
  ]);
  const id = ids.trim().split("\n")[0];
  if (!id) {
    throw new Error(`No container found for service "${service}" in ${compose}`);
  }
  const { stdout } = await pexec("docker", [
    "inspect", "-f", "{{.State.StartedAt}}", id,
  ]);
  return stdout.trim();
}

// Restart a compose service (re-runs its startup / FCR preflight) and return
// { since } — the boot timestamp to scope log assertions to.
//
// stop→start rather than `restart`: the old instance keeps polling until it dies,
// and with the mock already poisoned it emits its own runtime-fallback lines. A
// bound taken around `restart` can therefore still admit them. Stopping first
// makes the old instance provably dead before the bound is read, so nothing it
// logged can satisfy an assertion about the boot under test.
export async function restartService(service, { compose = DEFAULT_COMPOSE } = {}) {
  const opts = { maxBuffer: 8 * 1024 * 1024 };
  await pexec("docker", ["compose", "-f", compose, "stop", service], opts);
  await pexec("docker", ["compose", "-f", compose, "start", service], opts);
  return { since: await containerStartedAt(compose, service) };
}

// Read a container's logs from `since` — either an RFC3339 timestamp
// (from restartService) or a docker relative duration like "150s".
// stdout + stderr are merged, since pino may write to either.
export async function readLogs(container, since) {
  const { stdout, stderr } = await pexec(
    "docker",
    ["logs", "--since", since, container],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return `${stdout}\n${stderr}`;
}

export const readLogsSince = (container, seconds) =>
  readLogs(container, `${seconds}s`);

// Poll a container's logs until a line matches `regex`, or throw.
//
// Pass `since` (from restartService) to scope the window to one boot. The
// `sinceSeconds` fallback is a fixed lookback that can match a line from an
// EARLIER boot — fine for a one-shot line, unsound for anything a validator
// also emits in steady state (e.g. "Last finalized block").
export async function waitForLog(
  container,
  regex,
  { timeoutMs = 90000, since, sinceSeconds = 150, intervalMs = 3000 } = {},
) {
  const window = since || `${sinceSeconds}s`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await readLogs(container, window);
    const hit = logs.split("\n").find((l) => regex.test(l));
    if (hit) return hit;
    await sleep(intervalMs);
  }
  throw new Error(
    `Timeout waiting for /${regex.source}/ in ${container} logs (since ${window})`,
  );
}
