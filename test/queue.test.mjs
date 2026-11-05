/**
 * The queue earns its keep only if a failed model call does not count as done —
 * and under 0028 it only runs AT A DEPARTURE (compaction marker / session switch
 * / archive / capacity / age), never because the queue happens to be non-empty.
 * Pinned here against a throwaway home:
 *   1. no departure → nothing is extracted (in-session calls are 0 by construction)
 *   2. a departure flushes the WHOLE buffered segment as one unit
 *   3. rules mode counts as complete, not as a retry
 *   4. belonging to a thread is not a trigger — attribution is a product (0028 ③),
 *      not an input, which is what removed the inverted-timing root cause
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'soul-drain-'));
process.env.SOULBRIDGE_HOME = home;
mkdirSync(home, { recursive: true });

// Rules mode: the model path is deliberately unavailable, so every path here
// exercises the queue without touching a provider. The failure/retry path (a
// broken model) lives in segment-flush.test.mjs, which brings its own.
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

test('drain: without a departure nothing is extracted', async () => {
  seed();
  const done = await drainExtractionQueue({ sessionId: 's' });
  assert.equal(done, false, 'the stage claims no model call, so the next stage may take it');
  assert.equal(readQueue().length, 2, 'turns still in the host context are only buffered');
  const trace = readFileSync(join(home, 'trace.jsonl'), 'utf8');
  assert.match(trace, /"event":"segment-wait"/, 'the wait is observable, not silent');
});

test('drain: an empty queue is left alone', async () => {
  writeFileSync(queueFile, '[]', 'utf8');
  await drainExtractionQueue({ sessionId: 's' });
  assert.equal(readQueue().length, 0);
});

test('drain: a session switch flushes the whole buffer as ONE segment', async () => {
  seed();
  const done = await drainExtractionQueue({ sessionId: 'not-s' });
  assert.equal(done, true);
  assert.equal(readQueue().length, 0, 'the unit is the segment, not one turn per drain');
  const log = readFileSync(join(home, 'plugin.log'), 'utf8');
  assert.match(log, /segment flush: trigger=session turns=2/);
  assert.match(log, /unit=2turns/);
  const state = JSON.parse(readFileSync(join(home, 'segment-state.json'), 'utf8'));
  assert.equal(state.sealed.at(-1).turns, 2, 'the flush leaves a seal record');
  assert.equal(state.sealed.at(-1).trigger, 'session');
  assert.equal(state.marker, null, 'a flush spends the marker');
});

test('drain: rules mode counts as complete, not as a retry', async () => {
  seed();
  await drainExtractionQueue({ sessionId: 'not-s' });
  assert.equal(readQueue().length, 0, 'one segment call consumes the segment');
  const log = readFileSync(join(home, 'plugin.log'), 'utf8');
  assert.equal(log.match(/retry segment/g)?.length ?? 0, 0, 'rules mode is complete, not a failure');
});

test('drain: a thread is not a trigger — attribution is a product, not an input', async () => {
  // Membership used to summon the whole thread as the extraction input (0025),
  // reading turns.thread_id before the extraction of that turn would write it —
  // the inverted timing 0028 removed. Now it waits like any other buffered turn.
  const thread = soul.applyThread(undefined, { sessionId: 's', turnNo: 1, turnId: first, at: Date.now() });
  soul.applyThread(
    { kind: 'continue', id: thread.threadId },
    { sessionId: 's', turnNo: 2, turnId: second, at: Date.now() },
  );
  seed();
  await drainExtractionQueue({ sessionId: 's' });
  assert.equal(readQueue().length, 2, 'belonging to a thread flushes nothing by itself');
  await drainExtractionQueue({ sessionId: 'switched' });
  assert.equal(readQueue().length, 0);
  const log = readFileSync(join(home, 'plugin.log'), 'utf8');
  assert.match(log, /unit=2turns/, 'the unit is the two-turn segment');
});

test.after(() => {
  store.close();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* the plugin keeps a handle open on Windows; a temp dir is harmless */
  }
});
