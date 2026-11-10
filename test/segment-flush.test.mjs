/**
 * The departure checklist and sealing (brief 0028 ②).
 *
 * Three contracts, each with a mutation that must redden it:
 *   1. planSegment — the trigger table as pure code (rule 26): same session with
 *      no marker buffers, a session switch/compaction/archive/size/age flushes
 *      (mutate the drain's `if (!plan.trigger)` gate away → queue.test goes red)
 *   2. compaction/end sets the departure marker; an ERRORED compaction must not —
 *      a false departure writes durable memory for content still in the context
 *      (mutate the marker branch away → the wiring test below goes red)
 *   3. a sealed segment cannot be re-queued (mutate the guard away → red),
 *      with the recorded exception: a replay carries origin=backfill
 * plus the failure path: three failed calls seal and drop the segment with its
 * size visible — a rules floor is not a completed model extraction (0028/规则 33).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'soulbridge-segment-'));
process.env.SOULBRIDGE_HOME = home;
mkdirSync(home, { recursive: true });
// Default rules mode: tests without a provider must never reach one. The failure
// path flips this to 'llm' and applies a ctx whose llm stream always throws.
writeFileSync(join(home, 'plugin-config.json'), JSON.stringify({ extract: 'rules' }), 'utf8');

const mod = await import(`../index.js?segment=${Date.now()}`);

const stateFile = join(home, 'segment-state.json');
const queueFile = join(home, 'pending-extract.json');
const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const readQueue = () => JSON.parse(readFileSync(queueFile, 'utf8'));
const log = () => readFileSync(join(home, 'plugin.log'), 'utf8');

/** A buffer entry as drain builds it: rows are the truth, planSegment is pure. */
const entry = (id, { sessionId = 's1', startedAt = 1_000, chars = 10 } = {}) => ({
  item: { turnId: id, turnNo: Number(id.replace(/\D/g, '')) || 1, origin: 'live' },
  sessionId,
  startedAt,
  chars,
});

/* ---------------- 1. the checklist as a table ---------------- */

test('checklist: same session, no marker → nothing left, nothing flushed', () => {
  const plan = mod.planSegment([entry('t1'), entry('t2')], { currentSessionId: 's1', now: 2_000 });
  assert.equal(plan.trigger, null);
  assert.deepEqual(plan.entries, []);
});

test('checklist: session switch flushes the contiguous old-session run', () => {
  const plan = mod.planSegment(
    [entry('t1', { sessionId: 'old' }), entry('t2', { sessionId: 'old' }), entry('t3', { sessionId: 's1' })],
    { currentSessionId: 's1', now: 5_000 },
  );
  assert.equal(plan.trigger, 'session');
  assert.deepEqual(
    plan.entries.map((e) => e.item.turnId),
    ['t1', 't2'],
    '旧会话的连续段整体走，当前会话的留下',
  );
});

test('checklist: a backfill run behind live turns is not stranded behind them', () => {
  // The live turns wait for their own departure; a history batch appended after
  // them flushes on its own instead of queueing behind a session that may run for
  // days (this is what the old live-first pick solved — segments dissolve it).
  const plan = mod.planSegment(
    [entry('t1'), entry('t2'), entry('t3', { sessionId: 'old' })],
    { currentSessionId: 's1', now: 5_000 },
  );
  assert.equal(plan.trigger, 'session');
  assert.deepEqual(
    plan.entries.map((e) => e.item.turnId),
    ['t3'],
  );
});

test('checklist: the compaction marker covers exactly what predates it', () => {
  const plan = mod.planSegment(
    [entry('t1', { startedAt: 4_000 }), entry('t2', { startedAt: 5_000 }), entry('t3', { startedAt: 6_000 })],
    { currentSessionId: 's1', markerAt: 5_500, now: 7_000 },
  );
  assert.equal(plan.trigger, 'compaction');
  assert.deepEqual(
    plan.entries.map((e) => e.item.turnId),
    ['t1', 't2'],
    '标记之后入队的轮不属于这次压缩',
  );
});

test('checklist: archive flushes the whole buffer', () => {
  const plan = mod.planSegment([entry('t1'), entry('t2')], { currentSessionId: 's1', archived: true });
  assert.equal(plan.trigger, 'archived');
  assert.equal(plan.entries.length, 2, '归档 = 用户宣布会话结束，整段走');
});

test('checklist: capacity by turn count — 40 flushes the whole buffer, 39 waits', () => {
  const now = Date.now();
  const base = Array.from({ length: 39 }, (_, i) => entry(`t${i}`, { startedAt: now - 1_000 }));
  assert.equal(
    mod.planSegment(base, { currentSessionId: 's1', now }).trigger,
    null,
    '39 轮还没到兜底线，年龄也没超',
  );
  const plan = mod.planSegment([...base, entry('t39', { startedAt: now - 1_000 })], { currentSessionId: 's1', now });
  assert.equal(plan.trigger, 'capacity');
  assert.equal(plan.entries.length, 40, '容量兜底抽的是整个缓冲，不截断（规则 17）');
});

