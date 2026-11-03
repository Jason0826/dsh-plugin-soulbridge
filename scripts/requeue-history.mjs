/**
 * Requeue the last N turns for extraction, through the plugin's own writer.
 *
 * Why a script: an earlier batch of 108 was written from outside the writer, got
 * capped to 50, and left no trace. This one goes through `enqueueExtraction` (the one
 * writer, with its cap and its log), and prints the file after each write so a batch
 * that shrinks is visible immediately.
 *
 *   node scripts/requeue-history.mjs 20
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
process.env.SOULBRIDGE_HOME = HOME;

const count = Math.max(1, Number(process.argv[2] ?? 10));
const db = new DatabaseSync(join(HOME, 'soul.db'), { readOnly: true });
const rows = db
  .prepare('SELECT id, turn_no, user_text FROM turns ORDER BY started_at DESC LIMIT ?')
  .all(count * 3)
  .filter((row) => String(row.user_text ?? '').trim().length >= 2)
  .slice(0, count)
  .reverse();
db.close();
if (rows.length === 0) {
  console.error('没有可排队的轮次');
  process.exit(1);
}

const { enqueueExtraction } = await import('../index.js');
const queueFile = join(HOME, 'pending-extract.json');
const size = () => {
  try {
    const raw = JSON.parse(readFileSync(queueFile, 'utf8'));
    return Array.isArray(raw) ? raw.length : -1;
  } catch {
    return -1;
  }
};

let added = 0;
for (const row of rows) {
  if (enqueueExtraction(String(row.id), Number(row.turn_no))) added += 1;
}
console.log(`请求 ${rows.length} 条，新增 ${added} 条，队列文件现在 ${size()} 条`);
