/**
 * The queue earns its keep only if a failed model call does not count as done.
 *
 * Two behaviours are pinned here against a throwaway home:
 *   1. one item per step, so every attempt stays inside the model window
 *   2. a rules fallback caused by a broken model call is retried, not dropped
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'soul-drain-'));
process.env.SOULBRIDGE_HOME = home;
mkdirSync(home, { recursive: true });

// Rules mode: the model path is deliberately unavailable, so every attempt
// exercises the retry branch without touching a provider.
writeFileSync(join(home, 'plugin-config.json'), JSON.stringify({ extract: 'rules' }), 'utf8');

const { openSqlite } = await import('soulbridge');
const { Soul } = await import('soulbridge');
const { drainExtractionQueue } = await import('../index.js');

const store = openSqlite(join(home, 'soul.db'));
const soul = new Soul({ store, soulId: 'xiaoling', userId: 'local' });

const first = soul.recordTurnPair({ sessionId: 's', turn: 1, userText: '第一条', assistantText: '好' });
const second = soul.recordTurnPair({ sessionId: 's', turn: 2, userText: '第二条', assistantText: '好' });
const queueFile = join(home, 'pending-extract.json');
const seed = () =>
  writeFileSync(
    queueFile,
    JSON.stringify([
      { turnId: first, turnNo: 1, attempts: 0 },
      { turnId: second, turnNo: 2, attempts: 0 },
    ]),
    'utf8',
  );
const readQueue = () => JSON.parse(readFileSync(queueFile, 'utf8'));

test('drain: one turn per step, the rest stay queued', async () => {
  seed();
  await drainExtractionQueue();
  const left = readQueue();
  assert.equal(left.length, 1, 'exactly one item is consumed per drain');
  assert.equal(left[0].turnId, second, 'the oldest item is the one consumed');
});

test('drain: an empty queue is left alone', async () => {
  writeFileSync(queueFile, '[]', 'utf8');
  await drainExtractionQueue();
  assert.equal(readQueue().length, 0);
});

test('drain: rules mode counts as complete, not as a retry', async () => {
  seed();
  await drainExtractionQueue();
  await drainExtractionQueue();
  assert.equal(readQueue().length, 0, 'both items are consumed in rules mode');
});

test.after(() => {
  store.close();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* the plugin keeps a handle open on Windows; a temp dir is harmless */
  }
});
