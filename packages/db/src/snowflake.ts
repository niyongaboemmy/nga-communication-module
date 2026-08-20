/**
 * 64-bit time-sortable ids (SRS §7). UUIDs would work as primary keys but
 * would cost us the free chronological ordering that message paging relies
 * on, so ids are generated here rather than by the database.
 *
 * Layout: 41 bits ms since epoch | 10 bits node | 12 bits sequence.
 * Returned as a string because 2^53 is where JSON numbers stop being exact.
 */
const EPOCH = 1_735_689_600_000; // 2025-01-01T00:00:00Z
const NODE_BITS = 10n;
const SEQ_BITS = 12n;
const MAX_SEQ = (1n << SEQ_BITS) - 1n;

let lastMs = 0n;
let sequence = 0n;

const nodeId = BigInt(Number(process.env.NODE_ID ?? 0) & 0x3ff);

export function snowflake(): string {
  let now = BigInt(Date.now() - EPOCH);

  if (now === lastMs) {
    sequence = (sequence + 1n) & MAX_SEQ;
    // Sequence exhausted inside a single millisecond — spin to the next one
    // rather than emit a duplicate id.
    if (sequence === 0n) {
      while (BigInt(Date.now() - EPOCH) <= lastMs) { /* spin */ }
      now = BigInt(Date.now() - EPOCH);
    }
  } else {
    sequence = 0n;
  }
  lastMs = now;

  return ((now << (NODE_BITS + SEQ_BITS)) | (nodeId << SEQ_BITS) | sequence).toString();
}

/** Recover the creation time of an id — handy in logs and admin tooling. */
export function snowflakeToDate(id: string): Date {
  return new Date(Number(BigInt(id) >> (NODE_BITS + SEQ_BITS)) + EPOCH);
}
