import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-'));
process.env.SOULBRIDGE_HOME = home;

const { apply, name, inject, MARKER } = await import('../index.js');

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
  assert.equal(harness.section.text(), MARKER);
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

  harness.listener({ id: 's1' }, { type: 'user/message', data: { content: 'hi' } });
  harness.listener({ id: 's1' }, { type: 'assistant/message', data: { content: 'yo' } });

  const log = readFileSync(join(home, 'plugin.log'), 'utf8');
  assert.match(log, /session\/event type=user\/message/);
  assert.match(log, /dataKeys=\[content\]/);
  assert.match(log, /sessionKeys=\[id\]/);
  assert.match(log, /type=assistant\/message/);
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

test.after(() => rmSync(home, { recursive: true, force: true }));
