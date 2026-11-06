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

const { createSessionLedger, renderSwitchSession, renderContextCompact, renderCompactLimit, PROACTIVE_TRIGGERS } =
  await import('../index.js');

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
    ['compact-limit', 'context-compact', 'switch-session'],
    'the shipped order: budget row first, then the compact line, then switch',
  );
});

test('a compaction resets the arc: the stale-350k bug (2026-11-07)', () => {
  const ledger = createSessionLedger();
  ledger.note({ session: 's1', requests: 9, cacheHit: 3_193_245 }); // 354.8k — turn 13
  assert.equal(ledger.due('s1').id, 'context-compact', 'the line fires on the pre-compact arc');
  assert.equal(ledger.compact('s1'), 1, 'the host compacted; the caller traces the count');
  assert.equal(
    ledger.due('s1'),
    null,
    'right after compaction there is nothing to advise on — the arc is empty, not 350k',
  );
  ledger.note({ session: 's1', requests: 10, cacheHit: 2_700_000 }); // new arc at 270k
  const again = ledger.due('s1');
  assert.equal(
    again?.id,
    'context-compact',
    'level 1 again: without re-arming the gate, reminded=1 would keep it silent',
  );
  assert.equal(ledger.due('s1'), null, 'once per level, as always');
});

test('two compactions spend the budget: the next 200k crossing advises switching', () => {
  const ledger = createSessionLedger();
  ledger.note({ session: 's1', requests: 4, cacheHit: 800_000 }); // 200k
  assert.equal(ledger.due('s1').id, 'context-compact', 'budget 1 of 2: compact advice');
  ledger.compact('s1');
  ledger.note({ session: 's1', requests: 4, cacheHit: 800_000 }); // fresh arc, 200k
  assert.equal(ledger.due('s1').id, 'context-compact', 'budget 2 of 2: still compact advice');
  ledger.compact('s1');
  ledger.note({ session: 's1', requests: 4, cacheHit: 800_000 }); // fresh arc, 200k again
  const fire = ledger.due('s1');
  assert.equal(fire?.id, 'compact-limit', 'budget spent: the limit row owns the line');
  assert.match(fire.block, /compactions="2"/);
  assert.match(fire.block, /两压一会话/);
  assert.match(fire.block, /state\.md/);
  assert.equal(ledger.due('s1'), null, 'once per level, as always');
});

test('the two rows partition the line by compaction budget (0018 §0 contract)', () => {
  const limit = PROACTIVE_TRIGGERS.find((trigger) => trigger.id === 'compact-limit');
  const compact = PROACTIVE_TRIGGERS.find((trigger) => trigger.id === 'context-compact');
  const fresh = { turns: 8, requests: 40, prompt: 8_000_000, compactions: 0, recentRequests: [] };
  const spent = { ...fresh, compactions: 2 };
  assert.equal(compact.level(fresh, 201_000), 1, 'budget intact: the compact row speaks');
  assert.equal(limit.level(fresh, 201_000), 0, 'budget intact: the limit row stays silent');
  assert.equal(compact.level(spent, 201_000), 0, 'budget spent: the compact row yields the line');
  assert.equal(limit.level(spent, 201_000), 1, 'budget spent: the limit row takes it');
  assert.equal(limit.level(spent, 150_000), 0, 'below the line nobody speaks, budget or not');
});

test('the blocks price the ride (2026-11-07 cost model)', () => {
  // carry rate = 5 req/turn x ¥0.02 hit + 0.29 eviction x ¥1 miss = ¥0.39 per M per turn.
  const compactText = renderContextCompact({ turns: 13, requests: 95, prompt: 34_000_000 }, 342_350);
  assert.match(compactText, /每轮约 ¥0\.13/, '342k x 0.39 = ¥0.13 per turn');
  assert.match(compactText, /¥0\.01/, 'post-compact baseline 27k costs ¥0.01');
  assert.match(compactText, /13 倍/, '342k / 27k');
  assert.match(compactText, /离开较久/, 'the turn-12 lesson rides along: compact before long gaps');
  const limitText = renderCompactLimit({ turns: 20, requests: 120, prompt: 24_000_000, compactions: 2 }, 201_000);
  assert.match(limitText, /compactions="2"/);
  assert.match(limitText, /¥0\.08/, '201k x 0.39 = ¥0.08 per turn');
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
