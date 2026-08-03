// Observer connectivity doctor — answers "why did the FCR test throw ECONNREFUSED?"
//
// There is no observer *process*: src/observer is a client library the FCR tests
// import to read the validator's own state store. So a connection error means the
// store the tests are pointed at isn't up — usually because the rust stack is
// running (Postgres) while the tests default to the oracle stack (Redis).
//
//   npm run observer:check                          # probe both backends
//   OBSERVER_BACKEND=postgres npm run observer:check # probe what the tests will use

import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import { RedisObserver } from "./redis.js";
import { PostgresObserver } from "./postgres.js";
import { REDIS_URLS, POSTGRES_URL, OBSERVER_BACKEND } from "./index.js";

async function probeRedis(label, url) {
  const obs = new RedisObserver(url);
  try {
    await obs.ready(); // throws with the endpoint named if unreachable
    await obs.pending("foreign", 0); // any read — proves the socket is live
    console.log(`  ✓ redis ${label.padEnd(5)} ${url}`);
    return true;
  } catch (err) {
    console.log(`  ✗ redis ${label.padEnd(5)} ${url} — ${err.code || err.message}`);
    return false;
  } finally {
    await obs.close().catch(() => {});
  }
}

async function probePostgres(url) {
  const obs = new PostgresObserver(url);
  try {
    await obs.ready();
    await obs.pending("eth", 0); // also proves the FCR tables were migrated
    console.log(`  ✓ postgres    ${url}`);
    return true;
  } catch (err) {
    console.log(`  ✗ postgres    ${url} — ${err.code || err.message}`);
    return false;
  } finally {
    await obs.close().catch(() => {});
  }
}

async function main() {
  const forced = OBSERVER_BACKEND;
  console.log(
    `OBSERVER_BACKEND=${forced ?? "(unset → tests use redis)"}\n`,
  );

  const results = {};
  if (forced !== "postgres") {
    results.amb = await probeRedis("amb", REDIS_URLS.amb);
    results.xdai = await probeRedis("xdai", REDIS_URLS.xdai);
  }
  if (forced !== "redis") {
    results.postgres = await probePostgres(POSTGRES_URL);
  }

  const oracleUp = results.amb || results.xdai;
  const rustUp = results.postgres;
  console.log("");

  if (forced === "postgres" && !rustUp) {
    console.log("Rust validator state is unreachable — is docker-compose-rust.yml up?");
    console.log("  npm run setup:docker-rust");
    process.exitCode = 1;
  } else if (forced === "postgres") {
    console.log("Ready: run the :rust suite for your profile —");
    console.log("  npm run test:finality:ethfcr-gcbf:rust   # after setup:profile:ethfcr-gcbf");
    console.log("  npm run test:finality:ethbf-gcfcr:rust   # after setup:profile:ethbf-gcfcr");
  } else if (oracleUp) {
    console.log("Ready: run the oracle suite for your profile —");
    console.log("  npm run test:finality:ethfcr-gcbf        # after setup:profile:ethfcr-gcbf");
    console.log("  npm run test:finality:ethbf-gcfcr        # after setup:profile:ethbf-gcfcr");
  } else if (rustUp) {
    console.log("No oracle Redis, but the rust validator IS up. The FCR tests");
    console.log("default to Redis — use the :rust scripts, which set");
    console.log("OBSERVER_BACKEND=postgres for you:");
    console.log("  npm run test:finality:ethfcr-gcbf:rust");
    process.exitCode = 1;
  } else {
    console.log("No validator state store reachable. Start one:");
    console.log("  npm run setup:docker-oracle   # oracle (Redis :6379/:6378)");
    console.log("  npm run setup:docker-rust     # rust   (Postgres :5432)");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
