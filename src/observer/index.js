// FCR observer factory — a stable interface over the validator's state store.
// Redis for the oracle, Postgres for the rust bridge-validator, both behind the
// same pending / confirmed / falsePositive interface.

import { RedisObserver } from "./redis.js";
import { PostgresObserver } from "./postgres.js";

// Host-side Redis endpoints for the two oracle stacks (docker publishes these).
export const REDIS_URLS = {
  amb: process.env.REDIS_URL_AMB || "redis://localhost:6379",
  xdai: process.env.REDIS_URL_XDAI || "redis://localhost:6378",
};

// Host-side Postgres for the rust stack (docker-compose-rust.yml publishes 5432).
export const POSTGRES_URL =
  process.env.POSTGRES_URL ||
  "postgresql://bridge:bridge_password@localhost:5432/bridge_validator";

// Oracle "chain" prefixes used in the Redis keys. The Postgres backend accepts
// these spellings too, so tests need no per-backend chain mapping.
export const OBSERVER_CHAIN = { eth: "foreign", gc: "home" };

// Which validator's state to read. Infra, not assertion: set
// OBSERVER_BACKEND=postgres to point the FCR tests at the rust validator
// without touching them — they pass the oracle's backend/url explicitly, and
// this override wins so the same assertions run against either implementation.
export const OBSERVER_BACKEND = process.env.OBSERVER_BACKEND || null;

// makeObserver({ backend, url }) → observer instance. Call `.ready()` before use.
export function makeObserver({ backend = "redis", url } = {}) {
  const chosen = OBSERVER_BACKEND || backend;
  switch (chosen) {
    case "redis":
      if (!url) throw new Error("makeObserver: redis backend requires a `url`");
      return new RedisObserver(url);
    case "postgres":
      // Ignore a caller-supplied redis:// url when the env override flipped the
      // backend — a test written for the oracle cannot know the rust DSN.
      return new PostgresObserver(
        OBSERVER_BACKEND === "postgres" ? POSTGRES_URL : url || POSTGRES_URL,
      );
    default:
      throw new Error(`makeObserver: unknown backend "${chosen}"`);
  }
}
