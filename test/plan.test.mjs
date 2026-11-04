/**
 * The injection policy follows the retrieval plan (0020 §4).
 *
 * When a question names a subject, the entity timeline is the answer and the
 * related-pairs search is contamination — that is exactly how "上次和 a 吃饭" gets
 * answered with something about b. So the two blocks are mutually exclusive.
 *
 * A time question is not exclusive: the window block answers "what happened last
 * week", and the relevance block stays because relative/unknown facts and
 * not-yet-extracted conversation must still surface (0027 §八).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBlocks } from '../index.js';

const noWindow = { related: true, timeline: false, window: false };

test('planBlocks: an entity question takes the timeline and drops related pairs', () => {
  assert.deepEqual(planBlocks({ primitive: 'entity', subject: 'a' }), { related: false, timeline: true, window: false });
});

test('planBlocks: continuity and time questions keep the relevance search', () => {
  assert.deepEqual(planBlocks({ primitive: 'continuity' }), noWindow);
  assert.deepEqual(planBlocks({ primitive: 'time' }), noWindow);
});

test('planBlocks: a time question with a resolved window turns the window block on', () => {
  assert.deepEqual(planBlocks({ primitive: 'time', window: { from: 1, to: 2, cue: '上周' } }), {
    related: true,
    timeline: false,
    window: true,
  });
});

test('planBlocks: a failed plan degrades to relevance, never to a wrong subject', () => {
  assert.deepEqual(planBlocks(null), noWindow);
});
