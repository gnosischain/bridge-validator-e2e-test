import Redis from "ioredis";
import { REDIS_URL, SAMPLE_LIMIT } from "./config.js";

export const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

// A source event and the validator receipt that answers it share this suffix,
// so a match is a direct key lookup rather than a scan.
//   bridge : amb | xdai
//   dir    : eth->gc | gc->eth
//   id     : AMB messageId or xDAI nonce
// The nonce counters of the two directions overlap, so `dir` must be part of
// the key — xDAI nonce 0x1336 exists both eth->gc and gc->eth.
export const eventKey = (bridge, dir, id) => `${bridge}:${dir}:${id}`;

export const K = {
  cursor: (chain) => `cursor:${chain}`,
  head: (chain) => `head:${chain}`,
  src: (suffix) => `src:${suffix}`,
  sig: (validator, suffix) => `sig:${validator}:${suffix}`,
  pending: (validator) => `pending:${validator}`,
  metricsGlobal: "metrics:global",
  metrics: (validator) => `metrics:${validator}`,
  delayed: (validator) => `delayed:${validator}`,
  missed: (validator) => `missed:${validator}`,
};

export async function pushSample(pipeline, key, record) {
  pipeline.lpush(key, JSON.stringify(record));
  pipeline.ltrim(key, 0, SAMPLE_LIMIT - 1);
}

export const readJson = (raw) => (raw ? JSON.parse(raw) : null);

export async function getCursor(chain) {
  const v = await redis.get(K.cursor(chain));
  return v === null ? null : Number(v);
}

export const setCursor = (chain, block) => redis.set(K.cursor(chain), String(block));

export async function setHead(chain, block, ts) {
  await redis.set(K.head(chain), JSON.stringify({ block, ts }));
}

export async function getHead(chain) {
  return readJson(await redis.get(K.head(chain)));
}
