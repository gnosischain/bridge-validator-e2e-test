// All addresses/topics below were verified against live mainnet + Gnosis Chain
// data. Do not edit topic0 values by hand — regenerate with:
//   cast sig-event "UserRequestForAffirmation(address,uint256,bytes32)"

const env = process.env;
const num = (k, d) => (env[k] ? Number(env[k]) : d);
const req = (k) => {
  if (!env[k]) throw new Error(`missing required env var ${k}`);
  return env[k];
};

export const TICK_SECONDS = num("TICK_SECONDS", 60);
export const PORT = num("PORT", 8080);
export const REDIS_URL = env.REDIS_URL || "redis://redis:6379";

// Validation rules. A source event is "on time" when the validator's receipt on
// contract K lands within this many seconds of the source block timestamp.
//   eth -> gc  : ~1-2 ETH blocks
//   gc -> eth  : GC finality (~2 epochs)
export const MAX_DELAY_S = {
  eth: num("ETH_MAX_DELAY_S", 36),
  gc: num("GC_MAX_DELAY_S", 300),
};

// A source event is only counted as "missed" once it is this old and still
// unsigned. Without it, everything from the last few minutes reads as missed.
export const GRACE_S = num("GRACE_S", 1800);

// Retention for the per-event records. Counters are permanent.
export const EVENT_TTL_S = num("EVENT_TTL_S", 30 * 24 * 3600);

// How many delayed/missed tx hashes to keep for the UI.
export const SAMPLE_LIMIT = num("SAMPLE_LIMIT", 500);

export const CHAINS = {
  eth: {
    rpc: req("ETH_RPC"),
    // Depth to stay behind the head so a reorg can't produce a phantom event.
    // This delays reporting only — latency is measured from block timestamps.
    confirmations: num("ETH_CONFIRMATIONS", 12),
    chunk: num("ETH_CHUNK", 5000),
    startBlock: env.ETH_START_BLOCK ? Number(env.ETH_START_BLOCK) : null,
    explorer: env.ETH_EXPLORER || "https://etherscan.io",
  },
  gc: {
    rpc: req("GC_RPC"),
    confirmations: num("GC_CONFIRMATIONS", 12),
    chunk: num("GC_CHUNK", 10000),
    startBlock: env.GC_START_BLOCK ? Number(env.GC_START_BLOCK) : null,
    explorer: env.GC_EXPLORER || "https://gnosisscan.io",
  },
};

// Contract K is always on Gnosis Chain: every validator call (both bridges,
// both directions) is made against the Home side.
export const K_CHAIN = "gc";

// VALIDATORS="nodejs:0xAAA...,rust:0xBBB..."  (contract K address per validator)
export const VALIDATORS = req("VALIDATORS")
  .split(",")
  .map((entry) => {
    const [name, address] = entry.split(":").map((s) => s.trim());
    if (!name || !/^0x[0-9a-fA-F]{40}$/.test(address || "")) {
      throw new Error(`bad VALIDATORS entry "${entry}", expected name:0xAddress`);
    }
    return { name, address: address.toLowerCase() };
  });

// ── Source events on the real bridges ────────────────────────────────────────
// `dir` doubles as the source chain: eth->gc events originate on Ethereum and
// are answered by SignedForAffirmation; gc->eth by SignedForSignature.
//
// idFrom() pulls the value contract K will echo back: the AMB messageId (an
// indexed topic) or the xDAI nonce (a non-indexed word in `data`).
const slot = (log, i) => "0x" + log.data.slice(2).slice(i * 64, (i + 1) * 64);

export const SOURCES = [
  {
    chain: "eth",
    dir: "eth->gc",
    bridge: "amb",
    address: (env.ETH_AMB || "0x4C36d2919e407f0Cc2Ee3c993ccF8ac26d9CE64e").toLowerCase(),
    // UserRequestForAffirmation(bytes32 indexed messageId, bytes encodedData)
    topic0: "0x482515ce3d9494a37ce83f18b72b363449458435fafdd7a53ddea7460fe01b58",
    idFrom: (log) => log.topics[1],
  },
  {
    chain: "eth",
    dir: "eth->gc",
    bridge: "xdai",
    address: (env.ETH_XDAI || "0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016").toLowerCase(),
    // UserRequestForAffirmation(address recipient, uint256 value, bytes32 nonce)
    topic0: "0xf6968e689b3d8c24f22c10c2a3256bb5ca483a474e11bac08423baa049e38ae8",
    idFrom: (log) => slot(log, 2),
  },
  {
    chain: "gc",
    dir: "gc->eth",
    bridge: "amb",
    address: (env.GC_AMB || "0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59").toLowerCase(),
    // UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)
    topic0: "0x520d2afde79cbd5db58755ac9480f81bc658e5c517fcae7365a3d832590b0183",
    idFrom: (log) => log.topics[1],
  },
  {
    chain: "gc",
    dir: "gc->eth",
    bridge: "xdai",
    address: (env.GC_XDAI || "0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6").toLowerCase(),
    // UserRequestForSignature(address recipient, uint256 value, bytes32 nonce, address token)
    topic0: "0xe1e0bc4a1db39a361e3589cae613d7b4862e1f9114dd3ff12ff45be395046968",
    idFrom: (log) => slot(log, 2),
  },
];

// ── Contract K receipts ──────────────────────────────────────────────────────
// SignedForAffirmation(uint8 indexed bridge, bytes32 indexed id)
// SignedForSignature(uint8 indexed bridge, bytes32 indexed id)
export const K_TOPICS = {
  "0x0e96bea7c81f6ab9fdaadfef6cce8af0895e8afb435212ef17cabd1bc040b200": "eth->gc",
  "0x7816cf218f07978e8469448a01a13c834fe09266b57c6c890b8a1decf9cc62ca": "gc->eth",
};

export const BRIDGE_BY_INDEX = ["amb", "xdai"];

// The source chain a direction originates from — picks the delay threshold and
// the "events from ETH / from GC" bucket.
export const srcChain = (dir) => (dir === "eth->gc" ? "eth" : "gc");

export const DIRS = ["eth->gc", "gc->eth"];
export const BRIDGES = ["amb", "xdai"];
