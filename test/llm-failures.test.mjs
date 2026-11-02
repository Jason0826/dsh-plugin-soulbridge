/**
 * A failed model call is not an empty answer (review finding 1).
 *
 * The host ends a failed stream with `finish{reason:{kind:'error'}}` instead of
 * throwing, so a caller that only looks at text sees `''` and concludes "the model
 * said nothing" — which silently dropped conclusions, retried verifications forever,
 * and treated unreadable dedupe replies as "unrelated".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-llm-'));
process.env.SOULBRIDGE_HOME = home;

const { collectText, readConsolidationReply } = await import('../index.js');

async function* streamOf(...chunks) {
  yield* chunks;
}

test('collectText: a stream that only reports an error throws instead of returning ""', async () => {
  const stream = streamOf({ type: 'finish', reason: { kind: 'error', message: 'upstream 503' } });
  await assert.rejects(() => collectText(stream), /ended without output \(error: upstream 503\)/);
});

test('collectText: aborted counts as a failure too', async () => {
  await assert.rejects(() => collectText(streamOf({ type: 'finish', reason: { kind: 'aborted' } })), /aborted/);
});

test('collectText: a normal stream still joins its deltas', async () => {
  const text = await collectText(
    streamOf(
      { type: 'text-delta', text: '结论: ' },
      { type: 'text-delta', text: '先验证再动手' },
      { type: 'finish', reason: { kind: 'stop' } },
    ),
  );
  assert.equal(text, '结论: 先验证再动手');
});

test('collectText: partial output before a failure is kept, not discarded', async () => {
  const text = await collectText(
    streamOf({ type: 'text-delta', text: '结论: 半句' }, { type: 'finish', reason: { kind: 'aborted' } }),
  );
  // The parser decides whether the fragment is usable; the collector does not throw
  // away text the caller already paid for.
  assert.equal(text, '结论: 半句');
});

test('readConsolidationReply: "nothing" and "unreadable" are different answers', () => {
  assert.equal(readConsolidationReply('').kind, 'empty');
  assert.equal(readConsolidationReply('   ').kind, 'empty');
  assert.equal(readConsolidationReply('无').kind, 'none');
  assert.equal(readConsolidationReply('这一段没什么可归纳的\n无').kind, 'none');
  assert.equal(readConsolidationReply('我不太确定该怎么写').kind, 'unparseable');

  const draft = readConsolidationReply('结论: 用户要求改动前先说明影响 | 证据=fc_a,fc_b | 置信=0.8');
  assert.equal(draft.kind, 'draft');
  assert.equal(draft.draft.statement, '用户要求改动前先说明影响');
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
