/**
 * Queue contract: a batch must not leave the queue until its result is applied.
 *
 * The bug this pins: the classifier removed its batch before the model call, so a
 * throw or an empty reply lost up to ten lessons with only a generic background
 * error to show for it. The retry path also had to survive a fresh read, because
 * the queue can be changed by another part of the process while a call is in flight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'soulbridge-queue-'));
process.env.SOULBRIDGE_HOME = home;
const mod = await import(`../index.js?queue-contract=${Date.now()}`);

const file = join(home, 'pending-classify.json');
const write = (items) => writeFileSync(file, JSON.stringify(items, null, 2), 'utf8');
const read = () => JSON.parse(readFileSync(file, 'utf8'));

test('queue: peeking does not remove the batch', () => {
  write([{ id: 'fc_a', statement: 'a' }, { id: 'fc_b', statement: 'b' }]);
  const batch = mod.peekClassifyBatch();
  assert.equal(batch.length, 2);
  assert.equal(read().length, 2, 'nothing is removed until the work is applied');
});

test('queue: a failed batch is retried with an attempt, then dropped after three', () => {
  write([{ id: 'fc_a', statement: 'a' }]);
  const batch = mod.peekClassifyBatch();
  mod.retryClassifyBatch(batch);
  assert.equal(read()[0].attempts, 1, 'the lesson survives a failed call');

  mod.retryClassifyBatch(read());
  assert.equal(read()[0].attempts, 2);

  mod.retryClassifyBatch(read());
  assert.equal(read().length, 0, 'three failures is the documented cap');
});

test('queue: committing removes exactly the applied batch', () => {
  write([{ id: 'fc_a', statement: 'a' }, { id: 'fc_b', statement: 'b' }, { id: 'fc_c', statement: 'c' }]);
  mod.commitClassifyBatch(['fc_a', 'fc_b']);
  assert.deepEqual(read().map((item) => item.id), ['fc_c']);
});

test('profile queue: sources survive a failed merge and are removed after it', () => {
  const profileFile = join(home, 'pending-profile.json');
  writeFileSync(profileFile, JSON.stringify([{ id: 'fc_a', statement: 'a' }, { id: 'fc_b', statement: 'b' }]), 'utf8');

  const batch = mod.peekProfileQueue();
  assert.equal(batch.length, 2, 'peeking does not consume the sources');

  mod.retryProfileMerge(batch);
  assert.equal(JSON.parse(readFileSync(profileFile, 'utf8'))[0].attempts, 1);

  mod.commitProfileMerge(['fc_a', 'fc_b']);
  assert.equal(JSON.parse(readFileSync(profileFile, 'utf8')).length, 0);
});