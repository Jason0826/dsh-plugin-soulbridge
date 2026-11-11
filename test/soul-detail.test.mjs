/**
 * soul_detail 的返回必须过 harness 的 lossless JSON 校验（rules.md 26：一条规则配一个检查）。
 *
 * 根因（state.md 2026-11-11 22:15 三层链）：事实没有 valid_from_text（date() 类只放 epoch）
 * 或没有来源轮次时，execute 原样返回「键在、值是 undefined」的对象；harness 的
 * snapshotJsonValue 没有 JSON 形式可取，整条结果被判 `value is not lossless JSON` 拒掉。
 * 触发面 = 无 text 或无 turn 的事实，所以这个工具时好时坏。键不存在是合法的，
 * 键上挂着 undefined 不是。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'soul-detail-'));
process.env.SOULBRIDGE_HOME = home;

const { openSqlite, Soul } = await import('soulbridge');

// 触发面事实：有 epoch 没有 text、没有来源轮次——生产里 date() 类放的日期就是这个形状。
const store = openSqlite(join(home, 'soul.db'));
const soul = new Soul({ store, soulId: 'xiaoling', userId: 'local' });
const turnId = soul.recordTurnPair({
  sessionId: 's-detail',
  turn: 1,
  userText: '原话用户',
  assistantText: '原话助手',
});
const bare = soul.recordFact({
  statement: '只有 epoch 的事实：无 text 无来源轮次',
  validFrom: 1762800000000,
});
const full = soul.recordFact({
  statement: '带 text 带来源轮次的事实',
  validFromText: '今天',
  sourceTurnId: turnId,
});

// 捕获 apply() 注册的工具，走的是生产同一条注册路径。
const registered = new Map();
const fakeCtx = {
  effect(fn) {
    return fn();
  },
  systemPrompt: {
    section() {
      return () => {};
    },
  },
  on() {
    return () => {};
  },
  get() {
    return undefined;
  },
  inject(_names, cb) {
    cb({
      get: (name) =>
        name === 'tools'
          ? {
              register(tool) {
                registered.set(tool.name, tool);
                return () => registered.delete(tool.name);
              },
            }
          : undefined,
    });
  },
};

const { apply } = await import('../index.js');
apply(fakeCtx);

/** harness 判据的等价物：JSON 往返后必须逐键相等（pipeline.ts snapshotToolValue）。 */
function assertLossless(value, label) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(value)), value, label);
}

test('soul_detail：无 text 无轮次的事实，输出过 lossless JSON', async () => {
  const out = await registered.get('soul_detail').execute({ id: bare.id });
  assert.equal(out.ok, true);
  assert.equal(out.statement, '只有 epoch 的事实：无 text 无来源轮次');
  assertLossless(out, 'harness 会以 value is not lossless JSON 拒收这条结果');
});

test('soul_detail：带 text 带轮次的值原样保留，不被误剔', async () => {
  const out = await registered.get('soul_detail').execute({ id: full.id });
  assert.equal(out.ok, true);
  assert.equal(out.validFromText, '今天');
  assert.equal(out.userText, '原话用户');
  assert.equal(out.assistantText, '原话助手');
  assertLossless(out);
});

test('soul_detail：查不到的事实走失败路径，输出同样是 lossless JSON', async () => {
  const out = await registered.get('soul_detail').execute({ id: 'fc_not_here' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /no fact/);
  assertLossless(out);
});
