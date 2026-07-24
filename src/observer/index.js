// FCR observer factory — a stable interface over the validator's state store.
// Redis today (oracle); a Postgres backend (rust) slots in behind the same
// pending / confirmed / falsePositive interface later.

import { RedisObserver } from "./redis.js";

// Host-side Redis endpoints for the two oracle stacks (docker publishes these).
export const REDIS_URLS = {
  amb: process.env.REDIS_URL_AMB || "redis://localhost:6379",
  xdai: process.env.REDIS_URL_XDAI || "redis://localhost:6378",
};

// Oracle "chain" prefixes used in the Redis keys.
export const OBSERVER_CHAIN = { eth: "foreign", gc: "home" };

// makeObserver({ backend, url }) → observer instance. Call `.ready()` before use.
export function makeObserver({ backend = "redis", url } = {}) {
  switch (backend) {
    case "redis":
      if (!url) throw new Error("makeObserver: redis backend requires a `url`");
      return new RedisObserver(url);
    // case "postgres": return new PostgresObserver(url);  // added when rust FCR ships
    default:
      throw new Error(`makeObserver: unknown backend "${backend}"`);
  }
}
