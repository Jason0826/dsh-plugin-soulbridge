/**
 * The extraction queue has one writer, a cap, and says how much the cap dropped.
 *
 * A batch of 108 turns once vanished without a trace: it was written from outside this
 * writer, so up to 58 were capped away and nothing recorded it. These tests pin the
 * contract that makes any future loss visible: dedupe by turn id, cap keeps the newest,
 * and the file is exactly what the writer reported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'soulbridge-extract-queue-'));
process.env.SOULBRIDGE_HOME = home;
const mod = await import(`../index.js?extract-queue=${Date.now()}`);

const queueFile = join(home, 'pending-extract.json');
const readQueue = () => JSON.parse(readFileSync(queueFile, 'utf8'));

test('extract queue: enqueue adds one item and reports whether it was new', () => {
  assert.equal(mod.enqueueExtraction('t1', 1), true);
  assert.equal(mod.enqueueExtraction('t2', 2), true);
  assert.equal(mod.enqueueExtraction('t1', 1), false, '同一轮不重复入队');
  assert.equal(readQueue().length, 2);
  assert.deepEqual(
    readQueue().map((item) => item.turnId),
    ['t1', 't2'],
  );
});

test('extract queue: the cap keeps the newest work', () => {
  writeFileSync(queueFile, '[]', 'utf8');
  for (let i = 0; i < 60; i += 1) mod.enqueueExtraction(`cap-${i}`, i);
  const queue = readQueue();
  // Keep-newest is deliberate: the turns just added are the ones still in the user's
  // head, and the old implementation kept the oldest and dropped those instead.
  assert.equal(queue.length, 50);
  assert.equal(queue[0].turnId, 'cap-10', '前 10 条被丢弃，保留最新的 50');
  assert.equal(queue.at(-1).turnId, 'cap-59');
});

test('extract queue: an item remembers where it came from', () => {
  writeFileSync(queueFile, '[]', 'utf8');
  mod.enqueueExtraction('t-live', 1);
  mod.enqueueExtraction('t-back', 2, 'backfill');
  const queue = readQueue();
  assert.equal(queue[0].origin, 'live', '默认是实时轮次');
  assert.equal(queue[1].origin, 'backfill', '回填必须可区分，否则会污染实验样本');
});

test('extract queue: live work is picked before history, whatever the order', () => {
  // FIFO alone would put backfill items first: the queue is filled oldest-first, and a
  // live turn appended later would wait behind every historical turn.
  const queue = [
    { turnId: 'b1', origin: 'backfill' },
    { turnId: 'b2', origin: 'backfill' },
    { turnId: 'l1', origin: 'live' },
  ];
  assert.equal(mod.pickExtractionItem(queue).turnId, 'l1');
  assert.equal(mod.pickExtractionItem([{ turnId: 'b1', origin: 'backfill' }]).turnId, 'b1', '没有实时活时才做历史');
  assert.equal(mod.pickExtractionItem([]), null);
});

test('extract queue: a backfill backlog never starves consolidation', () => {
  const backfillOnly = [{ turnId: 'b1', origin: 'backfill' }];
  // With history waiting and a closed thread to understand, consolidation goes first.
  assert.equal(mod.extractRunsFirst(backfillOnly, true), false);
  // Live conversation always goes first, even when consolidation is waiting.
  assert.equal(mod.extractRunsFirst([{ turnId: 'l1', origin: 'live' }], true), true);
  // Nothing waiting to consolidate: extraction may proceed on history.
  assert.equal(mod.extractRunsFirst(backfillOnly, false), true);
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
