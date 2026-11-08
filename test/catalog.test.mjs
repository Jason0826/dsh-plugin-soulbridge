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

const {
  renderCatalog,
  catalogBackfillIds,
  enqueueClassifyCandidate,
  peekClassifyBatch,
  applyClassifications,
  requeueShapeMisses,
  commitClassifyBatch,
} = await import('../index.js');

/** Leave no queue behind for the next test: the file is shared by the whole run. */
function drainQueue() {
  for (;;) {
    const ids = peekClassifyBatch().map((item) => item.id);
    if (ids.length === 0) return;
    commitClassifyBatch(ids);
  }
}

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
  assert.match(userBranch.slice(0, 1400), /backfillCatalogIndexes\(\)/);

  const step = source.slice(source.indexOf('async function runClassifyStep'));
  const body = step.slice(0, 3600);
  // One prompt, one model call per step, two jobs: the routing function is where they
  // separate, and a step that forgets to call it would drain the queue for nothing.
  assert.match(body, /applyClassifications\(\s*classified,\s*batch,\s*ensureSoul\(\),?\s*\)/);
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
    { id: 'fc_prefix', statement: '模型没照前缀答的规则', reason: '索引', kind: 'index' },
    { id: 'fc_new', statement: '新候选', reason: '全收' },
  ];
  const counts = applyClassifications(
    [
      { id: 'fc_rule', kind: 'index', index: '改 JSON 别用字符串替换' },
      { id: 'fc_stale', kind: 'index', index: '这条写不进去' },
      { id: 'fc_empty', kind: 'index' },
      // The model ignored the 「规则|」 prefix and re-classified a placed rule. The
      // placement must survive: no markRule, counted as a skipped index line, so the
      // first batch shows indexSkipped>0 instead of stacking a second 触发 slot.
      { id: 'fc_prefix', kind: 'rule', trigger: '{"any":["json"]}', action: '重新分类' },
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
  assert.deepEqual(counts, {
    rules: 1,
    profiles: 0,
    pending: 0,
    indexed: 1,
    indexSkipped: 3,
    indexRejected: 0,
    // A line is still owed for these two: one ignored the prefix, one came back empty.
    // Not for fc_stale — the rule is retired, so asking again would only ask about a
    // rule that is not in the catalog any more.
    retry: ['fc_empty', 'fc_prefix'],
  });
});

test('a shape miss goes back once, then it is dropped', () => {
  // 11-08: one batch of ten index rows was answered as 规则| and the prefix guard kept
  // every old line — then the batch was committed and those ten rules were never asked
  // again, because a rewritten line is not "missing". One more ask closes that hole; a
  // second miss is left for a human, not looped.
  drainQueue();
  const item = { id: 'fc_miss', statement: '重启会杀掉进行中的轮', reason: '索引重写', kind: 'index' };
  assert.equal(requeueShapeMisses([item], []), 0);
  assert.equal(requeueShapeMisses([item], ['fc_ghost']), 0, '批次外的 id 不能被放回');
  assert.equal(requeueShapeMisses([item], ['fc_miss']), 1);
  const back = peekClassifyBatch();
  assert.deepEqual(back, [{ ...item, misses: 1 }], '放回时要带着计数和 kind');
  // The next batch takes it and carries the count — that count is what bounds the retry.
  commitClassifyBatch(['fc_miss']);
  assert.equal(requeueShapeMisses(back, ['fc_miss']), 0, '第二次失败不再循环');
  assert.deepEqual(peekClassifyBatch(), []);
});

test('wiring: a shape miss is put back from the same place the batch is committed', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  // The retry has to survive a reload, so it lives in the queue file, not in a variable.
  assert.match(source, /writeClassifyQueue\(\[\.\.\.again, \.\.\.readClassifyQueue\(\)\]\)/);
  assert.match(source, /const shapeRetry = requeueShapeMisses\(batch, retry\)/);
});

test('index lines that point at a place are refused, and the old line survives', async () => {
  // The user reviewed 20 sampled lines and flagged 5: three pointed at a location
  // ("turn 18", "unit=Nturns"), one recorded an edit, one was a slogan. A rewrite that
  // wrote such a line back would make the catalog worse than before, so the write is
  // refused and counted — the old line, whatever its quality, is at least readable.
  const { isLocalCoordinate } = await import('../index.js');
  for (const bad of [
    '重启杀掉 turn 18，与 11-06 turn 11 同缺口',
    '348k 停 6.5 小时，turn 20 全量重读约 ¥0.35',
    '抽取生效以 unit=Nturns 日志为准',
    '抽取模板加了「有效到」字段',
    '依据槽位由代码自动写本轮 turn id',
    'fix in 8b2c60c by hand',
  ]) {
    assert.equal(isLocalCoordinate(bad), true, `应拒绝：${bad}`);
  }
  for (const good of [
    '重启会杀掉正在执行的轮，那一轮不会被记录',
    '上下文放 6.5 小时不压缩，下次开口要全价重读',
    '改 JSON 别用字符串替换',
    '不看到整条线索跑通的日志，不说抽取已生效',
  ]) {
    assert.equal(isLocalCoordinate(good), false, `不该拒绝：${good}`);
  }

  const calls = [];
  const soul = {
    markRuleIndex(id, index) {
      calls.push([id, index]);
      return true;
    },
  };
  const batch = [{ id: 'fc_ptr', statement: '重启杀掉 turn 18', reason: '索引重写', kind: 'index' }];
  const counts = applyClassifications(
    [{ id: 'fc_ptr', kind: 'index', index: '重启杀掉 turn 18' }],
    batch,
    soul,
  );
  assert.deepEqual(calls, [], '拒绝的索引句不能被写进去');
  assert.equal(counts.indexRejected, 1);
  assert.equal(counts.indexed, 0);
  // Refused once, asked again: the same rule with a better sentence is what the pass is
  // for, and the old line stays untouched until a good one arrives.
  assert.deepEqual(counts.retry, ['fc_ptr']);
});

test('rewrite: a one-shot pass queues every placed rule, after the missing-index ones', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const userBranch = source.slice(source.indexOf("if (kind === 'user') {"));
  const body = userBranch.slice(0, 900);
  // Order matters: rewriting first covers rows that already have a line; the backfill
  // still runs after it for rows that have none.
  assert.ok(body.indexOf('backfillCatalogIndexRewrites()') >= 0, '改写批次必须从首个真实消息触发');
  assert.ok(
    body.indexOf('backfillCatalogIndexRewrites()') < body.indexOf('backfillCatalogIndexes()'),
    '改写排在补齐之前',
  );
  // A bare one-shot flag is right here (unlike the backfill's id bookkeeping): the new
  // prompt covers everything written from now on, so a second pass would only rewrite
  // lines that are already good.
  assert.match(source, /\.catalog-index-rewrite\.json/);

  enqueueClassifyCandidate({ id: 'fc_rw', statement: '重写的规则', reason: '索引重写', kind: 'index' });
  const order = peekClassifyBatch().map((item) => item.id);
  assert.ok(
    order.indexOf('fc_rw') > order.indexOf('fc_rule'),
    '索引重写排在补索引之后：先把缺的补上，再统一改写法',
  );
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
