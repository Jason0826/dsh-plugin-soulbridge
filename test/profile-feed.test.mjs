/**
 * The profile merge queue is fed by classification (ADR 0033).
 *
 * The failure this prevents: the merge stage had no live producer at all. It only
 * ever ran from a hand-seeded queue, so "the profile is maintained" was true only on
 * the days someone remembered to run the script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-feed-'));
process.env.SOULBRIDGE_HOME = home;

const { enqueueProfileCandidate, peekProfileQueue, hasMergeableGroup } = await import('../index.js');

test('feed: a classified profile item enters the merge queue with its dimension', () => {
  assert.equal(
    enqueueProfileCandidate({ id: 'fc_a', statement: '讨厌重复交代', dimension: '沟通偏好' }),
    true,
  );
  const queue = peekProfileQueue();
  assert.deepEqual(queue, [{ id: 'fc_a', statement: '讨厌重复交代', dimension: '沟通偏好' }]);
});

test('feed: the same judgment is not enqueued twice', () => {
  // A retried classification batch must not pile up copies: duplicates inflate the
  // merge input and make the profile look more convinced than it is.
  assert.equal(enqueueProfileCandidate({ id: 'fc_a', statement: '不同的说法', dimension: '工作方式' }), false);
  assert.equal(peekProfileQueue().length, 1);
});

test('feed: two judgments in one dimension become a mergeable group', () => {
  enqueueProfileCandidate({ id: 'fc_b', statement: '先验证再动手', dimension: '工作方式' });
  enqueueProfileCandidate({ id: 'fc_c', statement: '从根本解决', dimension: '工作方式' });
  assert.equal(hasMergeableGroup(peekProfileQueue()), true);
});

test('feed: the classify step is the thing that feeds it', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const classify = source.slice(source.indexOf('async function runClassifyStep'));
  // The queue must be filled by classification, not by a script someone remembers
  // to run: without this call the merge stage has no producer again. The call moved
  // into the routing function (0029), so the assertion follows the chain instead of
  // the old location.
  assert.match(
    classify.slice(0, 3200),
    /applyClassifications\(\s*classified,\s*batch,\s*ensureSoul\(\),?\s*\)/,
  );
  const routing = source.slice(source.indexOf('export function applyClassifications'));
  // Position-free: the routing function is where classification and the merge queue meet,
  // and how many lines of comment sit above that call is not the test's business.
  assert.match(routing, /enqueueProfileCandidate\(/);
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