test('checklist: capacity by characters — 60k flushes, just under waits', () => {
  assert.equal(
    mod.planSegment([entry('t1', { chars: mod.SEGMENT_MAX_CHARS - 1 })], { currentSessionId: 's1', now: 2_000 })
      .trigger,
    null,
  );
  assert.equal(
    mod.planSegment([entry('t1', { chars: mod.SEGMENT_MAX_CHARS })], { currentSessionId: 's1', now: 2_000 }).trigger,
    'capacity',
  );
});

test('checklist: enough material and stale — 10 turns past 30 min go, 9 turns or 29 min wait', () => {
  // The starvation this bounds (2026-11-10): the other four rows ask the host for a
  // departure (compress / switch / archive) or a size nobody reaches in an evening's
  // discussion, so a whole afternoon sat in the queue with attempts:0 and 判据 1
  // ("不用重复说") took the hit. This row asserts no topic boundary — it only says
  // "the buffer is old and fat enough, land it" (0028 §5 修订 2026-11-10).
  const now = 10_000_000_000;
  const old = now - mod.SEGMENT_STALE_AFTER_MS - 1;
  const turns = (n, startedAt) => Array.from({ length: n }, (_, i) => entry(`t${i}`, { startedAt }));
  assert.equal(
    mod.planSegment(turns(10, old), { currentSessionId: 's1', now }).trigger,
    'stale',
    '10 轮且超 30 分钟 → 落地上一次',
  );
  assert.equal(
    mod.planSegment(turns(9, old), { currentSessionId: 's1', now }).trigger,
    null,
    '9 轮太薄：不到材料下限就等（材料下限与容量上限是两个数）',
  );
  assert.equal(
    mod.planSegment(turns(10, now - mod.SEGMENT_STALE_AFTER_MS), { currentSessionId: 's1', now }).trigger,
    null,
    '半开边界：恰好 30 分钟不算「超过」（与 24h 年龄同一口径）',
  );
  // The whole buffer leaves, never a prefix: a fatter unit is not a licence to split
  // it (rule 17) — 39 turns at 31 min is one segment, not 10 + 29.
  assert.equal(mod.planSegment(turns(39, old), { currentSessionId: 's1', now }).entries.length, 39);
});

test('checklist: age flushes past 24h; exactly 24h is not "over"', () => {
  const now = 10_000_000_000;
  const edge = now - mod.SEGMENT_MAX_AGE_MS;
  assert.equal(
    mod.planSegment([entry('t1', { startedAt: edge })], { currentSessionId: 's1', now }).trigger,
    null,
    '半开边界：> 24h 才算超龄',
  );
  assert.equal(mod.planSegment([entry('t1', { startedAt: edge - 1 })], { currentSessionId: 's1', now }).trigger, 'age');
});

test('checklist: an empty buffer has no departure', () => {
  assert.deepEqual(mod.planSegment([], { currentSessionId: 's1' }), { entries: [], trigger: null });
});

/* ---------------- 2. compaction/end → marker (wiring) ---------------- */

function fakeCtx() {
  const listeners = {};
  const ctx = {
    effect() {},
    systemPrompt: {
      section() {
        return () => {};
      },
    },
    on(event, fn) {
      listeners[event] = fn;
      return () => {};
    },
    get(name) {
      // The failure path lives behind this: makeLlm resolves the service lazily,
      // and a stream that throws is a failed model call, not an empty answer.
      if (name === 'llm') {
        return {
          stream() {
            throw new Error('upstream down');
          },
        };
      }
      return undefined;
    },
  };
  return { ctx, get listener() { return listeners['session/event']; } };
}

test('compaction/end sets the departure marker; an errored compaction does not', () => {
  const harness = fakeCtx();
  mod.apply(harness.ctx);
  harness.listener({ id: 's9' }, { type: 'compaction/end', data: { compactionId: 'c1', turn: 3 } });
  let state = readState();
  assert.equal(state.marker?.trigger, 'compaction', '压缩结束 = 内容离开窗口');
  assert.equal(state.marker?.session, 's9');
  assert.equal(state.marker?.compactionId, 'c1');
  assert.match(log(), /segment marker: trigger=compaction session=s9/);

  harness.listener({ id: 's9' }, { type: 'compaction/end', data: { compactionId: 'c2', error: 'quota' } });
  state = readState();
  assert.equal(state.marker?.compactionId, 'c1', '压缩失败没有离开窗口，不得留下标记');
  assert.match(log(), /compaction failed \(quota\), window unchanged/);
});

/* ---------------- 3. sealing: a sealed segment is not re-queued ---------------- */

