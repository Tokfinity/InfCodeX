/**
 * Contract test for CAP-044: session id generation fallback
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-044-session-id-generation-fallback
 *
 * Test obligations:
 * - CAP-SESSION-ID-001: returns a non-empty string in the
 *   `YYYYMMDD_HHMMSS_<suffix>` format (suffix added in FEATURE_219 v0.7.46
 *   for global uniqueness — see ADR-038 §7)
 * - CAP-SESSION-ID-002: encodes the current local date as the leading
 *   8 digits of the id
 * - CAP-SESSION-ID-003: ids are globally unique even within one second
 *
 * Note on the original P1 stub: the obligation text said "crypto-random
 * string" but the actual implementation
 * (`packages/agent/src/session.ts:50`) is a timestamp-derived format
 * (`YYYYMMDD_HHMMSS`). The reformulated obligations match the
 * function's real contract.
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: packages/agent/src/session.ts:50
 * (re-exported via packages/coding/src/session.ts; called from agent.ts
 * after auto-resume discovery / explicit id resolution).
 *
 * Time-ordering constraint: AFTER autoResume discovery; BEFORE session
 * loading.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6k.
 */

import { describe, expect, it } from 'vitest';

import { generateSessionId } from '../../session.js';

describe('CAP-044: session id generation fallback contract', () => {
  it('CAP-SESSION-ID-001: returns a date-prefixed string in YYYYMMDD_HHMMSS_<suffix> format', async () => {
    // FEATURE_219 (v0.7.46): a per-call suffix was appended to make ids
    // globally unique under the per-project directory layout (ADR-038 §7).
    // The sortable date+time prefix is preserved.
    const id = await generateSessionId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^\d{8}_\d{6}_[a-z0-9]+$/);
  });

  it('CAP-SESSION-ID-003: generates globally unique ids within the same second (FEATURE_219)', async () => {
    const ids = await Promise.all(Array.from({ length: 100 }, () => generateSessionId()));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('CAP-SESSION-ID-002: encodes the current local date as the leading 8 digits (YYYYMMDD)', async () => {
    // Snapshot `now` BEFORE generating the id so a midnight rollover
    // between `generateSessionId()` and `expectedDatePrefix` cannot
    // cause a flaky mismatch — verify the id's prefix is one of the
    // two adjacent dates that `now` could represent.
    const beforeNow = new Date();
    const id = await generateSessionId();
    const afterNow = new Date();

    const datePrefix = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

    const idPrefix = id.slice(0, 8);
    expect([datePrefix(beforeNow), datePrefix(afterNow)]).toContain(idPrefix);
  });
});
