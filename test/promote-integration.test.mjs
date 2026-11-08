/**
 * Promotion end to end, against a real database file (brief 0018 §九 3 A, 拍板 b).
 *
 * The unit tests prove the queue accepts a candidate and orders buckets; this one
 * proves the path the plugin actually runs: turn → lesson → queue, with the bucket
 * the turn earned, and the late correction that re-buckets a lesson already queued.
 * Without it a wrong id, a wrong home or a wrong gate would look fine in unit tests
 * and silently promote nothing in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-promote-e2e-'));
process.env.SOULBRIDGE_HOME = home;

const { openSqlite, Soul } = await import('soulbridge');
const { feedClassifyFromTurn, peekClassifyBatch, backfillClassifyFromCorrection, commitClassifyBatch, backfillClassifyBacklog } =
  await import('../index.js');

const scope = { soulId: 'xiaoling', userId: 'local' };

function seed({ turnId, turnNo, userText, assistantText, lesson, at }) {
  const store = openSqlite(join(home, 'soul.db'));
  const soul = new Soul({ store, ...scope });
  store.putTurn({
    ...scope,
    id: turnId,
    sessionId: 'sess',
    turnNo,
    startedAt: at,
    userText,
    assistantText,
    steps: [],
  });
  store.putFact({
    ...scope,
    id: `f_${turnId}`,
    statement: lesson,
    sourceTurnId: turnId,
    at,
    typeName: '要求',
    holder: 'world',
    // The structured form of "this is a lesson to classify": role + status, not a slot.
    role: 'lesson',
    status: 'candidate',
  });
  return { store, soul };
}

test('promote: an ordinary turn is queued too, and a corrected one is bucketed first', () => {
  const first = seed({
    turnId: 't1',
    turnNo: 1,
    userText: '今天继续做第二刀',
    assistantText: '好',
    lesson: '改动前先说明影响面再动手',
    at: Date.parse('2026-11-07T10:00:00Z'),
  });
  // No correction: the turn is ordinary. It used to be invisible to the queue.
  assert.equal(feedClassifyFromTurn('t1'), 1);
  assert.deepEqual(peekClassifyBatch().map((item) => [item.id, item.reason]), [
    ['f_t1', '全收'],
  ]);
  // Re-running must not duplicate: the drain can retry the same turn.
  assert.equal(feedClassifyFromTurn('t1'), 0);
  first.store.close();

  const second = seed({
    turnId: 't2',
    turnNo: 2,
    userText: '不对，先说影响再动手',
    assistantText: '明白',
    lesson: '说服之前先量化代价',
    at: Date.parse('2026-11-07T10:05:00Z'),
  });
  second.soul.recordCorrection({ userText: '不对，先说影响再动手', assistantText: '明白' });
  assert.equal(feedClassifyFromTurn('t2'), 1);
  const batch = peekClassifyBatch();
  // The corrected lesson is first even though it arrived second: the bucket decides.
  assert.deepEqual(batch.map((item) => [item.id, item.reason]), [
    ['f_t2', 'T1-修正'],
    ['f_t1', '全收'],
  ]);
  second.store.close();
});

test('promote: a correction that arrives late re-buckets the lesson it points at', () => {
  const { store, soul } = seed({
    turnId: 't3',
    turnNo: 3,
    userText: 'SQLite 的 date() 把数字当儒略日',
    assistantText: '记下了',
    lesson: '别用 date(<epoch秒>) 转日期',
    at: Date.parse('2026-11-07T10:10:00Z'),
  });
  // Queued as 全收 first: at that moment nobody had corrected anything.
  assert.equal(feedClassifyFromTurn('t3'), 1);
  assert.equal(peekClassifyBatch().find((item) => item.id === 'f_t3').reason, '全收');

  // The correction lands afterwards — the blind spot this backfill exists for.
  soul.recordCorrection({ userText: 'SQLite 的 date() 把数字当儒略日', assistantText: '记下了' });
  const result = backfillClassifyFromCorrection({
    userText: 'SQLite 的 date() 把数字当儒略日',
    assistantText: '记下了',
  });
  assert.equal(result.turns, 1);
  assert.equal(result.reBucketed, 1);
  // One row, not two: the reason changed, the item did not.
  assert.equal(peekClassifyBatch().filter((item) => item.id === 'f_t3').length, 1);
  assert.equal(peekClassifyBatch().find((item) => item.id === 'f_t3').reason, 'T1-修正');

  // A parked lesson (待修 → candidate again) gets a second pass from the correction:
  // the classifier consumed the queue item, the row stayed a candidate.
  commitClassifyBatch(['f_t3']);
  store.setFactStatus('f_t3', 'candidate');
  const again = backfillClassifyFromCorrection({
    userText: 'SQLite 的 date() 把数字当儒略日',
    assistantText: '记下了',
  });
  assert.equal(again.queued, 1);
  store.close();
});

test('promote: a correction with no matching turn is a no-op, not a guess', () => {
  const result = backfillClassifyFromCorrection({ userText: '从来没有说过这句话', assistantText: '也没有这句' });
  assert.deepEqual(result, { turns: 0, queued: 0, reBucketed: 0 });
});

test('promote: the backlog pass is one per inventory, so a new candidate re-opens it', () => {
  // Two lessons nobody ever corrected: this is the 存量 shape (0018 §九 3 A).
  for (const [turnId, turnNo, lesson] of [
    ['t10', 10, '先验证再动手'],
    ['t11', 11, '改动完看一遍 diff'],
  ]) {
    const { store } = seed({
      turnId,
      turnNo,
      userText: `第 ${turnNo} 轮`,
      assistantText: '好',
      lesson,
      at: Date.parse('2026-11-07T11:00:00Z'),
    });
    store.close();
  }
  assert.equal(backfillClassifyBacklog(), 2);
  assert.deepEqual(
    peekClassifyBatch()
      .filter((item) => item.reason === '存量')
      .map((item) => item.id)
      .sort(),
    ['f_t10', 'f_t11'],
  );
  // The same inventory answers 0: the pass is not billed twice for a restart.
  assert.equal(backfillClassifyBacklog(), 0);
  // A candidate that appears *after* the pass without a drained turn is exactly the
  // shape a migration leaves behind (schema v17 demotes rules that cannot fire). The
  // marker remembers which inventory it drained, so this one is not lost; a bare
  // "done" flag passed the assertion above and dropped this row forever.
  const late = seed({
    turnId: 't12',
    turnNo: 12,
    userText: '第 12 轮',
    assistantText: '好',
    lesson: '发布前先看 diff',
    at: Date.parse('2026-11-07T11:05:00Z'),
  });
  late.store.close();
  assert.equal(backfillClassifyBacklog(), 1, 'a new candidate re-opens the pass');
  assert.equal(peekClassifyBatch().some((item) => item.id === 'f_t12'), true);
  // ...and once it is in, the inventory is drained again.
  assert.equal(backfillClassifyBacklog(), 0);
});

test('promote: a rule the model roled itself waits in the queue, not in the rule layer', () => {
  const store = openSqlite(join(home, 'soul.db'));
  const soul = new Soul({ store, ...scope });
  store.putTurn({
    ...scope,
    id: 't20',
    sessionId: 'sess',
    turnNo: 20,
    startedAt: Date.parse('2026-11-07T10:20:00Z'),
    userText: '历史事件的有效期到发生时刻为止',
    assistantText: '好',
    steps: [],
  });
  // `角色=rule` from the extractor: a rule is only a rule once a 触发 slot exists,
  // and the classifier writes that. Written active it was counted in the layer,
  // injected nowhere, and invisible as debt (0018 §九 3 B).
  const fact = soul.recordFact({
    ...scope,
    statement: '用户认为历史事件的 valid_until 应等于事件发生时间',
    role: 'rule',
    sourceTurnId: 't20',
  });
  assert.equal(fact.status, 'candidate');
  assert.deepEqual(soul.rules(), [], 'no trigger, no rule layer');
  assert.equal(feedClassifyFromTurn('t20'), 1, 'the queue takes it by status, not by role');
  assert.equal(peekClassifyBatch().find((item) => item.id === fact.id).reason, '全收');
  store.close();
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
