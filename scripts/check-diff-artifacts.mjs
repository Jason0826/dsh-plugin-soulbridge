/**
 * Refuse to commit the damage we keep producing by hand.
 *
 * This is the structural fix for a memory rule that failed four times: "do not edit code with
 * shell string replacement". The rule cannot be trusted to fire at the decision point, so the
 * commit is blocked instead.
 *
 * Scans the *staged* diff only — uncommitted work elsewhere is none of the hook's business.
 * Exit 1 with a specific line, or 0 when the staged change is clean.
 *
 *   node scripts/check-diff-artifacts.mjs        # staged diff (used by pre-commit)
 *   node scripts/check-diff-artifacts.mjs HEAD   # a commit range, for manual checks
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const target = process.argv[2] ?? '--cached';
const git = (args) => {
  const out = spawnSync('git', args, { encoding: 'utf8' });
  if (out.status !== 0) {
    console.error(out.stderr.trim());
    process.exit(2);
  }
  return out.stdout;
};

const problems = [];

// 1. Added lines: a newline written as backtick-n, or a line whose first word lost its first
//    letter (ode/pm/px/ot) because a replace ate it.
const diff = git(['diff', target, '--unified=0']);
let file = '(unknown)';
for (const line of diff.split('\n')) {
  const header = /^\+\+\+ b\/(.+)$/.exec(line);
  if (header) file = header[1];
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  const added = line.slice(1);
  // In PowerShell a double-quoted string writes a newline as backtick + n on purpose, so
  // flagging it made the gate refuse its own deploy script. The accident this catches is a
  // literal backtick-n in text or code where a real newline was meant, so .ps1 files are exempt.
  if (!/\.ps1$/i.test(file) && /\u0060n(?![A-Za-z])/.test(added)) {
    problems.push(`${file}: 换行写成了反引号+n：${added.slice(0, 60)}`);
  }
  if (/^(ode|pm|px|ot) /.test(added)) problems.push(`${file}: 行首残片（首字母被吃掉）：${added.slice(0, 40)}`);
}

// 2. Staged files that are not valid UTF-8 (a tool wrote them in the system code page).
const stagedFiles = git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
  .split('\n')
  .map((name) => name.trim())
  .filter(Boolean);
const decoder = new TextDecoder('utf-8', { fatal: true });
for (const name of stagedFiles) {
  if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|db|sqlite|woff2?)$/i.test(name)) continue;
  try {
    const buffer = readFileSync(name);
    decoder.decode(buffer);
    if (buffer.toString('utf8').includes('\uFFFD')) problems.push(`${name}: 含替换字符 U+FFFD`);
  } catch (error) {
    if (error?.code === 'ENOENT') continue; // deleted after staging
    problems.push(`${name}: 不是合法 UTF-8（可能被 GBK 写入）`);
  }
}

if (problems.length > 0) {
  console.error('\n提交被拒绝：检测到替换/编码事故的痕迹。\n');
  for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
  if (problems.length > 20) console.error(`  …… 还有 ${problems.length - 20} 处`);
  console.error('\n修法：受影响的文件用编辑器改回正常文本，别用 shell 替换。');
  console.error('若确认是误报（例如文档就是要展示反引号+n），改用 `git commit --no-verify` 并说明原因。\n');
  process.exit(1);
}
process.exit(0);
