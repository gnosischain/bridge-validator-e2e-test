// Run npm test scripts one by one, keep going after a failure, and print a
// summary (also written to the GitHub job summary in CI).
//
//   node ci/runSuite.js test test:finality:ethfcr-gcbf
//
// Aggregate scripts that are just `npm run a && npm run b && ...` (like `test`)
// are expanded into their parts, so one failing test does not hide the rest.

import { spawn } from "child_process";
import fs from "fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_SECS || 900) * 1000;
const inCi = process.env.GITHUB_ACTIONS === "true";

function expand(name) {
  const cmd = pkg.scripts[name];
  if (cmd === undefined) throw new Error(`No npm script named "${name}"`);
  const parts = cmd.split("&&").map((s) => s.trim());
  if (parts.length > 1 && parts.every((p) => /^npm run [\w:-]+$/.test(p))) {
    return parts.flatMap((p) => expand(p.slice("npm run ".length)));
  }
  return [name];
}

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    // Own process group, so a timeout kills the test and not just npm.
    const child = spawn("npm", ["run", "--silent", name], { stdio: "inherit", detached: true });
    const timer = setTimeout(() => {
      console.error(`\n${name} exceeded ${TEST_TIMEOUT_MS / 1000}s; killing it.`);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, TEST_TIMEOUT_MS);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ name, ok: code === 0, code: code ?? signal, secs: Math.round((Date.now() - started) / 1000) });
    });
  });
}

const names = [...new Set(process.argv.slice(2).flatMap(expand))];
if (names.length === 0) {
  console.error("Usage: node ci/runSuite.js <npm script>...");
  process.exit(2);
}

const results = [];
for (const name of names) {
  console.log(inCi ? `::group::${name}` : `\n===== ${name} =====`);
  const result = await run(name);
  if (inCi) console.log("::endgroup::");
  if (!result.ok && inCi) console.log(`::error title=${name}::failed (exit ${result.code})`);
  results.push(result);
}

const failed = results.filter((r) => !r.ok);
const rows = results.map((r) => `| ${r.ok ? "✅" : "❌"} | \`${r.name}\` | ${r.secs}s |`);
const table = ["| | Test | Time |", "|---|---|---|", ...rows].join("\n");
console.log(`\n${table}\n\n${results.length - failed.length}/${results.length} passed`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const title = process.env.SUITE_TITLE || "E2E";
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### ${title}: ${results.length - failed.length}/${results.length} passed\n\n${table}\n\n`,
  );
}
process.exitCode = failed.length ? 1 : 0;
