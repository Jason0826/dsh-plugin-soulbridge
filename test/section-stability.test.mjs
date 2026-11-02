/**
 * The system-prompt section must be the stable part (review finding: affect in
 * section).
 *
 * DSH declares this provider as `in-history`: every changed section text appends a
 * new prompt version that keeps counting until compaction. An affect sample changes
 * almost every turn, so carrying it here grew the prompt version by version.
 *
 * The behaviour lives in core (`includeAffect`), where it is tested; this test guards
 * the adapter side — the section call must keep both dynamic blocks out, and the
 * per-turn message call must keep the affect block in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('section: the stable prompt excludes affect and anchors', () => {
  const body = source.slice(source.indexOf('function buildInjection()'));
  const call = body.slice(0, 600);
  assert.match(call, /includeAnchors: false/, 'anchors drift with recency');
  assert.match(call, /includeAffect: false/, 'affect changes every turn');
});

test('section: the per-turn message still carries affect', () => {
  // The anchors call is the message channel: excluding soul/style but not affect is
  // what keeps the dynamic part in play without touching the prompt versions.
  const body = source.slice(source.indexOf('function buildRelatedContext('));
  const call = body.slice(0, 4000);
  assert.match(call, /includeStyle: false/);
  assert.doesNotMatch(call.slice(0, 2000), /includeAffect: false/, 'affect belongs here, not in the section');
});
