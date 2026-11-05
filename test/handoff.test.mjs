/**
 * The handoff block is the answer to "where were we", and the design says that
 * means the last *topic* that finished — not the previous session, which can hold
 * several topics or none.
 *
 * The consumption contract (0028 decision 4: handoff is a render, not a
 * one-shot trigger): a session gets at most ONE non-empty block, and only a
 * non-empty read consumes it — the first turn may read empty because the
 * previous segment has not been flushed yet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHandoff, createHandoffTaker } from '../index.js';

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

test('handoff: an empty first read does not consume the session (0028 §4)', () => {
  const shots = [
    { block: '' },
    { block: '<handoff topic="上一段" closed="2026-11-05"></handoff>', topic: '上一段', thread: 'th_x', summary: true },
  ];
  const take = createHandoffTaker(() => shots.shift() ?? { block: '' }, () => {}, () => {});
  assert.equal(take('s1'), '', '第 1 轮可能读空（上一段还没抽完）');
  assert.match(take('s1'), /<handoff/, '空读不许消费：拿到后仍要发');
  assert.equal(take('s1'), '', '发过一次就封口——每会话至多一条非空');
});

test('handoff: a throwing read is retried, never forfeited', () => {
  let calls = 0;
  const take = createHandoffTaker(
    () => {
      if (calls++ === 0) throw new Error('db busy');
      return { block: '<handoff topic="t" closed="2026-11-05"></handoff>', topic: 't', thread: 'th', summary: false };
    },
    () => {},
    () => {},
  );
  assert.equal(take('s1'), '');
  assert.match(take('s1'), /<handoff/, '瞬时失败下一轮重试');
});

test('handoff: separate sessions do not share the one-shot state', () => {
  const take = createHandoffTaker(
    () => ({ block: '<handoff topic="永远有" closed="2026-11-05"></handoff>', topic: '永远有', thread: 'th', summary: false }),
    () => {},
    () => {},
  );
  assert.match(take('s2'), /<handoff/);
  assert.equal(take('s2'), '');
  assert.match(take('s3'), /<handoff/, '每个会话各一次');
});
