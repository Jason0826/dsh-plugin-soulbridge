/**
 * "Switch to a new session" reminder (0026 continuation).
 *
 * The signal is the same one the dashboard prints: prompt tokens per request — how much
 * history every single call re-buys — with the turn count as the second axis. The
 * failure this guards is a session that keeps costing more while nobody says so; the
 * other failure is a reminder every turn, which becomes wallpaper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-switch-'));
process.env.SOULBRIDGE_HOME = home;

const { createSessionLedger, renderSwitchSession } = await import('../index.js');

test('below the threshold nothing is said', () => {
  const ledger = createSessionLedger();
  ledger.note({ session: 's1', requests: 2, input: 100, cacheHit: 100_000 });
  assert.equal(ledger.due('s1'), '', '50k per request is a normal session');
  assert.equal(ledger.due('unknown'), '', 'a session the ledger never saw has no reminder');
});

test('300k prompt tokens per request crosses level 1, once', () => {
  const ledger = createSessionLedger();
  ledger.note({ session: 's1', requests: 4, cacheHit: 1_200_000 }); // exactly 300k/request
  const block = ledger.due('s1');
  assert.match(block, /^<switch-session turns="1" context-per-request="300000">/);
  assert.match(block, /新开一个会话/);
  assert.match(block, /state\.md/);
  assert.equal(ledger.due('s1'), '', 'the same level is not repeated');
});

test('a doubling crosses the next level, and says so again', () => {
  const ledger = createSessionLedger();
  ledger.note({ session: 's1', requests: 4, cacheHit: 1_200_000 }); // 300k/request -> level 1
  assert.match(ledger.due('s1'), /context-per-request="300000"/);
  // Same session, twice the context: (1.2M + 3.6M) / 8 = 600k -> level 2.
  ledger.note({ session: 's1', requests: 4, cacheHit: 3_600_000 });
  assert.match(ledger.due('s1'), /context-per-request="600000"/);
  assert.equal(ledger.due('s1'), '', 'level 2 is not repeated either');
});

test('the turn count is the second axis: 100 turns is enough even with a small context', () => {
  const ledger = createSessionLedger();
  for (let i = 0; i < 100; i += 1) ledger.note({ session: 's1', requests: 1, input: 1_000 });
  const block = ledger.due('s1');
  assert.match(block, /turns="100"/);
  assert.match(block, /context-per-request="1000"/);
});

test('the ledger is bounded: old sessions are dropped, not accumulated forever', () => {
  const ledger = createSessionLedger();
  for (let i = 0; i < 20; i += 1) ledger.note({ session: `s${i}`, requests: 1, input: 1_000 });
  assert.equal(ledger.due('s0'), '', 'the oldest session was evicted, so it has nothing to say');
  assert.equal(ledger.due('s19'), '', 'a recent small session is not a reminder either');
});

test('the block renders the numbers a human can check', () => {
  const text = renderSwitchSession({ turns: 39, requests: 853, prompt: 300_000_000 }, 355_311);
  assert.match(text, /turns="39" context-per-request="355311"/);
  assert.match(text, /355k token/);
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
