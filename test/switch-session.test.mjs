/**
 * Proactive advice (0026 switch reminder → 0018 trigger registry).
 *
 * The signal is the same one the dashboard prints: prompt tokens per request — how much
 * history every single call re-buys — with the turn count as the second axis. Two rows
 * now share one ledger: 200k suggests compact (0018 first slice), 300k/100 turns says
 * switch — compact first, switching is the fallback. The failures this guards: a session
 * that keeps costing more while nobody says so, a reminder every turn (wallpaper), and
 * a "registry" that only works for the rows it was born with (0018 §0).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-switch-'));
process.env.SOULBRIDGE_HOME = home;

const { createSessionLedger, renderSwitchSession, renderContextCompact, PROACTIVE_TRIGGERS } = await import(
  '../index.js'
);

test('below the threshold nothing is said', () => {
  const ledger = createSessionLedger();
  ledger.note({ session: 's1', requests: 2, input: 100, cacheHit: 100_000 });
  assert.equal(ledger.due('s1'), null, '50k per request is a normal session');
  assert.equal(ledger.due('unknown'), null, 'a session the ledger never saw has no advice');
});

test('200k suggests compact first, and says it once', () => {
  const ledger = createSessionLedger();
  ledger.note({ session: 's1', requests: 4, cacheHit: 800_000 }); // exactly 200k/request
  const fire = ledger.due('s1');
  assert.equal(fire.id, 'context-compact');
  assert.equal(fire.action, 'asking');
  assert.equal(fire.trigger, 200_000, 'the trace carries the value that fired');
  assert.match(fire.block, /^<proactive id="context-compact" context-per-request="200000">/);
  assert.match(fire.block, /\/compact/);
  assert.match(fire.block, /留在本会话/);
  assert.equal(ledger.due('s1'), null, 'the same level is not repeated');
});

test('300k still says switch — as the second row, after compact', () => {
  const ledger = createSessionLedger();
  ledger.note({ session: 's1', requests: 4, cacheHit: 1_200_000 }); // exactly 300k/request
  const first = ledger.due('s1');
  assert.equal(first.id, 'context-compact', 'the earlier line fires first');
  const second = ledger.due('s1');
  assert.equal(second.id, 'switch-session');
  assert.match(second.block, /^<proactive id="switch-session" turns="1" context-per-request="300000">/);
  assert.match(second.block, /优先 ?\/compact/, 'the wording now leads with compact');
  assert.match(second.block, /state\.md/);
  assert.equal(ledger.due('s1'), null, 'both rows are spent at this level');
});

test('a doubling crosses the next level, and says so again', () => {
  const ledger = createSessionLedger();
  ledger.note({ session: 's1', requests: 4, cacheHit: 800_000 }); // 200k -> compact level 1
  assert.equal(ledger.due('s1').id, 'context-compact');
  // Same session, twice the context: (800k + 2.4M) / 8 = 400k -> compact level 2.
  ledger.note({ session: 's1', requests: 4, cacheHit: 2_400_000 });
  const again = ledger.due('s1');
  assert.equal(again.id, 'context-compact');
  assert.match(again.block, /context-per-request="400000"/);
  const third = ledger.due('s1');
  assert.equal(third.id, 'switch-session', 'the switch row is due at 400k too — one row per turn, it follows');
  assert.equal(ledger.due('s1'), null, 'everything due at this level is spent');
});

test('the turn count is the second axis: 100 turns is enough even with a small context', () => {
  const ledger = createSessionLedger();
  for (let i = 0; i < 100; i += 1) ledger.note({ session: 's1', requests: 1, input: 1_000 });
  const fire = ledger.due('s1');
  assert.equal(fire.id, 'switch-session', 'the compact row stays silent on a small context');
  assert.match(fire.block, /turns="100"/);
  assert.match(fire.block, /context-per-request="1000"/);
});

test('the ledger is bounded: old sessions are dropped, not accumulated forever', () => {
  const ledger = createSessionLedger();
  for (let i = 0; i < 20; i += 1) ledger.note({ session: `s${i}`, requests: 1, input: 1_000 });
  assert.equal(ledger.due('s0'), null, 'the oldest session was evicted, so it has nothing to say');
  assert.equal(ledger.due('s19'), null, 'a recent small session is not advice either');
});

test('the blocks render the numbers a human can check', () => {
  const switchText = renderSwitchSession({ turns: 39, requests: 853, prompt: 300_000_000 }, 355_311);
  assert.match(switchText, /turns="39" context-per-request="355311"/);
  assert.match(switchText, /355k token/);
  const compactText = renderContextCompact({ turns: 8, requests: 40, prompt: 8_000_000 }, 201_234);
  assert.match(compactText, /context-per-request="201234"/);
  assert.match(compactText, /201k token/);
});

test('a new habit is a new row, not a new code path (0018 §0)', () => {
  // The acceptance line, mechanical: a row nobody wrote code for must fire through the
  // same ledger. If this needs an if-statement inside due(), the framework failed.
  const row = {
    id: 'gap-age',
    action: 'asking',
    level: (stats) => Math.floor(stats.turns / 5),
    render: () => '<proactive id="gap-age">那个缺口问了吗</proactive>',
  };
  const ledger = createSessionLedger({ triggers: [row] });
  for (let i = 0; i < 5; i += 1) ledger.note({ session: 's1', requests: 1, input: 100 });
  const fire = ledger.due('s1');
  assert.equal(fire.id, 'gap-age');
  assert.equal(ledger.due('s1'), null, 'once per level, same as every other row');
  assert.deepEqual(
    PROACTIVE_TRIGGERS.map((trigger) => trigger.id),
    ['context-compact', 'switch-session'],
    'the shipped registry order: compact line first, switch second',
  );
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
