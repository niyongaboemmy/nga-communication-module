import { describe, it, expect } from 'vitest';
import { snowflake, snowflakeToDate } from '../snowflake.js';

describe('snowflake', () => {
  it('produces unique ids under a tight loop', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => snowflake()));
    expect(ids.size).toBe(10_000);
  });

  it('produces ids that sort chronologically as BigInts', () => {
    const a = snowflake();
    const b = snowflake();
    expect(BigInt(b) > BigInt(a)).toBe(true);
  });

  it('round-trips the creation time to the millisecond', () => {
    const before = Date.now();
    const id = snowflake();
    const decoded = snowflakeToDate(id).getTime();
    expect(decoded).toBeGreaterThanOrEqual(before - 1);
    expect(decoded).toBeLessThanOrEqual(Date.now() + 1);
  });
});
