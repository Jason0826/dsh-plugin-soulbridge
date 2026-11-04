/**
 * The daily bill, from the platform's own usage export.
 *
 * Host-side operations, not soulbridge: the memory layer stores what happened and
 * never what it cost, so it has no price logic and must not grow one. This script
 * reads the provider's export and nothing else. See docs/cost-visibility.md.
 *
 * Where the money went used to be one line per day: the export says "¥100.22 over
 * 6,028 requests" and nothing about which day, which token class, or whether the
 * number is self-consistent. This reads the export's two CSVs and prints the
 * table, then recomputes the amount from `price × amount` — if the platform's
 * price table changes, that column goes off and the script says so instead of
 * quietly printing a number nobody checked.
 *
 * Money has exactly one source: this export. The plugin counts requests and
 * tokens per turn (trace.jsonl `turn-cost`) but never prices them.
 *
 * Usage:
 *   node scripts/billing.mjs                       # newest usage_data_*.zip in the export folder
 *   node scripts/billing.mjs --zip <file.zip>      # a specific export
 *   node scripts/billing.mjs --dir <folder>        # already-extracted CSVs
 *   node scripts/billing.mjs --days 7 --json
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * Folders the platform export is downloaded into, in order. One declaration:
 * `SOULBRIDGE_USAGE_DIR` overrides it without editing this file.
 */
const DEFAULT_EXPORT_DIRS = [
  process.env.SOULBRIDGE_USAGE_DIR,
  'D:/Download',
  join(homedir(), 'Downloads'),
].filter(Boolean);

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const days = Number(argValue('--days') ?? 0) || 0;

/** Read a zip into `{ name: text }`; entries here are small CSVs, so no streaming. */
function unzip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_558); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x0605_4b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const entries = buffer.readUInt16LE(eocd + 10);
  let entry = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < entries; n += 1) {
    if (buffer.readUInt32LE(entry) !== 0x0201_4b50) throw new Error('damaged zip central directory');
    const method = buffer.readUInt16LE(entry + 10);
    const compressedSize = buffer.readUInt32LE(entry + 20);
    const nameLength = buffer.readUInt16LE(entry + 28);
    const extraLength = buffer.readUInt16LE(entry + 30);
    const commentLength = buffer.readUInt16LE(entry + 32);
    const localOffset = buffer.readUInt32LE(entry + 42);
    const name = buffer.toString('utf8', entry + 46, entry + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    if (method === 0) files.set(name, data.toString('utf8'));
    else if (method === 8) files.set(name, inflateRawSync(data).toString('utf8'));
    else throw new Error(`unsupported zip compression ${method} for ${name}`);
    entry += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Split one CSV line, honouring double quotes. The export quotes nothing today. */
function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/**
 * Parse a CSV into row objects. A row whose width does not match the header is an
 * error: silently dropping it would make the total quietly wrong.
 */
function parseCsv(text, label) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error(`${label}: empty file`);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line, index) => {
    const cells = splitCsvLine(line);
    if (cells.length !== header.length) {
      throw new Error(`${label} line ${index + 2}: ${cells.length} cells, expected ${header.length}`);
    }
    return Object.fromEntries(header.map((key, column) => [key, cells[column]]));
  });
}

/** Locate the export: an explicit zip, an explicit folder, or the newest zip in a known folder. */
function locateExport() {
  const zipPath = argValue('--zip');
  if (zipPath) {
    if (!existsSync(zipPath)) throw new Error(`no such file: ${zipPath}`);
    return { kind: 'zip', path: zipPath };
  }
  const dir = argValue('--dir');
  if (dir) {
    if (!existsSync(dir)) throw new Error(`no such folder: ${dir}`);
    return { kind: 'dir', path: dir };
  }
  const candidates = [];
  for (const folder of DEFAULT_EXPORT_DIRS) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      if (!/^usage_data_.*\.zip$/.test(name)) continue;
      const file = join(folder, name);
      candidates.push({ path: file, mtime: statSync(file).mtimeMs });
    }
  }
  if (candidates.length === 0) {
    throw new Error(`no usage_data_*.zip in ${DEFAULT_EXPORT_DIRS.join(', ')}; pass --zip <file> or --dir <folder>`);
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return { kind: 'zip', path: candidates[0].path };
}

