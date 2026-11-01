/**
 * The bundle check exists because a silent config reset once cost an evening:
 * Desktop's fatal-error recovery restored the profile's bundle list and the
 * plugin simply stopped loading, with no error anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBundle } from '../index.js';

test('bundle check: present when the package is listed', () => {
  const manifest = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-soulbridge'] } } };
  const result = checkBundle(manifest);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'present');
});

test('bundle check: missing after a profile reset', () => {
  const manifest = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
  const result = checkBundle(manifest);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing');
  assert.deepEqual(result.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
});

test('bundle check: a manifest without a bundle list fails loudly, not silently', () => {
  assert.equal(checkBundle({}).ok, false);
  assert.match(checkBundle({}).reason, /no dsh\.profile\.bundles/);
});
