/**
 * Backfill extraction from history, oldest first, through the plugin's own writer.
 *
 * Why a script: an earlier batch of 108 was written from outside the writer, got
 * capped to 50, and left no trace. This one goes through `enqueueExtraction` (the one
 * writer, with its cap and its log) and picks turns that have **no fact yet**, starting
 * from the oldest — so threads form in the order they happened and a half-done backfill
 * is resumable by running it again.
 *
 * Keep the request below the cap (50) by a few: every new turn adds one item, and the
 * cap keeps the newest, so a full queue would displace the oldest backfill items.
 *
 *   node scripts/requeue-history.mjs 40
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
  .prepare(
    `SELECT t.id, t.turn_no, t.user_text
       FROM turns t
      WHERE length(trim(t.user_text)) >= 3
        AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.source_turn_id = t.id)
      ORDER BY t.started_at ASC
      LIMIT ?`,
  )
  .all(count);
const remaining = db
  .prepare(
    `SELECT COUNT(*) n
       FROM turns t
      WHERE length(trim(t.user_text)) >= 3
        AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.source_turn_id = t.id)`,
  )
  .get();
db.close();
if (rows.length === 0) {
  console.log('没有待抽取的轮次（都已经有事实了）');
  process.exit(0);
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
console.log(
  `待抽取总数 ${remaining.n}；本次请求 ${rows.length}，新增 ${added}，队列文件现在 ${size()} 条` +
    `（最早 ${rows[0].turn_no}，最晚 ${rows.at(-1).turn_no}）`,
);
