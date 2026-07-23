// EL JSON-RPC proxy mock — see FCR_integration.md.
//
// createMock(upstreamUrl, port) stands an express server in front of a
// Tenderly VN. It forwards every JSON-RPC call verbatim EXCEPT
// eth_getBlockByNumber, where it:
//   - synthesizes the `safe`/`finalized` pointers from mock state
//     (proxying the chosen concrete block number so hash/txs stay real),
//   - mutates `.hash` of a numbered block if a reorg is armed for it.
//
// Control plane:
//   POST /          → JSON-RPC (batch-aware)
//   POST /admin     → patch state ({ reset: true } | preset patch object)
//   GET  /admin/state → dump current state (assert / debug)

import express from "express";
import axios from "axios";
import {
  initialState,
  applyPatch,
  resolveTag,
  hashOverride,
  chaosFor,
} from "./state.js";

const toHex = (n) => "0x" + BigInt(n).toString(16);

// Forward a raw JSON-RPC payload to the upstream VN, returning its response body.
async function proxy(upstreamUrl, payload) {
  const { data } = await axios.post(upstreamUrl, payload, {
    headers: { "Content-Type": "application/json" },
  });
  return data;
}

// Fetch the upstream tip as a Number (for `follow` pointer resolution).
async function getLatestNumber(upstreamUrl) {
  const res = await proxy(upstreamUrl, {
    id: 1,
    jsonrpc: "2.0",
    method: "eth_blockNumber",
    params: [],
  });
  return Number(BigInt(res.result));
}

// Build a JSON-RPC error/response for an active transport-chaos descriptor.
// Returns { httpStatus?, body? } — httpStatus set means respond at HTTP level.
function chaosResponse(chaos, id) {
  switch (chaos.kind) {
    case "ERROR_500":
      return { httpStatus: 500, body: { error: "injected upstream 500" } };
    case "MALFORMED":
      return { httpStatus: 200, raw: "}{ this is not json" };
    case "JSONRPC_ERROR":
      return {
        httpStatus: 200,
        body: {
          id,
          jsonrpc: "2.0",
          error: { code: -32000, message: "injected JSON-RPC error" },
        },
      };
    default:
      return null;
  }
}

// Handle a single JSON-RPC request object → single response object.
// `chaosOut` collects an out-of-band chaos directive (HTTP-level) if one fires.
async function handleSingle(reqObj, upstreamUrl, state, chaosOut) {
  const { id, method, params = [] } = reqObj;

  if (method !== "eth_getBlockByNumber") {
    // transport chaos scoped to "all" affects passthrough too
    const chaos = chaosFor(state, method);
    if (chaos) {
      const r = chaosResponse(chaos, id);
      if (r) {
        chaosOut.push(r);
        return null;
      }
    }
    return proxy(upstreamUrl, reqObj);
  }

  const [tag, fullTx = false] = params;

  // ── safe / finalized: synthesized pointer ──────────────────────────────
  if (tag === "safe" || tag === "finalized") {
    const chaos = chaosFor(state, tag);
    if (chaos) {
      const r = chaosResponse(chaos, id);
      if (r) {
        chaosOut.push(r);
        return null;
      }
    }

    const latest = await getLatestNumber(upstreamUrl);
    const resolved = resolveTag(state, tag, latest);

    if (resolved.kind === "unsupported") {
      return {
        id,
        jsonrpc: "2.0",
        error: { code: -32602, message: `Invalid params: unsupported tag "${tag}"` },
      };
    }
    if (resolved.kind === "null") {
      return { id, jsonrpc: "2.0", result: null };
    }

    // proxy the concrete number so hash/txs are real, then apply any reorg
    const upstream = await proxy(upstreamUrl, {
      id,
      jsonrpc: "2.0",
      method: "eth_getBlockByNumber",
      params: [toHex(resolved.number), fullTx],
    });
    return applyReorg(upstream, resolved.number, state);
  }

  // ── numbered block: proxy, then reorg-mutate hash if armed ─────────────
  const upstream = await proxy(upstreamUrl, reqObj);
  if (typeof tag === "string" && /^0x[0-9a-fA-F]+$/.test(tag)) {
    return applyReorg(upstream, Number(BigInt(tag)), state);
  }

  // latest / earliest / pending → verbatim
  return upstream;
}

// If a reorg is armed for `blockNumber`, overwrite the result hash.
function applyReorg(response, blockNumber, state) {
  const newHash = hashOverride(state, blockNumber);
  if (newHash && response && response.result) {
    return { ...response, result: { ...response.result, hash: newHash } };
  }
  return response;
}

export function createMock(upstreamUrl, port, { label = "" } = {}) {
  const state = initialState();
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const tag = label ? `[mock ${label}:${port}]` : `[mock :${port}]`;

  app.post("/", async (req, res) => {
    try {
      const chaosOut = [];
      if (Array.isArray(req.body)) {
        const out = await Promise.all(
          req.body.map((r) => handleSingle(r, upstreamUrl, state, chaosOut)),
        );
        if (chaosOut.length) return respondChaos(res, chaosOut[0]);
        return res.json(out);
      }
      const out = await handleSingle(req.body, upstreamUrl, state, chaosOut);
      if (chaosOut.length) return respondChaos(res, chaosOut[0]);
      return res.json(out);
    } catch (err) {
      console.error(`${tag} dispatch error:`, err.message);
      return res.status(502).json({
        id: req.body?.id ?? null,
        jsonrpc: "2.0",
        error: { code: -32603, message: `mock proxy error: ${err.message}` },
      });
    }
  });

  app.post("/admin", (req, res) => {
    if (req.body && req.body.reset) {
      Object.assign(state, initialState());
    } else {
      applyPatch(state, req.body);
    }
    console.log(`${tag} admin patch →`, JSON.stringify(state));
    return res.json({ ok: true, state });
  });

  app.get("/admin/state", (_req, res) => res.json(state));

  const server = app.listen(port, () => {
    console.log(`${tag} proxying → ${upstreamUrl}`);
  });

  return { app, server, state };
}

function respondChaos(res, directive) {
  if (directive.raw !== undefined) {
    res.status(directive.httpStatus || 200);
    res.type("application/json");
    return res.send(directive.raw);
  }
  return res.status(directive.httpStatus || 200).json(directive.body);
}
