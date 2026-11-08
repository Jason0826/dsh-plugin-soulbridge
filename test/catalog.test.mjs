/**
 * The always-on catalog (0029 stage 1): a neutral index of what the rules layer holds.
 *
 * The point of the block is not to inject more — it is to give the model a reason to
 * ask for one memory instead of being handed five guesses. Two things therefore have
 * to hold: the block stays an index (no imperatives, bounded), and every rule that
 * owes a line reaches the queue that produces it, exactly once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-catalog-'));
process.env.SOULBRIDGE_HOME = home;

const { renderCatalog, catalogBackfillIds, enqueueClassifyCandidate, peekClassifyBatch, applyClassifications } =
  await import('../index.js');

test('catalog: empty entries produce no block at all', () => {
  assert.equal(renderCatalog([], 188, 188), '');
  assert.equal(renderCatalog(null, 188), '');
});

test('catalog: one neutral line per rule, with the id needed to expand it', () => {
  const block = renderCatalog(
    [
      { id: 'fc_a', index: '改 JSON 别用字符串替换' },
      { id: 'fc_b', index: '重启要用计划任务' },
    ],
    25,
    3,
  );
  assert.match(block, /<catalog shown="2" total="25">/);
  assert.match(block, /- \[fc_a\] 改 JSON 别用字符串替换/);
  assert.match(block, /- \[fc_b\] 重启要用计划任务/);
  // The counts are what keeps the block an index: 25 - 2 shown - 3 without an index
  // line leaves 20 unlisted, and the model is told how to reach them.
  assert.match(block, /其余 20 条未列出/);
  assert.match(block, /3 条还没有索引句/);
  assert.match(block, /soul_detail\(id\)/);
  assert.match(block, /soul_recall/);
  // An index is not a requirement: no rule block is forged by the directory.
  assert.equal(block.includes('<rules'), false);
});

test('catalog: the counts never go negative or double-count a missing line', () => {
  const block = renderCatalog([{ id: 'fc_a', index: '一' }], 1, 0);
  assert.equal(block.includes('其余'), false);
  assert.equal(block.includes('还没有索引句'), false);
  // More missing than total is a caller bug, not a count larger than the library:
  // the missing count is clamped to what is left after the shown lines.
  const odd = renderCatalog([{ id: 'fc_a', index: '一' }], 2, 5);
  assert.match(odd, /1 条还没有索引句/);
  assert.equal(/其余 -\d/.test(odd), false);
});

test('backfill: an id is attempted once, and new debt is still picked up', () => {
  const attempted = new Set(['fc_a']);
  // B0's two failure modes in one function: a digest of the inventory re-runs when it
  // shrinks; a bare flag never sees a row written later.
  assert.deepEqual(catalogBackfillIds(['fc_a', 'fc_b'], attempted), ['fc_b']);
  assert.deepEqual(catalogBackfillIds([], attempted), []);
  assert.deepEqual(catalogBackfillIds(null, attempted), []);
});

test('queue: an index item travels with its kind and drains after real classifications', () => {
  enqueueClassifyCandidate({ id: 'fc_new', statement: '新候选', reason: '全收' });
  assert.equal(
    enqueueClassifyCandidate({ id: 'fc_rule', statement: '已分好的规则', reason: '索引', kind: 'index' }),
    true,
  );
  const batch = peekClassifyBatch();
  const indexItem = batch.find((item) => item.id === 'fc_rule');
  assert.equal(indexItem.kind, 'index');
  // The kind must travel, or the batch is re-classified and its trigger rewritten.
  assert.equal(batch.find((item) => item.id === 'fc_new').kind, undefined);
  assert.deepEqual(
    batch.map((item) => item.id),
    ['fc_new', 'fc_rule'],
    '索引桶排在分类桶之后，新候选不会被存量索引饿死',
  );
});

test('wiring: the backfill runs from the first real message, through the same queue', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const userBranch = source.slice(source.indexOf("if (kind === 'user') {"));
  assert.match(userBranch.slice(0, 600), /backfillCatalogIndexes\(\)/);

  const step = source.slice(source.indexOf('async function runClassifyStep'));
  const body = step.slice(0, 3200);
  // One prompt, one model call per step, two jobs: the routing function is where they
  // separate, and a step that forgets to call it would drain the queue for nothing.
  assert.match(body, /applyClassifications\(classified, batch, ensureSoul\(\)\)/);
});

test('index answers apply as indexes; an empty or stale answer is skipped, never parked', () => {
  const calls = [];
  const soul = {
    markRuleIndex(id, index) {
      calls.push(['index', id, index]);
      return id !== 'fc_stale';
    },
    markRule(id, spec) {
      calls.push(['rule', id, spec]);
    },
    markProfile(id, spec) {
      calls.push(['profile', id, spec]);
    },
    markUnclassified(id) {
      calls.push(['pending', id]);
    },
  };
  const batch = [
    { id: 'fc_rule', statement: '已分好的规则', reason: '索引', kind: 'index' },
    { id: 'fc_stale', statement: '已退场的规则', reason: '索引', kind: 'index' },
    { id: 'fc_empty', statement: '没拿到索引的规则', reason: '索引', kind: 'index' },
    { id: 'fc_new', statement: '新候选', reason: '全收' },
  ];
  const counts = applyClassifications(
    [
      { id: 'fc_rule', kind: 'index', index: '改 JSON 别用字符串替换' },
      { id: 'fc_stale', kind: 'index', index: '这条写不进去' },
      { id: 'fc_empty', kind: 'index' },
      { id: 'fc_new', kind: 'rule', trigger: '{"any":["json"]}', action: '用 edit 工具', index: '改 JSON' },
      // Not in the batch: a hallucinated id is ignored, not written.
      { id: 'fc_hallucinated', kind: 'index', index: '不在批次里' },
    ],
    batch,
    soul,
  );
  assert.deepEqual(calls, [
    ['index', 'fc_rule', '改 JSON 别用字符串替换'],
    // Attempted, refused by the store (not an active rule any more) — counted as
    // skipped below, and never turned into a 待修 decision.
    ['index', 'fc_stale', '这条写不进去'],
    ['rule', 'fc_new', { trigger: '{"any":["json"]}', action: '用 edit 工具', index: '改 JSON' }],
  ]);
  // Skipped is not pending: 待修 would demote a rule that is already in use.
  assert.deepEqual(counts, { rules: 1, profiles: 0, pending: 0, indexed: 1, indexSkipped: 2 });
});

test('wiring: the two measured tools write a countable event', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  // The judgement line is a count of calls; a log line alone is not machine-countable
  // without matching prose, which is how the baseline "0 calls" was invisible before.
  assert.match(source, /trace\(\{ event: 'tool-call', name: 'soul_recall', queryChars: query\.length/);
  assert.match(source, /trace\(\{ event: 'tool-call', name: 'soul_detail', hit: true/);
  assert.match(source, /trace\(\{ event: 'tool-call', name: 'soul_detail', hit: false/);
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
