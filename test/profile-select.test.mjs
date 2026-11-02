/**
 * Profile selection by dimension (ADR 0033): core always, facets only when relevant.
 *
 * The failure this prevents: nine work-style lines injected on every turn, so the
 * profile reads like a colleague's CV no matter what the conversation is about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectProfileFacts } from '../index.js';

const fact = (statement, dimension) => ({
  id: statement,
  statement,
  slots: dimension ? [{ slot: '维度', value: { kind: 'text', value: dimension } }] : [],
});

const profile = [
  fact('思想比落地更宝贵', '价值观'),
  fact('从根本架构入手，不兜底', '工作方式'),
  fact('讨厌重复交代', '沟通偏好'),
  fact('累了先接住，不推任务', '情绪'),
  fact('她最近怎么样要问', '人际关系'),
  fact('喜欢爬山', '生活兴趣'),
  fact('不许把原文截断', '边界'),
  fact('先验证再动手', ''), // written before dimensions existed
];

test('profile: core and unlabelled lines are always injected', () => {
  const picked = selectProfileFacts(profile, '今天天气不错');
  assert.deepEqual(
    picked.map((item) => item.statement),
    ['思想比落地更宝贵', '先验证再动手'],
  );
});

test('profile: a work message brings the work facet, not the rest', () => {
  const picked = selectProfileFacts(profile, '这个接口要不要重构一下');
  const statements = picked.map((item) => item.statement);
  assert.ok(statements.includes('从根本架构入手，不兜底'));
  assert.ok(!statements.includes('喜欢爬山'));
  assert.ok(!statements.includes('她最近怎么样要问'));
});

test('profile: an emotional message brings the emotional facet', () => {
  const picked = selectProfileFacts(profile, '今天好累啊');
  const statements = picked.map((item) => item.statement);
  assert.ok(statements.includes('累了先接住，不推任务'));
  assert.ok(!statements.includes('从根本架构入手，不兜底'));
});
