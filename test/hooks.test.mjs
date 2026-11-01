/**
 * The hook path, end to end against a throwaway home.
 *
 * A message that names a known person should produce a short `<about>` block
 * with fact ids — earliest fact first (how it started), then recent ones — not
 * a replay of whole conversations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'soul-hooks-'));
process.env.SOULBRIDGE_HOME = home;
mkdirSync(join(home), { recursive: true });

const { openSqlite } = await import('soulbridge');
const { Soul } = await import('soulbridge');
const { buildFactHooks } = await import('../index.js');

const store = openSqlite(join(home, 'soul.db'));
const soul = new Soul({ store, soulId: 'xiaoling', userId: 'local' });

const her = soul.rememberEntity('阿珍', 'person', { aliases: ['小珍'] });
soul.recordFact({
  statement: '2025-03-14 第一次和阿珍见面，一起吃火锅',
  atText: '2025-03-14',
  at: new Date('2025-03-14T19:00:00+08:00').getTime(),
  slots: [{ slot: '参与者', value: { kind: 'entity', entityId: her.id } }],
});
soul.recordFact({
  statement: '2026-10-31 和阿珍又吃了火锅',
  at: new Date('2026-10-31T19:00:00+08:00').getTime(),
  slots: [{ slot: '参与者', value: { kind: 'entity', entityId: her.id } }],
});

test('hooks: a mentioned person yields the earliest fact first, with ids', () => {
  const hooks = buildFactHooks('跟阿珍刚认识的时候，我们一起吃了什么');
  assert.match(hooks.text, /<about name="阿珍">/);
  const lines = hooks.text.split('\n');
  const first = lines.find((line) => line.includes('第一次'));
  assert.ok(first, 'earliest fact line present');
  assert.match(first, /^- \[fc_[a-z0-9_]+\] 2025-03-14 第一次和阿珍见面/);
  assert.equal(hooks.used.length, 2, 'earliest plus recent, no duplicates');
});

test('hooks: aliases work, and a message without a known name yields nothing', () => {
  assert.match(buildFactHooks('小珍最近怎么样').text, /<about name="阿珍">/);
  assert.equal(buildFactHooks('今天天气不错'), '', 'no parts means a plain empty string');
});

test('hooks: stay short — one line per fact, not the conversation', () => {
  const hooks = buildFactHooks('阿珍怎么样了');
  assert.ok(hooks.text.length < 400, `hooks grew to ${hooks.text.length} chars`);
  assert.doesNotMatch(hooks.text, /\[Q\]/, 'no conversation replay in hooks');
});

test.after(() => {
  store.close();
  // The plugin keeps its own handle on the same database, so removal can fail
  // on Windows; a leftover temp directory is harmless.
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