test('seal: a sealed turn is refused; a replay with origin=backfill goes through', () => {
  writeFileSync(
    stateFile,
    JSON.stringify(
      { marker: null, sealed: [{ at: 1, trigger: 'session', turns: 1, chars: 8, outcome: 'ok', turnIds: ['t-sealed'] }] },
      null,
      2,
    ),
    'utf8',
  );
  assert.equal(mod.enqueueExtraction('t-sealed', 1), false, '已封存的轮不再入队（声明 1）');
  assert.match(log(), /already sealed, refused/);
  assert.equal(mod.enqueueExtraction('t-sealed', 2, 'backfill'), true, '重放是记录在案的例外');
  assert.equal(readQueue().length, 1);
  writeFileSync(queueFile, '[]', 'utf8');
});

/* ---------------- 4. marker → drain flushes the same session ---------------- */

test('drain: a compaction marker flushes the same session as one segment', async () => {
  const { openSqlite, Soul } = await import('soulbridge');
  const store = openSqlite(join(home, 'soul.db'));
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'local' });
  const t1 = soul.recordTurnPair({ sessionId: 'live', turn: 1, userText: '压缩前的第一段对话', assistantText: '好' });
  const t2 = soul.recordTurnPair({ sessionId: 'live', turn: 2, userText: '压缩前的第二段对话', assistantText: '好' });
  writeFileSync(
    queueFile,
    JSON.stringify([
      { turnId: t1, turnNo: 1, attempts: 0, origin: 'live' },
      { turnId: t2, turnNo: 2, attempts: 0, origin: 'live' },
    ]),
    'utf8',
  );
  // The marker postdates both rows: they are inside the compacted range.
  writeFileSync(
    stateFile,
    JSON.stringify({ marker: { trigger: 'compaction', session: 'live', at: Date.now() + 60_000, compactionId: 'c9' }, sealed: [] }, null, 2),
    'utf8',
  );

  const done = await mod.drainExtractionQueue({ sessionId: 'live' });
  assert.equal(done, true, '同一会话，仅凭标记就该抽');
  assert.equal(readQueue().length, 0, '整段一次消费');
  assert.match(log(), /segment flush: trigger=compaction turns=2/);
  const state = readState();
  assert.equal(state.marker, null, '标记被这次 flush 花掉');
  assert.equal(state.sealed.at(-1)?.turns, 2);
  store.close();
});

/* ---------------- 5. failure path: three failed calls drop the segment ---------------- */

test('drain: three failed calls seal and drop the segment with its size', async () => {
  const { openSqlite, Soul } = await import('soulbridge');
  // The rows from test 4 (already sealed) are re-seeded straight into the queue:
  // drain must not consult the seals — the writer (enqueue) is where the refusal
  // lives, so a replay script can still drive extraction.
  const store = openSqlite(join(home, 'soul.db'));
  const soul = new Soul({ store, soulId: 'xiaoling', userId: 'local' });
  const rows = soul.recallTurnPairs('', 10).filter((row) => row.sessionId === 'live');
  assert.ok(rows.length >= 2, 'test 4 wrote the rows this test reuses');
  writeFileSync(
    queueFile,
    JSON.stringify(rows.slice(-2).map((row) => ({ turnId: row.id, turnNo: row.turn, attempts: 0, origin: 'live' }))),
    'utf8',
  );

  writeFileSync(join(home, 'plugin-config.json'), JSON.stringify({ extract: 'llm', provider: 't', model: 't' }), 'utf8');
  const harness = fakeCtx();
  mod.apply(harness.ctx); // config is 'llm' now → injectedLlm = the throwing stream

  // Same session, no marker — the departure is the archive set (0028 决定 2 #2),
  // which also puts the drain's archivedSessions wiring under test.
  const trigger = { sessionId: 'live', archivedSessions: ['live'] };

  await mod.drainExtractionQueue(trigger);
  let queue = readQueue();
  assert.equal(queue.length, 2, '失败不消费：规则稿只是地板');
  assert.deepEqual(
    queue.map((item) => item.attempts),
    [1, 1],
    '整个段一起 bump —— 一次调用覆盖它们，尝试次数相同',
  );
  assert.match(log(), /retry segment trigger=archived attempt=1/);

  await mod.drainExtractionQueue(trigger);
  assert.deepEqual(
    readQueue().map((item) => item.attempts),
    [2, 2],
  );

  await mod.drainExtractionQueue(trigger);
  assert.equal(readQueue().length, 0, '三次失败后整段丢弃（规则 15：有上限，说清丢了多少）');
  assert.match(log(), /giving up on segment trigger=archived turns=2 after 3/);
  const outcome = readState().sealed.at(-1)?.outcome ?? '';
  assert.match(outcome, /^given-up:/, '丢弃也封存：后来的回填不能重新入队它');
  assert.match(log(), /llm probe: end fail/, '失败在日志里，不冒充成功');
  store.close();
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