function readExport(where) {
  if (where.kind === 'dir') {
    const files = readdirSync(where.path);
    const costName = files.find((name) => /^cost-.*\.csv$/i.test(name));
    const amountName = files.find((name) => /^amount-.*\.csv$/i.test(name));
    if (!costName || !amountName) throw new Error(`${where.path} needs cost-*.csv and amount-*.csv`);
    return {
      source: where.path,
      cost: readFileSync(join(where.path, costName), 'utf8'),
      amount: readFileSync(join(where.path, amountName), 'utf8'),
    };
  }
  const entries = unzip(readFileSync(where.path));
  const names = [...entries.keys()];
  const costName = names.find((name) => /^cost-.*\.csv$/i.test(name));
  const amountName = names.find((name) => /^amount-.*\.csv$/i.test(name));
  if (!costName || !amountName) throw new Error(`${where.path} needs cost-*.csv and amount-*.csv`);
  return { source: where.path, cost: entries.get(costName), amount: entries.get(amountName) };
}

const M = 1_000_000;
const dayOf = (iso) => String(iso).slice(0, 10);
/**
 * One day's tally. Tokens and money are kept per class: tokens alone hide where
 * the money went (output is ~1000x the price of a cached input token).
 */
const blank = () => ({
  billed: 0,
  requests: 0,
  hit: 0,
  miss: 0,
  output: 0,
  calls: 0,
  hitMoney: 0,
  missMoney: 0,
  outputMoney: 0,
  callMoney: 0,
  wallets: new Set(),
  keys: new Set(),
});

const where = locateExport();
const raw = readExport(where);
const costRows = parseCsv(raw.cost, 'cost CSV');
const amountRows = parseCsv(raw.amount, 'amount CSV');

const byDay = new Map();
const touch = (day) => {
  if (!byDay.has(day)) byDay.set(day, blank());
  return byDay.get(day);
};

for (const row of costRows) {
  const day = touch(dayOf(row.start_time_iso));
  day.billed += Number(row.cost) || 0;
  if (row.wallet_type) day.wallets.add(row.wallet_type);
}

const seenTypes = new Set();
for (const row of amountRows) {
  const day = touch(dayOf(row.start_time_iso));
  const amount = Number(row.amount) || 0;
  const price = Number(row.price) || 0;
  if (row.api_key_name) day.keys.add(row.api_key_name);
  seenTypes.add(row.type);
  switch (row.type) {
    case 'request_count':
      day.requests += amount;
      break;
    case 'input_cache_hit_tokens':
      day.hit += amount;
      day.hitMoney += price * amount;
      break;
    case 'input_cache_miss_tokens':
      day.miss += amount;
      day.missMoney += price * amount;
      break;
    case 'output_tokens':
      day.output += amount;
      day.outputMoney += price * amount;
      break;
    case 'function_call':
      day.calls += amount;
      day.callMoney += price * amount;
      break;
    default:
      throw new Error(`unknown usage type "${row.type}" in the amount CSV — the export format changed`);
  }
}

/** What the export's own unit prices say the day cost; must match `billed`. */
const computedOf = (d) => d.hitMoney + d.missMoney + d.outputMoney + d.callMoney;

const allDays = [...byDay.keys()].sort();
const window = days > 0 ? allDays.slice(-days) : allDays;
if (window.length === 0) throw new Error('the export contains no days');

const total = blank();
for (const day of window) {
  const d = byDay.get(day);
  total.billed += d.billed;
  total.requests += d.requests;
  total.hit += d.hit;
  total.miss += d.miss;
  total.output += d.output;
  total.calls += d.calls;
  total.hitMoney += d.hitMoney;
  total.missMoney += d.missMoney;
  total.outputMoney += d.outputMoney;
  total.callMoney += d.callMoney;
  for (const wallet of d.wallets) total.wallets.add(wallet);
  for (const key of d.keys) total.keys.add(key);
}

