/**
 * Rule injection (ADR 0033): the block appears only when a rule fires, and the
 * session counters it can key on are explicit rather than guessed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuleState, renderRulesBlock } from '../index.js';

test('rules block: empty selection produces no block at all', () => {
  assert.equal(renderRulesBlock([]), '');
  assert.equal(renderRulesBlock(null), '');
});

test('rules block: fired rules are rendered as requirements with their ids', () => {
  const block = renderRulesBlock([
    { id: 'fc_a', statement: '用 edit 工具改 JSON，不要用字符串替换' },
  ]);
  assert.match(block, /<rules fired="fc_a">/);
  assert.match(block, /- 用 edit 工具改 JSON/);
  assert.match(block, /<\/rules>$/);
});

test('rule state: long-session is a counter, not a guess', () => {
  assert.equal(buildRuleState({ turn: 150 })['long-session'], true);
  assert.equal(buildRuleState({ turn: 5 })['long-session'], false);
  assert.equal(buildRuleState({})['long-session'], false);
  assert.equal(buildRuleState({ turn: 'x' })['long-session'], false);
});
