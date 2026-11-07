/**
 * What one turn cost, counted from the host's event stream (brief 0026).
 *
 * The platform export is one money line per day, so an expensive turn is invisible
 * until the day is over: the worst turn in today's data made 108 model requests and
 * the average is 18. These tests pin what the counter may and may not do — count a
 * retried attempt, refuse to attach a session's events to a neighbour, and keep the
 * unfinished-turn map bounded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'soulbridge-turn-cost-'));
process.env.SOULBRIDGE_HOME = home;

const { createTurnCostTracker } = await import('../index.js');

const usage = (inputTokens, cacheReadTokens, outputTokens) => ({
  inputTokens,
  cacheReadTokens,
  cacheWriteTokens: 0,
  outputTokens,
});

/** A tracker that records instead of writing the trace file. */
function harness(options = {}) {
  const records = [];
  const alerts = [];
  const tracker = createTurnCostTracker({
    onReport: (record) => records.push(record),
    onAlert: (line) => alerts.push(line),
    ...options,
  });
  return { tracker, records, alerts };
}

const startTurn = (turn, time = 1_000) => ({ type: 'turn/start', time, data: { turn } });
const step = (turn) => ({ type: 'step/start', time: 1_100, data: { turn, step: 1 } });
const message = (turn, reported) => ({ type: 'assistant/message', time: 1_200, data: { turn, step: 1, usage: reported } });
const endTurn = (turn, kind = 'completed', time = 6_000) => ({ type: 'turn/end', time, data: { turn, reason: { kind } } });

test('a finished turn reports its requests, tokens and duration', () => {
  const { tracker, records } = harness();
  tracker.observe('s1', startTurn(7));
  tracker.observe('s1', step(7));
  tracker.observe('s1', message(7, usage(100, 9_000, 50)));
  tracker.observe('s1', step(7));
  tracker.observe('s1', message(7, usage(20, 1_000, 10)));
  tracker.observe('s1', endTurn(7));

  assert.equal(records.length, 1);
  assert.equal(records[0].session, 's1');
  assert.equal(records[0].turn, 7);
  assert.deepEqual(
    { ...records[0] },
    {
      event: 'turn-cost',
      session: 's1',
      turn: 7,
      requests: 2,
      steps: 2,
      failed: 0,
      plugin: 0,
      input: 120,
      cacheHit: 10_000,
      cacheWrite: 0,
      output: 60,
      mainMax: 9_100,
      secs: 5,
      reason: 'completed',
    },
  );
  assert.equal(tracker.openCount(), 0);
});

test('a retried attempt is a request too', () => {
  const { tracker, records } = harness();
  tracker.observe('s1', startTurn(1));
  tracker.observe('s1', step(1));
  tracker.observe('s1', { type: 'assistant/attempt', time: 1_300, data: { turn: 1, step: 1, stream: [] } });
  tracker.observe('s1', message(1, usage(5, 0, 5)));
  tracker.observe('s1', endTurn(1));
  // One step opened one call; the attempt that produced no message was a second
  // request. The successful message is the step's own result, not a third one.
  assert.equal(records[0].requests, 2);
  assert.equal(records[0].failed, 1);
  assert.equal(records[0].steps, 1);
});

test('the alert line appears only at the threshold, and names the parts', () => {
  const { tracker, alerts } = harness({ threshold: 3 });
  tracker.observe('s1', startTurn(1));
  tracker.observe('s1', step(1));
  tracker.observe('s1', step(1));
  tracker.observe('s1', endTurn(1));
  assert.equal(alerts.length, 0, 'two requests stay quiet');

  tracker.observe('s1', startTurn(2));
  tracker.observe('s1', step(2));
  tracker.observe('s1', step(2));
  tracker.pluginCall();
  tracker.observe('s1', endTurn(2));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /turn=2 requests=3 \(steps=2 failed=0 plugin=1\)/);
});

test('a plugin call lands on the current turn and carries its usage', () => {
  const { tracker, records } = harness();
  tracker.observe('s1', startTurn(4));
  tracker.observe('s1', step(4));
  tracker.pluginCall();
  tracker.pluginUsage(usage(700, 3_000, 80));
  tracker.observe('s1', endTurn(4));
  assert.equal(records[0].plugin, 1);
  assert.equal(records[0].requests, 2);
  assert.equal(records[0].input, 700);
  assert.equal(records[0].output, 80);
});

test('mainMax is the largest host request — plugin calls are not context', () => {
  const { tracker, records } = harness();
  tracker.observe('s1', startTurn(9));
  tracker.observe('s1', step(9));
  tracker.observe('s1', message(9, usage(50, 100_000, 10))); // prefix 100_050
  tracker.pluginCall();
  // Bigger than the host's largest request — a fresh post-compact session (27k
  // main) with a large extract call is the real shape of this edge. The plugin
  // call does not ride the session context, so it must never win.
  tracker.pluginUsage(usage(700, 300_000, 80)); // prefix 300_700
  tracker.observe('s1', step(9));
  tracker.observe('s1', message(9, usage(60, 200_000, 10))); // prefix 200_060
  tracker.observe('s1', endTurn(9));
  assert.equal(records[0].mainMax, 200_060, 'the gate reads host requests only');
  assert.equal(records[0].plugin, 1, 'the plugin call is still counted as a request');
  assert.equal(records[0].input, 810, 'token totals stay complete — money is money');
});

test("another session's events are not attached to the open turn", () => {
  const { tracker, records } = harness();
  tracker.observe('s1', startTurn(1));
  tracker.observe('s1', step(1));
  // A subagent's own turn: same numbers, different session.
  tracker.observe('s2', startTurn(1));
  tracker.observe('s2', step(1));
  assert.equal(tracker.openCount(), 2);

  tracker.observe('s1', endTurn(1));
  assert.equal(records.length, 1);
  assert.equal(records[0].session, 's1');
  assert.equal(records[0].requests, 1);
});

test('a turn with no requests writes nothing, and the map stays bounded', () => {
  const { tracker, records } = harness({ maxTurns: 2 });
  tracker.observe('s1', startTurn(1));
  tracker.observe('s1', endTurn(1));
  assert.equal(records.length, 0, 'an empty turn is not a cost');

  tracker.observe('s1', startTurn(2));
  tracker.observe('s1', step(2));
  tracker.observe('s2', startTurn(1));
  tracker.observe('s2', step(1));
  // Third open turn evicts the oldest, which is written out rather than dropped.
  tracker.observe('s3', startTurn(1));
  tracker.observe('s3', step(1));
  assert.equal(tracker.openCount(), 2);
  assert.equal(records.length, 1);
  assert.equal(records[0].open, true);
  assert.equal(records[0].reason, 'evicted');
});
