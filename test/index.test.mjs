import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-'));
process.env.SOULBRIDGE_HOME = home;

const { apply, name, inject, textOf, VERSION, collectText, createPreStepHandler } = await import('../index.js');

function fakeCtx() {
  const calls = [];
  let section;
  const listeners = {};
  let disposer;
  const ctx = {
    effect(fn, label) {
      calls.push(['effect', label]);
      disposer = fn();
    },
    systemPrompt: {
      section(definition) {
        calls.push(['section', definition.name, definition.order]);
        section = definition;
        return () => {};
      },
    },
    on(event, fn) {
      calls.push(['on', event]);
      listeners[event] = fn;
      return () => {};
    },
  };
  return {
    ctx,
    calls,
    get section() { return section; },
    get listener() { return listeners['session/event']; },
    get disposeListener() { return listeners['session/disposed']; },
    get disposer() { return disposer; },
  };
}

test('VERSION 与 package.json 同步', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('plugin identity: name + inject', () => {
  assert.equal(name, 'dsh-plugin-soulbridge');
  assert.deepEqual(inject, ['systemPrompt']);
});

test('registers section, listener and effect', () => {
  const harness = fakeCtx();
  apply(harness.ctx);

  assert.deepEqual(harness.calls, [
    ['effect', 'soulbridge.lifecycle'],
    ['section', 'soulbridge', 10],
    ['on', 'agent/pre-step'],
    ['on', 'session/event'],
  ]);
  const injected = harness.section.text();
  assert.match(injected, /<soul /, '注入的是 core 生成的真实上下文');
  assert.ok(!injected.includes('spike'), '占位标记已被替换');
});

test('section text is dynamic (evaluated per assembly)', () => {
  const harness = fakeCtx();
  apply(harness.ctx);
  assert.equal(typeof harness.section.text, 'function');
  const first = harness.section.text();
  const second = harness.section.text();
  assert.equal(first, second);
});

test('session/event listener logs type and payload keys', () => {
  const harness = fakeCtx();
  apply(harness.ctx);

  harness.listener({ id: 's1' }, { type: 'assistant/message', data: { content: 'yo' } });
  harness.listener({ id: 's1' }, { type: 'tool/call', data: { name: 'read' } });

  const log = readFileSync(join(home, 'plugin.log'), 'utf8');
  assert.match(log, /session\/event type=assistant\/message/);
  assert.match(log, /dataKeys=\[content\]/);
  assert.match(log, /sessionKeys=\[id\]/);
  assert.match(log, /type=assistant\/message/);
});

test('textOf: 只取 text block，其他块忽略', () => {
  assert.equal(
    textOf([
      { type: 'text', text: '第一段' },
      { type: 'image', url: 'x' },
      { type: 'text', text: '第二段' },
    ]),
    '第一段\n第二段',
  );
  assert.equal(textOf('纯字符串'), '纯字符串');
  assert.equal(textOf(undefined), '');
  assert.equal(textOf([{ type: 'image' }]), '');
});

test('disposer runs on unload and is logged', () => {
  const harness = fakeCtx();
  apply(harness.ctx);
  harness.disposer();
  const log = readFileSync(join(home, 'plugin.log'), 'utf8');
  assert.match(log, /effect disposed/);
});

test('a broken service does not stop the other registrations', () => {
  const calls = [];
  const ctx = {
    effect() {
      throw new Error('no effect');
    },
    systemPrompt: {
      section(definition) {
        calls.push(definition.name);
      },
    },
    on() {},
  };
  apply(ctx);
  assert.deepEqual(calls, ['soulbridge']);
  const log = readFileSync(join(home, 'plugin.log'), 'utf8');
  assert.match(log, /effect registration failed: no effect/);
});

test.after(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows keeps SQLite handles open */ } });
test('collectText: text-delta and block-end are not double counted', async () => {
  async function* stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '{"type":' };
    yield { type: 'text-delta', index: 0, text: '"null"}' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"type":"null"}' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  assert.equal(await collectText(stream()), '{"type":"null"}');
});

test('collectText: block-end alone is used as the whole text', async () => {
  async function* stream() {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"type":"fact"}' } };
  }
  assert.equal(await collectText(stream()), '{"type":"fact"}');
});test('pre-step: one injection per turn, retries included', async () => {
  const handler = createPreStepHandler({ getContext: () => 'MEMORY-BLOCK' });
  const next = async () => ({ kind: 'enter', messages: [] });
  const payload = {
    agent: { id: 'agent-1' },
    turn: 7,
    step: 1,
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  };

  const first = await handler(payload, next);
  assert.equal(first.messages.length, 1, 'first step injects');
  const second = await handler({ ...payload, step: 2 }, next);
  assert.equal(second.messages.length, 0, 'second step of the same turn is skipped');
  const retry = await handler({ ...payload, step: 1 }, next);
  assert.equal(retry.messages.length, 0, 'a retried step does not inject again');
});

test('pre-step: injected message is not marked as a human message', async () => {
  const handler = createPreStepHandler({ getContext: () => 'MEMORY-BLOCK' });
  const next = async () => ({ kind: 'enter', messages: [] });
  const result = await handler(
    { agent: { id: 'a2' }, turn: 1, messages: [{ content: [{ type: 'text', text: 'hi' }] }] },
    next,
  );
  assert.equal(result.messages[0].source.kind, 'memory-context');
  assert.match(result.messages[0].id, /^memctx_/);
});

test('pre-step: an empty block adds nothing', async () => {
  const handler = createPreStepHandler({ getContext: () => '' });
  const next = async () => ({ kind: 'enter', messages: [] });
  const result = await handler(
    { agent: { id: 'a3' }, turn: 1, messages: [{ content: [{ type: 'text', text: 'hi' }] }] },
    next,
  );
  assert.equal(result.messages.length, 0);
});

test('pre-step: a throwing lookup never breaks the turn', async () => {
  const handler = createPreStepHandler({ getContext: () => { throw new Error('db down'); } });
  const next = async () => ({ kind: 'enter', messages: [] });
  const result = await handler(
    { agent: { id: 'a4' }, turn: 1, messages: [{ content: [{ type: 'text', text: 'hi' }] }] },
    next,
  );
  assert.deepEqual(result, { kind: 'enter', messages: [] });
});

test('pre-step: rejected decisions are left alone', async () => {
  let called = false;
  const handler = createPreStepHandler({ getContext: () => { called = true; return 'X'; } });
  const result = await handler({ agent: { id: 'a5' }, turn: 1, messages: [] }, async () => ({ kind: 'reject' }));
  assert.deepEqual(result, { kind: 'reject' });
  assert.equal(called, false, 'no lookup when the step is not entered');
});