const inputOf = (d) => d.hit + d.miss;
const sumTokens = (d) => d.hit + d.miss + d.output;
const computed = computedOf(total);
const report = {
  source: raw.source,
  window: { from: window[0], to: window[window.length - 1], days: window.length },
  days: window.map((day) => {
    const d = byDay.get(day);
    return {
      date: day,
      billed: Number(d.billed.toFixed(6)),
      requests: d.requests,
      hit: d.hit,
      miss: d.miss,
      output: d.output,
      functionCalls: d.calls,
      computed: Number(computedOf(d).toFixed(6)),
      money: {
        cacheHit: Number(d.hitMoney.toFixed(6)),
        cacheMiss: Number(d.missMoney.toFixed(6)),
        output: Number(d.outputMoney.toFixed(6)),
        functionCall: Number(d.callMoney.toFixed(6)),
      },
      wallets: [...d.wallets],
      keys: [...d.keys],
    };
  }),
  totals: {
    billed: Number(total.billed.toFixed(6)),
    computed: Number(computed.toFixed(6)),
    requests: total.requests,
    hit: total.hit,
    miss: total.miss,
    output: total.output,
    functionCalls: total.calls,
    perRequest: total.requests === 0 ? null : Number((total.billed / total.requests).toFixed(6)),
    cacheHitShareOfInput: inputOf(total) === 0 ? null : Number((total.hit / inputOf(total)).toFixed(4)),
    money: {
      cacheHit: Number(total.hitMoney.toFixed(6)),
      cacheMiss: Number(total.missMoney.toFixed(6)),
      output: Number(total.outputMoney.toFixed(6)),
      functionCall: Number(total.callMoney.toFixed(6)),
    },
  },
  check: {
    diff: Number((computed - total.billed).toFixed(6)),
    diffRatio: total.billed === 0 ? null : Number(((computed - total.billed) / total.billed).toFixed(4)),
    pass: total.billed !== 0 && Math.abs(computed - total.billed) / total.billed <= 0.01,
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const money = (value) => value.toFixed(2).padStart(8);
const millions = (value) => (value / M).toFixed(1).padStart(7);
/** What share of the day's money each token class took: the reason to look at a day at all. */
const mix = (d) => {
  const sum = computedOf(d);
  if (sum === 0) return '—';
  return [d.hitMoney, d.missMoney, d.outputMoney].map((part) => `${Math.round((part / sum) * 100)}%`).join('/');
};

console.log(`usage billing — ${report.window.from} … ${report.window.to}（${report.window.days} 天）`);
console.log(`来源 ${basename(raw.source)}`);
console.log('');
console.log('日期         金额¥    请求    ¥/请求   输入命中M  输入未命中M  输出M   钱花在 命中/未命中/输出');
for (const day of report.days) {
  const d = byDay.get(day.date);
  const perRequest = d.requests === 0 ? '   —  ' : (d.billed / d.requests).toFixed(4).padStart(7);
  console.log(
    `${day.date}  ${money(d.billed)}  ${String(d.requests).padStart(6)}  ${perRequest}  ${millions(d.hit)}  ${millions(d.miss)}  ${millions(d.output)}   ${mix(d)}`,
  );
}
const totalPerRequest = total.requests === 0 ? '—' : (total.billed / total.requests).toFixed(4);
console.log(
  `合计        ${money(total.billed)}  ${String(total.requests).padStart(6)}  ${totalPerRequest.padStart(7)}  ${millions(total.hit)}  ${millions(total.miss)}  ${millions(total.output)}   ${mix(total)}`,
);
console.log('');
const shareOf = (part, whole) => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`);
console.log(`输入 token 占 ${shareOf(inputOf(total), sumTokens(total))}，其中缓存命中 ${shareOf(total.hit, inputOf(total))}`);
console.log(`金额构成：输入命中 ${shareOf(total.hitMoney, computed)} / 输入未命中 ${shareOf(total.missMoney, computed)} / 输出 ${shareOf(total.outputMoney, computed)}`);
console.log(`插件调用（function_call）${total.calls} 次，¥${total.callMoney.toFixed(2)}`);
console.log(
  `单价复核：按 price×amount 重算 ¥${computed.toFixed(2)}，账单 ¥${total.billed.toFixed(2)}，差 ${report.check.diffRatio === null ? '—' : `${(report.check.diffRatio * 100).toFixed(2)}%`} ${report.check.pass ? 'PASS' : 'WARN（单价或口径变了，先查导出）'}`,
);
if (total.wallets.size > 1 || !total.wallets.has('Paid')) {
  console.log(`钱包：${[...total.wallets].join(' / ') || '—'}`);
}
if (total.keys.size > 1) {
  console.log(`API key：${[...total.keys].join(' / ')}`);
}
if (window[window.length - 1] === new Date().toISOString().slice(0, 10)) {
  console.log('注意：最后一天可能还没过完，金额会小于整日。');
}
console.log('');
console.log('口径：平台导出的 cost.csv（金额）与 amount.csv（请求/三类 token/单价）；只读，不上传。');
