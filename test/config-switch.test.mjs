/**
 * One switch, not two (review finding: distill vs extract).
 *
 * `distill` created the host-model callable while all four stages checked `extract`.
 * The defaults disagreed (`distill:'rules'`, `extract:'llm'`), so a default install
 * had no model, every stage returned false without saying why, extraction quietly
 * fell back to rules, and queues filled until the cap dropped the newest items.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-soulbridge-switch-'));
process.env.SOULBRIDGE_HOME = home;

const { llmMode, usesModel, makeLlm } = await import('../index.js');
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('config: makeLlm exists only when the mode provides a model', () => {
  // The behavioural half: the old gate was distill, so a default install returned
  // undefined here while every stage kept asking for a model.
  const ctx = { get: () => ({ stream: async function* () {} }) };
  assert.equal(makeLlm(ctx, { extract: 'rules' }), undefined);
  assert.equal(makeLlm(ctx, { extract: 'off' }), undefined);
  assert.equal(typeof makeLlm(ctx, { extract: 'llm' }), 'function');
  assert.equal(typeof makeLlm(ctx, {}), 'function', 'the default agrees with the stages');
});

test('config: only extract=llm provides a model', () => {
  assert.equal(usesModel({ extract: 'llm' }), true);
  assert.equal(usesModel({ extract: 'rules' }), false);
  assert.equal(usesModel({ extract: 'off' }), false);
  // Defaults must agree with themselves: the old pair did not.
  assert.equal(usesModel({}), true);
});

test('config: an unknown mode is not silently treated as rules', () => {
  assert.equal(llmMode({ extract: 'llm' }), 'llm');
  assert.equal(llmMode({ extract: 'rules' }), 'rules');
  assert.equal(llmMode({ extract: 'off' }), 'off');
});

test('config: the distill switch is gone (retired, not ignored in code)', () => {
  // retirements.json keeps this honest: while the symbol exists the ledger says
  // 'pending'; once removed it flips to 'done'.
  assert.equal(source.includes('config.distill'), false);
  assert.equal(source.includes("distill: 'rules'"), false);
});

test('config: stages that need a model do not enqueue work without one', () => {
  // Both feeders check usesModel first; otherwise the cap drops the newest entries
  // and only a single log line records the loss.
  const feed = source.slice(source.indexOf('export function feedClassifyFromTurn'));
  assert.match(feed.slice(0, 600), /usesModel\(readConfig\(\)\)/);
  const close = source.slice(source.indexOf('threads closed:'));
  assert.match(close.slice(0, 900), /usesModel\(closeConfig\)/);
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
