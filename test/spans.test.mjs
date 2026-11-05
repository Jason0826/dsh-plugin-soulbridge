/**
 * Segment attribution end to end (0028 ③): the model's span lines decide which
 * thread each turn of a flushed segment lands in.
 *
 * The old shape attached ONE turn per extraction (the head) and accepted ONE
 * 线索 line — a two-topic segment merged into one thread and the rest of the
 * segment carried no thread at all. These tests drive the real llm path with a
 * two-line answer and assert the database, not the log: every turn attached, two
 * threads, and threads counting the HOST's turn numbers (which jump by 10–30),
 * while the spans matched the prompt's 1..n numbering.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'soulbridge-spans-'));
process.env.SOULBRIDGE_HOME = home;
mkdirSync(home, { recursive: true });
writeFileSync(
  join(home, 'plugin-config.json'),
  JSON.stringify({ extract: 'llm', provider: 'test', model: 'test' }),
  'utf8',
);

const mod = await import(`../index.js?spans=${Date.now()}`);
const { openSqlite, Soul } = await import('soulbridge');

const ANSWER = ['无', '线索: 1-1 新 | 前半段话题', '线索: 2-3 新 | 后半段话题'].join('\n');

function fakeCtx(answer) {
  const listeners = {};
  const ctx = {
    effect() {},
    systemPrompt: {
      section() {
        return () => {};
      },
    },
    on(event, fn) {
      listeners[event] = fn;
      return () => {};
    },
    get(name) {
      if (name === 'llm') {
        return {
          async *stream() {
            yield { type: 'text-delta', text: answer };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      }
      return undefined;
    },
  };
  return { ctx, get listener() { return listeners['session/event']; } };
}

const store = openSqlite(join(home, 'soul.db'));
const soul = new Soul({ store, soulId: 'xiaoling', userId: 'local' });

// Host turn numbers jump by 10–30 per exchange; the prompt numbers are 1..n. Spans
// must match the prompt numbers while threads record the real ones.
const t1 = soul.recordTurnPair({ sessionId: 'live', turn: 7, userText: '前半段的第一句', assistantText: '好' });
const t2 = soul.recordTurnPair({ sessionId: 'live', turn: 25, userText: '前半段的第二句', assistantText: '好' });
const t3 = soul.recordTurnPair({ sessionId: 'live', turn: 60, userText: '后半段的转折', assistantText: '好' });

const queueFile = join(home, 'pending-extract.json');
const seed = () =>
  writeFileSync(
    queueFile,
    JSON.stringify(
      [t1, t2, t3].map((id, index) => ({ turnId: id, turnNo: [7, 25, 60][index], attempts: 0, origin: 'live' })),
      null,
      2,
    ),
    'utf8',
  );
const readQueue = () => JSON.parse(readFileSync(queueFile, 'utf8'));
const log = () => readFileSync(join(home, 'plugin.log'), 'utf8');
const trace = () =>
  readFileSync(join(home, 'trace.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test('spans end to end: two 线索 lines → two threads, every turn attached', async () => {
  const harness = fakeCtx(ANSWER);
  mod.apply(harness.ctx); // config is llm → injectedLlm is the answering stream
  seed();

  const done = await mod.drainExtractionQueue({ sessionId: 'live', archivedSessions: ['live'] });
  assert.equal(done, true, '归档触发：整段一次抽');
  assert.equal(readQueue().length, 0, '整段消费');

  const a = soul.turnThreadId(t1);
  const b2 = soul.turnThreadId(t2);
  const b3 = soul.turnThreadId(t3);
  assert.ok(a && b2 && b3, '每一轮都挂上了线索（旧实现只挂头轮）');
  assert.equal(b2, b3, '2-3 是同一段');
  assert.notEqual(a, b2, '1-1 与 2-3 是两条线索');

  // Threads count HOST turn numbers: the segment's real numbers are 7 / 25 / 60.
  assert.equal(store.thread(a)?.lastTurnNo, 7, '线索记录真实轮号，不是提示词里的 1..n');
  assert.equal(store.thread(b3)?.lastTurnNo, 60);
  assert.equal(store.thread(a)?.topic, '前半段话题');
  assert.equal(store.thread(b3)?.topic, '后半段话题');

  const line = log().split(/\r?\n/).find((row) => row.includes('extract done:'));
  assert.match(line, /unit=3turns/);
  assert.match(line, /thread=th_\w+,th_\w+\(2 new\) join=explicit-new\+continue threadLine=present/);

  const extract = trace().filter((row) => row.event === 'extract').at(-1);
  assert.equal(extract.threadSpans.length, 3, '拆段的逐轮归属进 trace，错切才可诊断');
  assert.deepEqual(
    extract.threadSpans.map((span) => span.span),
    [1, 2, 3],
    'trace 里的 span 是提示词编号',
  );
});

test('spans end to end: rules mode keeps the old single-thread log line', async () => {
  writeFileSync(join(home, 'plugin-config.json'), JSON.stringify({ extract: 'rules' }), 'utf8');
  const harness = fakeCtx(ANSWER);
  mod.apply(harness.ctx); // rules config → injectedLlm is undefined, floor only
  seed();

  await mod.drainExtractionQueue({ sessionId: 'live', archivedSessions: ['live'] });
  assert.equal(readQueue().length, 0);
  const line = log()
    .split(/\r?\n/)
    .filter((row) => row.includes('extract done:'))
    .at(-1);
  // The thread part is byte for byte the old shape: one thread, one `(new)`, no
  // comma list. `join=` is now the unit's per-turn reasons joined with `+` — one
  // value only when they agree — because a floor that falls back on turn 1 and
  // chains on turns 2–3 used to report only the head's reason.
  assert.match(line, /thread=th_\w+\(new\) join=[a-z-]+(\+[a-z-]+)* threadLine=rules/);
  assert.equal(line.includes(','), false, '单线索不长出列表');
});

test.after(() => {
  store.close();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
