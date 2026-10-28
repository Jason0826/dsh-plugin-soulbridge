import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-'));
process.env.SOULBRIDGE_HOME = home;

const { apply, name, inject, textOf, VERSION } = await import('../index.js');

function fakeCtx() {
  const calls = [];
  let section;
  let listener;
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
      listener = fn;
      return () => {};
    },
  };
  return { ctx, calls, get section() { return section; }, get listener() { return listener; }, get disposer() { return disposer; } };
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
