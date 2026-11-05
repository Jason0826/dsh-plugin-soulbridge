/**
 * Promotion queue (brief 0023, T1): a corrected turn's lessons become candidates.
 *
 * The failure this prevents: the classification queue had no live producer, so the
 * rule and profile layers only ever updated when someone ran a script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-promote-'));
process.env.SOULBRIDGE_HOME = home;

const { enqueueClassifyCandidate, peekClassifyBatch } = await import('../index.js');

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

test('promote: extraction is what triggers it, and only on a corrected turn', async () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const drain = source.slice(source.indexOf('export async function drainExtractionQueue'));
  // Wiring matters: a promotion function nobody calls is the same empty queue as before.
  // Window 4500 not 3000: the departure checklist and segment build now sit between the
  // signature and the call (0028 ②). The literal `feedClassifyFromTurn(item.turnId)`
  // exists nowhere else in the file, so widening keeps the assertion as tight.
  assert.match(drain.slice(0, 4500), /feedClassifyFromTurn\(item\.turnId\)/);

  const feed = source.slice(source.indexOf('export function feedClassifyFromTurn'));
  const body = feed.slice(0, 1400);
  // The correction is the trigger; without it the turn is ordinary and nothing moves.
  assert.match(body, /wasCorrectedTurn\(turnId\)/);
  assert.match(body, /promotionCandidates\(turnId\)/);
  assert.match(body, /reason: 'T1-修正'/);
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
