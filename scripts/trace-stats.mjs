#!/usr/bin/env node
/**
 * Summarise trace.jsonl: what a reply is actually made of.
 *
 * Usage:
 *   node scripts/trace-stats.mjs                 # all records
 *   node scripts/trace-stats.mjs --last 20       # most recent 20 messages
 *   node scripts/trace-stats.mjs --since 2026-10-31T16:00
 *   SOULBRIDGE_HOME=/path node scripts/trace-stats.mjs
 *
 * Reads block inventories only (types, sizes, tool names) — the trace never
 * contains user or assistant text.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const home = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const file = join(home, 'trace.jsonl');

let lines;
try {
  lines = readFileSync(file, 'utf8').trim().split('\n');
} catch {
  console.error(`no trace file at ${file}`);
  process.exit(1);
}

const since = opt('--since');
const last = Number(opt('--last') ?? 0);

let records = lines
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean)
  .filter((r) => (since ? r.ts >= since : true));

const messages = records.filter((r) => r.event === 'message');
const withBlocks = messages.filter((r) => Array.isArray(r.blocks) && r.blocks.length > 0);
const sample = last > 0 ? withBlocks.slice(-last) : withBlocks;

console.log(`trace: ${file}`);
console.log(`records=${records.length} messages=${messages.length} withBlocks=${withBlocks.length}`);

if (sample.length === 0) {
  console.log('no block records yet — the plugin version must be >= 0.0.43');
  process.exit(0);
}

const combos = new Map();
let reasoning = 0;
let text = 0;
let toolCalls = 0;
let args = 0;
for (const m of sample) {
  const types = m.blocks.map((b) => b.type).join('+');
  combos.set(types, (combos.get(types) ?? 0) + 1);
  for (const b of m.blocks) {
    if (b.type === 'reasoning') reasoning += b.chars ?? 0;
    if (b.type === 'text') text += b.chars ?? 0;
    if (b.type === 'tool-call') {
      toolCalls += 1;
      args += b.argsChars ?? 0;
    }
  }
}

const n = sample.length;
console.log(`\n== block combinations (${n} steps) ==`);
for (const [k, v] of [...combos].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}

const withText = sample.filter((m) => m.blocks.some((b) => b.type === 'text' && (b.chars ?? 0) > 0)).length;
console.log('\n== per step ==');
console.log(`  reasoning chars  ${(reasoning / n).toFixed(0)}`);
console.log(`  text chars       ${(text / n).toFixed(0)}`);
console.log(`  tool calls       ${(toolCalls / n).toFixed(2)}`);
console.log(`  tool args chars  ${(args / Math.max(1, toolCalls)).toFixed(0)} per call`);
console.log(`  steps with text  ${withText}/${n} (${((withText / n) * 100).toFixed(0)}%)`);

console.log('\n== last 8 steps ==');
for (const m of sample.slice(-8)) {
  const detail = m.blocks
    .map((b) => `${b.type}${b.chars ? ':' + b.chars : ''}${b.name ? '@' + b.name : ''}`)
    .join(' | ');
  console.log(`  turn=${m.turn} step=${m.step}  ${detail}`);
}
