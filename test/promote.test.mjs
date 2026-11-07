/**
 * Promotion queue (brief 0018 §九 3 A, 拍板 b): every lesson enters, bucketed.
 *
 * The failure this prevents: the classification queue had one narrow producer (a
 * corrected turn) and one narrow writer (the 原则候选 flag), so a lesson nobody ever
 * corrected — or one the model roled itself — never reached the classifier at all.
 * The queue is now open, and the bucket keeps the correction signal from drowning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-promote-'));
process.env.SOULBRIDGE_HOME = home;

const { enqueueClassifyCandidate, peekClassifyBatch, reBucketQueuedCandidate } = await import('../index.js');

test('promote: a candidate enters the queue with the reason that put it there', () => {
  assert.equal(
    enqueueClassifyCandidate({ id: 'fc_a', statement: '改动前先说明影响', reason: 'T1-修正' }),
    true,
  );
  assert.deepEqual(peekClassifyBatch(), [
    { id: 'fc_a', statement: '改动前先说明影响', reason: 'T1-修正' },
  ]);
});

test('promote: the same lesson is not queued twice', () => {
  assert.equal(
    enqueueClassifyCandidate({ id: 'fc_a', statement: '改动前先说明影响', reason: 'T1-修正' }),
    false,
  );
  assert.equal(peekClassifyBatch().length, 1);
});

test('promote: buckets are drained strongest first, arrival order kept inside a bucket', () => {
  enqueueClassifyCandidate({ id: 'fc_bulk_1', statement: '全收一', reason: '全收' });
  enqueueClassifyCandidate({ id: 'fc_bulk_2', statement: '全收二', reason: '全收' });
  enqueueClassifyCandidate({ id: 'fc_backlog', statement: '存量', reason: '存量' });
  enqueueClassifyCandidate({ id: 'fc_corrected', statement: '被纠正', reason: 'T1-修正' });
  // A correction can arrive after the lesson was queued as 全收: the reason is
  // rewritten in place, not duplicated.
  assert.equal(reBucketQueuedCandidate('fc_bulk_1', 'T1-修正'), true);
  assert.equal(reBucketQueuedCandidate('fc_bulk_1', 'T1-修正'), false);
  assert.deepEqual(
    peekClassifyBatch().map((item) => item.id),
    // Within a bucket the arrival order is kept, so the re-bucketed item stays where
    // it was queued; only the bucket changes.
    ['fc_a', 'fc_bulk_1', 'fc_corrected', 'fc_bulk_2', 'fc_backlog'],
  );
});

test('promote: extraction feeds the queue, and a correction backfills it', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const drain = source.slice(source.indexOf('export async function drainExtractionQueue'));
  // Wiring matters: a promotion function nobody calls is the same empty queue as before.
  // Window 4500 not 3000: the departure checklist and segment build now sit between the
  // signature and the call (0028 ②). The literal `feedClassifyFromTurn(item.turnId)`
  // exists nowhere else in the file, so widening keeps the assertion as tight.
  assert.match(drain.slice(0, 4500), /feedClassifyFromTurn\(item\.turnId\)/);

  const feed = source.slice(source.indexOf('export function feedClassifyFromTurn'));
  const body = feed.slice(0, 1800);
  // Both buckets, and no gate: the correction decides the bucket, not whether the
  // lesson is queued at all.
  assert.match(body, /wasCorrectedTurn\(turnId\) \? 'T1-修正' : '全收'/);
  assert.match(body, /promotionCandidates\(turnId\)/);
  assert.doesNotMatch(body, /if \(!soul\.wasCorrectedTurn\(turnId\)\) return 0/);

  // Late corrections: the hook must call the backfill once the correction is stored.
  const recorded = source.slice(source.indexOf('correction recorded:'));
  assert.match(recorded.slice(0, 600), /backfillClassifyFromCorrection\(\{ userText: text, assistantText: lastAssistantText \}\)/);
  // The backlog pass is the same one-shot contract as extraction's.
  const userBranch = source.slice(source.indexOf("if (kind === 'user') {"));
  assert.match(userBranch.slice(0, 400), /backfillClassifyBacklog\(\)/);
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
