// Minimal docker-compose control for the FCR preflight tests — those assert on
// a validator's STARTUP behavior, so a test must restart the watcher and read
// its logs. Coupled to the amb oracle stack by default; override per call.

import { execFile } from "child_process";
import { promisify } from "util";

const pexec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const AMB_COMPOSE = "src/setup/docker/docker-compose-amb.yml";

// Restart a compose service (re-runs its startup / FCR preflight).
export async function restartService(service, { compose = AMB_COMPOSE } = {}) {
  await pexec("docker", ["compose", "-f", compose, "restart", service], {
    maxBuffer: 8 * 1024 * 1024,
  });
}

// Read the last `seconds` of a container's logs (stdout + stderr merged, since
// pino may write to either).
export async function readLogsSince(container, seconds) {
  const { stdout, stderr } = await pexec(
    "docker",
    ["logs", "--since", `${seconds}s`, container],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return `${stdout}\n${stderr}`;
}

// Poll a container's recent logs until a line matches `regex`, or throw.
export async function waitForLog(
  container,
  regex,
  { timeoutMs = 90000, sinceSeconds = 150, intervalMs = 3000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await readLogsSince(container, sinceSeconds);
    const hit = logs.split("\n").find((l) => regex.test(l));
    if (hit) return hit;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for /${regex.source}/ in ${container} logs`);
}
