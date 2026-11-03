/**
 * A topic that has to be invented uses a whole sentence, never a character prefix.
 *
 * The fallback topic (`fallbackTopic`) is only used when the model gave no topic, but
 * it still ends up as a label people read: "这件事我们应该先" is worse than the sentence
 * it came from, and the cut point is arbitrary. One sentence is a complete unit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'soulbridge-first-sentence-'));
process.env.SOULBRIDGE_HOME = home;
const { firstSentence } = await import('../index.js');

test('firstSentence: returns the whole first sentence, not a prefix', () => {
  const text = '这件事我们应该先把注入块的证据完整保留下来。然后再考虑压缩，因为顺序反了会丢信息。';
  assert.equal(firstSentence(text), '这件事我们应该先把注入块的证据完整保留下来。');
  assert.equal(firstSentence('没有标点的一句话'), '没有标点的一句话');
  assert.equal(firstSentence('第一行\n第二行'), '第一行');
  assert.equal(firstSentence('   '), '');
});

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles open */
  }
});
