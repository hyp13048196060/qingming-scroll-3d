/**
 * 逐个文件做语法检查,一个都不许挂。
 *
 * 为什么需要这个检查:本仓库的探针大量使用
 *
 *     await page.evaluate(`(() => { ... })()`)
 *
 * 这种**把整段代码塞进模板字符串**的写法。模板字符串里出现一个反引号,
 * 字符串就被就地截断,后半段变成游离的代码 —— 整个文件再也跑不起来。
 *
 * 2026-09-18 真的踩了这一次:tools/perf/shot.mjs 里有一条注释,上一行还在
 * 警告"注释里不能出现反引号",下一行就写了两个(`?tod=` 与 `?wire=`)。
 * 结果是**截图工具整个无法解析**,而没人发现 —— 因为没有任何环节会去
 * 解析这些工具,它们只在被人工调用时才报错,不调就一直是"正常的"。
 *
 * 这类失败不产生错误输出、不影响构建、不进 typecheck(.mjs 不在 tsconfig
 * 的 include 里),是完全静默的。所以必须有人真的把它们挨个解析一遍。
 *
 * 跑法:
 *     node tools/check_syntax.mjs
 *
 * 只看 .js/.mjs/.cjs。**TypeScript 不归这里管**(node --check 不认 .ts),
 * 那部分由 `npm run typecheck` 覆盖。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 要扫的目录。src/ 里只有 AudioWorklet 那一个 .js,顺带一起查。 */
const SCAN_DIRS = ['src', 'tools', 'tests', 'scripts'];

/** 不进去的目录名(依赖、产物、缓存)。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-audio-probe', '.git', '.fontbuild']);

const EXTS = new Set(['.js', '.mjs', '.cjs']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在就跳过,不算失败
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (EXTS.has(extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))).sort();

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    // 只留第一行"哪一行、哪个 token",堆栈对定位没有帮助
    const msg = String(err.stderr || '')
      .split('\n')
      .slice(0, 2)
      .join(' ')
      .trim();
    console.log(`✗ ${rel}`);
    console.log(`    ${msg}`);
  }
}

console.log(`\n语法检查: ${files.length} 个文件,${failed} 个失败`);
if (failed > 0) {
  console.log('这些文件**无法被解析**,任何调用都会立刻崩。修好再提交。');
  process.exit(1);
}
