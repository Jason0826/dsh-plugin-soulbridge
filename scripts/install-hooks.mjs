/**
 * Turn the artifact check into a commit gate for every repo we work in.
 *
 * `core.hooksPath` is local git config, so it has to be set once per clone. This script does
 * that and refuses to pretend it worked: it prints the resolved path and the hook command.
 *
 *   node scripts/install-hooks.mjs            # this repo
 *   node scripts/install-hooks.mjs --check    # exit 1 when hooks are not installed
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const check = process.argv.includes('--check');
const root = process.cwd();
const hooksDir = join(root, 'scripts', 'githooks');
const hookFile = join(hooksDir, 'pre-commit');

if (!existsSync(hookFile)) {
  console.error(`缺少 ${hookFile}`);
  process.exit(1);
}

const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
const configured = current.stdout.trim();

if (check) {
  if (configured !== hooksDir && configured !== 'scripts/githooks') {
    console.error(`pre-commit 钩子未安装（core.hooksPath=${configured || '未设置'}）`);
    process.exit(1);
  }
  console.log(`pre-commit 钩子已安装（${configured}）`);
  process.exit(0);
}

const set = spawnSync('git', ['config', 'core.hooksPath', hooksDir], { encoding: 'utf8' });
if (set.status !== 0) {
  console.error(set.stderr.trim());
  process.exit(1);
}
try {
  chmodSync(hookFile, 0o755);
} catch {
  // Windows ignores the mode; git still runs the hook through sh.
}
console.log(`core.hooksPath -> ${hooksDir}`);
console.log('提交时会跑 scripts/check-diff-artifacts.mjs；命中替换/编码痕迹则拒绝提交。');
