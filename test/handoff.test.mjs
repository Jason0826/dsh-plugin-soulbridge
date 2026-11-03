/**
 * The handoff block is the answer to "where were we", and the design says that
 * means the last *topic* that finished — not the previous session, which can hold
 * several topics or none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHandoff } from '../index.js';

const sample = {
  thread: { id: 'th_a', sessionId: 'session-old', topic: '记忆如何影响行为', closedAt: Date.parse('2026-11-02T00:30:00Z') },
  conclusion: { statement: '用户要求先有机制再有实现' },
  turns: [
    { turnNo: 7, userText: '那先记录吧' },
    { turnNo: 9, userText: '做吧' },
  ],
};

test('handoff: a topic from another session becomes a block', () => {
  const block = renderHandoff(sample, 'session-new');
  assert.match(block, /<handoff topic="记忆如何影响行为" closed="2026-11-02">/);
  assert.match(block, /上次的结论：用户要求先有机制再有实现/);
  assert.match(block, /9\. 用户：做吧/);
  assert.match(block, /<\/handoff>/);
});

test('handoff: the same session gets nothing, because that topic is still in view', () => {
  assert.equal(renderHandoff(sample, 'session-old'), '');
});

test('handoff: no closed topic means no block', () => {
  assert.equal(renderHandoff(null, 'session-new'), '');
});

test('handoff: a thread without a conclusion still hands over its turns', () => {
  const block = renderHandoff({ ...sample, conclusion: null }, 'session-new');
  assert.doesNotMatch(block, /上次的结论/);
  assert.match(block, /7\. 用户：那先记录吧/);
});

test('handoff: both sides of the turn are carried (ADR 0035)', () => {
  const block = renderHandoff(
    {
      thread: { sessionId: 'session-old', topic: '定方案', closedAt: Date.now() },
      conclusion: null,
      turns: [{ turnNo: 5, userText: '用哪个方案', assistantText: '用 in-history，因为 section 会每轮变' }],
    },
    'session-new',
  );
  assert.match(block, /5\. 用户：用哪个方案/);
  assert.match(block, /5\. 我：用 in-history/);
});

test('handoff: user words go in whole — no prefix cuts', () => {
  const longUser = '我把注入块里的线索原文都保留下来，因为截断会让后面的判断失去依据，尤其是最后一句往往才是结论';
  const block = renderHandoff(
    {
      thread: { sessionId: 'session-old', topic: '一个相当长的主题标题用在交接块里也应该完整出现', closedAt: Date.now() },
      conclusion: null,
      turns: [{ turnNo: 3, userText: longUser }],
    },
    'session-new',
  );
  assert.ok(block.includes(longUser), '整句都在');
  assert.ok(block.includes(longUser.slice(-6)), '结尾没有被切掉');
  assert.match(block, /topic="一个相当长的主题标题用在交接块里也应该完整出现"/);
});
