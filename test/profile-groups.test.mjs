/**
 * One merge call per dimension (ADR 0033).
 *
 * The failure this prevents: a single call was handed every dimension at once and
 * welded unrelated judgments into one sentence ("以目的实现为准，大胆假设、小心求证").
 * Splitting the batch is structure, so the split lives in code and is tested here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMergeableGroup, describeGroups } from '../index.js';

const item = (id, dimension) => ({ id, statement: `${id} 的判断`, dimension });

test('profile step: a dimension with two judgments is mergeable', () => {
  assert.equal(hasMergeableGroup([item('a', '工作方式'), item('b', '工作方式')]), true);
});

test('profile step: two singletons in two dimensions are not a merge', () => {
  // Merging these would put two lenses back in one call — the very welding the
  // split exists to stop, so the step must stay idle instead.
  assert.equal(hasMergeableGroup([item('a', '工作方式'), item('b', '沟通偏好')]), false);
});

test('profile step: unlabelled judgments do not merge with each other', () => {
  // They have no dimension yet. Guessing one to fill a batch is invention.
  assert.equal(hasMergeableGroup([item('a', ''), item('b', undefined)]), false);
});

test('profile step: the queue is reported per dimension, in one line', () => {
  const groups = [
    { dimension: '工作方式', items: [1, 2, 3] },
    { dimension: '', items: [1] },
  ];
  assert.equal(describeGroups(groups), '工作方式:3,未标注:1');
});
