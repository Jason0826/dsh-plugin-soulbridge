/**
 * The injection policy follows the retrieval plan (0020 §4).
 *
 * When a question names a subject, the entity timeline is the answer and the
 * related-pairs search is contamination — that is exactly how "上次和 a 吃饭" gets
 * answered with something about b. So the two blocks are mutually exclusive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBlocks } from '../index.js';

test('planBlocks: an entity question takes the timeline and drops related pairs', () => {
  assert.deepEqual(planBlocks({ primitive: 'entity', subject: 'a' }), { related: false, timeline: true });
});

test('planBlocks: continuity and time questions keep the relevance search', () => {
  assert.deepEqual(planBlocks({ primitive: 'continuity' }), { related: true, timeline: false });
  assert.deepEqual(planBlocks({ primitive: 'time' }), { related: true, timeline: false });
});

test('planBlocks: a failed plan degrades to relevance, never to a wrong subject', () => {
  assert.deepEqual(planBlocks(null), { related: true, timeline: false });
});
