// Minimal JSON-RPC client. No web3 library — every value we read is either a
// hex quantity or a fixed-offset word, so decoding is a substring.

const hexToNum = (h) => Number(BigInt(h));

async function call(url, method, params, attempt = 0) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) {
      const err = new Error(`${method}: ${body.error.message}`);
      err.rpcCode = body.error.code;
      err.rpcMessage = body.error.message;
      throw err;
    }
    return body.result;
  } catch (err) {
    // A too-many-results error must reach the caller so it can split the range.
    if (isRangeTooLarge(err) || attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return call(url, method, params, attempt + 1);
  }
}

export function isRangeTooLarge(err) {
  const m = (err.rpcMessage || err.message || "").toLowerCase();
  return (
    m.includes("more than") ||
    m.includes("too many results") ||
    m.includes("query returned more than") ||
    m.includes("range") ||
    m.includes("limit exceeded") ||
    m.includes("response size")
  );
}

export const blockNumber = async (url) => hexToNum(await call(url, "eth_blockNumber", []));

export async function getLogs(url, { addresses, topic0s, fromBlock, toBlock }) {
  return call(url, "eth_getLogs", [
    {
      address: addresses,
      topics: [topic0s],
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
    },
  ]);
}

/// Block timestamps, batched. eth_getLogs does not return them and every
/// latency figure depends on them.
export async function getBlockTimestamps(url, blockNumbers) {
  const out = new Map();
  const list = [...new Set(blockNumbers)];
  const BATCH = 20;
  for (let i = 0; i < list.length; i += BATCH) {
    const slice = list.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map((n) => call(url, "eth_getBlockByNumber", ["0x" + n.toString(16), false])),
    );
    results.forEach((block, j) => {
      if (block) out.set(slice[j], hexToNum(block.timestamp));
    });
  }
  return out;
}

export { hexToNum };
