/**
 * The stage chain: one model call per step, first stage that actually worked wins.
 *
 * This exists because of a real bug: a stage returned `true` on a skip (a thread
 * with too few facts), which told the chain "the call was used" when no model call
 * had been made. The classifier behind it sat idle for an hour while its queue
 * never moved. Each stage's own unit tests passed — the contract between stages was
 * never tested, because it was an `if` in the middle of a handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStageChain } from '../index.js';

test('chain: stages run in order and stop at the first one that did work', async () => {
  const calls = [];
  const stage = (name, result) => async () => {
    calls.push(name);
    return result;
  };
  const worked = await runStageChain([stage('a', false), stage('b', true), stage('c', true)]);
  assert.equal(worked, true);
  assert.deepEqual(calls, ['a', 'b'], 'the third stage must not run');
});

test('chain: a skip hands the call to the next stage', async () => {
  // The bug in one line: b reports "nothing done", c must still get its turn.
  const calls = [];
  const worked = await runStageChain([
    async () => {
      calls.push('extract');
      return false;
    },
    async () => {
      calls.push('consolidate-skip');
      return false;
    },
    async () => {
      calls.push('classify');
      return true;
    },
  ]);
  assert.equal(worked, true);
  assert.deepEqual(calls, ['extract', 'consolidate-skip', 'classify']);
});

test('chain: nothing to do is reported, not thrown', async () => {
  const worked = await runStageChain([async () => false, async () => false]);
  assert.equal(worked, false);
});
