/**
 * T1 end to end, against a real database file (brief 0023).
 *
 * The unit test proves the queue accepts a candidate; this one proves the path the
 * plugin actually runs: turn → correction → flagged fact → queue. Without it, a
 * wrong id, a wrong home, or a wrong gate would look fine in unit tests and silently
 * promote nothing in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-promote-e2e-'));
process.env.SOULBRIDGE_HOME = home;

const { openSqlite, Soul } = await import('soulbridge');
const { feedClassifyFromTurn, peekClassifyBatch } = await import('../index.js');

test('T1: a corrected turn promotes its flagged lesson into the classify queue', () => {
  // Same identity the plugin resolves from config, or it would open a different db.
  const scope = { soulId: 'xiaoling', userId: 'local' };
  const store = openSqlite(join(home, 'soul.db'));
  const soul = new Soul({ store, ...scope });
  const at = Date.parse('2026-11-02T13:00:00Z');

  store.putTurn({
    ...scope,
    id: 't1',
    sessionId: 'sess',
    turnNo: 1,
    startedAt: at,
    userText: '不对，以后改动前先说影响再动手',
    steps: [],
  });
  store.putFact({
    ...scope,
    id: 'f_lesson',
    statement: '改动前先说明影响面再动手',
    sourceTurnId: 't1',
    at,
    typeName: '要求',
    holder: 'world',
    slots: [{ slot: '原则候选', value: { kind: 'text', value: '是' } }],
  });
  store.putFact({
    ...scope,
    id: 'f_plain',
    statement: '用户今天把配置文件的读取顺序调整了一下',
    sourceTurnId: 't1',
    at,
    typeName: '修改',
    holder: 'world',
  });

  // Before the correction the turn is ordinary: nothing is promoted.
  assert.equal(feedClassifyFromTurn('t1'), 0);
  assert.equal(peekClassifyBatch().length, 0);

  soul.recordCorrection({ userText: '不对，以后改动前先说影响再动手', assistantText: '好' });

  const added = feedClassifyFromTurn('t1');
  assert.equal(added, 1, 'exactly one candidate, not every fact of the turn');
  const batch = peekClassifyBatch();
  assert.deepEqual(batch.map((item) => item.id), ['f_lesson']);
  assert.equal(batch[0].reason, 'T1-修正');
  // Re-running must not duplicate: the drain can retry the same turn.
  assert.equal(feedClassifyFromTurn('t1'), 0);
  assert.equal(peekClassifyBatch().length, 1);
  store.close();
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
