// FCR observer — Postgres backend (rust bridge-validator).
//
// The rust validator keeps FCR state in Postgres rather than Redis. Mapping to
// the observer interface (see FCR_PLAN.md §5):
//
//   pending(block)        event_logs.fcr_status = 'pending'   (indexer wrote it at `safe`)
//   confirmed(block)      event_logs.fcr_status = 'confirmed' (checker matched the hash)
//   falsePositive(block)  row in fcr_false_positives          (checker saw a hash mismatch)
//
// Two shape differences from the Redis backend, both absorbed here so the tests
// stay identical across backends:
//
//  1. Chain naming. Redis keys use the oracle's home/foreign; the rust schema
//     uses eth/gc. `chainKey()` accepts either spelling.
//  2. Confirmed is POSITIVE here. The oracle checker *prunes* the ZSET entry, so
//     "confirmed" can only be inferred as "gone and not a false positive". The
//     rust checker instead transitions the row to 'confirmed' in place
//     (fcr_checker.rs::mark_confirmed) and, on a mismatch, to 'reverted' —
//     nothing is deleted. So this reads the terminal state directly rather than
//     inferring it from an absence.
//
// Rows are scoped by `bridge_mode` (AMB_ETH/XDAI_ETH vs AMB_GC/XDAI_GC) exactly
// as the checker scopes its own queries (Config::bridge_modes_for_chain), so a
// deposit on one chain is never observed as state on the other.

import pg from "pg";

const BRIDGE_MODES = {
  eth: ["AMB_ETH", "XDAI_ETH"],
  gc: ["AMB_GC", "XDAI_GC"],
};

// Accept both the oracle's home/foreign and the rust eth/gc spelling.
const CHAIN_ALIASES = {
  eth: "eth",
  foreign: "eth",
  gc: "gc",
  home: "gc",
};

function chainKey(chain) {
  const key = CHAIN_ALIASES[chain];
  if (!key) throw new Error(`PostgresObserver: unknown chain "${chain}"`);
  return key;
}

export class PostgresObserver {
  constructor(url) {
    this.pool = new pg.Pool({ connectionString: url, max: 4 });
  }

  async ready() {
    // Fail fast and loudly rather than letting every later query time out.
    const client = await this.pool.connect();
    client.release();
    return this;
  }

  async _statusCount(chain, blockNumber, status) {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n
         FROM event_logs
        WHERE bridge_mode = ANY($1)
          AND fcr_status = $2
          AND block_number = $3`,
      [BRIDGE_MODES[chainKey(chain)], status, Number(blockNumber)],
    );
    return rows[0].n;
  }

  // True while block `n` has rows the checker has not resolved yet.
  async pending(chain, blockNumber) {
    return (await this._statusCount(chain, blockNumber, "pending")) > 0;
  }

  // The block hash the indexer stored when the block was merely `safe`.
  async pendingHash(chain, blockNumber) {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT block_hash
         FROM event_logs
        WHERE bridge_mode = ANY($1)
          AND fcr_status = 'pending'
          AND block_number = $2
          AND block_hash IS NOT NULL`,
      [BRIDGE_MODES[chainKey(chain)], Number(blockNumber)],
    );
    return rows[0]?.block_hash ?? null;
  }

  // `${txHash}-${logIndex}` entries for a pending block — the rust equivalent of
  // the oracle's pendingSafeTxs SET. Keyed by hash to match the interface.
  async pendingTxs(chain, blockHash) {
    const { rows } = await this.pool.query(
      `SELECT transaction_hash, log_index
         FROM event_logs
        WHERE bridge_mode = ANY($1)
          AND block_hash = $2
          AND fcr_status = 'pending'`,
      [BRIDGE_MODES[chainKey(chain)], blockHash],
    );
    return rows.map((r) => `${r.transaction_hash}-${r.log_index}`);
  }

  async falsePositive(chain, blockNumber, blockHash) {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n
         FROM fcr_false_positives
        WHERE chain = $1
          AND block_number = $2
          AND ($3::text IS NULL OR stored_block_hash = $3)`,
      [chainKey(chain), Number(blockNumber), blockHash ?? null],
    );
    return rows[0].n > 0;
  }

  // Terminal 'confirmed' state, and not recorded as a false positive.
  async confirmed(chain, blockNumber, blockHash) {
    if (await this.falsePositive(chain, blockNumber, blockHash)) return false;
    return (await this._statusCount(chain, blockNumber, "confirmed")) > 0;
  }

  // Raw false-positive records, normalized to the Redis backend's field names so
  // assertions and log output read the same on both backends.
  async falsePositiveRecords(chain) {
    const { rows } = await this.pool.query(
      `SELECT chain, block_number, stored_block_hash, canonical_block_hash,
              transaction_hash, log_index, detected_at_finalized, created_at
         FROM fcr_false_positives
        WHERE chain = $1
        ORDER BY id ASC`,
      [chainKey(chain)],
    );
    return rows.map((r) => ({
      chain: r.chain,
      blockNumber: Number(r.block_number),
      blockHash: r.stored_block_hash,
      storedBlockHash: r.stored_block_hash,
      canonicalBlockHash: r.canonical_block_hash,
      txHash: r.transaction_hash,
      logIndex: r.log_index === null ? null : Number(r.log_index),
      detectedAtFinalized:
        r.detected_at_finalized === null ? null : Number(r.detected_at_finalized),
      detectedAt: r.created_at,
    }));
  }

  async close() {
    await this.pool.end();
  }
}
