#!/usr/bin/env node
/**
 * 源码结构守卫 —— 两类"编译器看不见、跑起来才发现"的缺陷,改成静态可查。
 *
 * 这个文件里的两条守卫都不是假想的,各来自一次真实的返工。
 *
 * 守卫一:GLSL 模板字面量里不许出现反引号或 "${"
 * -------------------------------------------------
 * 着色器源码在本项目里写成  const SMOKE_VERT = [glsl 标记] + 反引号 ... 反引号。
 * 于是"在这段注释里写一对反引号包住一个常量名"这个**看起来完全正常的动作**,
 * 会把模板字面量从中间截断:后面的中文被当成 JS 表达式去解析。
 *
 * 代价不是报错,是**报错指错地方**。实际发生的那次:
 *   · rolldown 报 *Expected a semicolon*,指向被截断的那一行;
 *   · tsc 报 *Unterminated template literal*,指向**文件最后一行**;
 *   · 而 `node --check` **直接放行** —— 因为反引号是成对的,
 *     截断后重新配平,文件整体仍然是个合法 JS(内容是错的)。
 *
 * 第三条是最要命的:`node --check` 是这里默认的"先查一下语法"动作,
 * 而它对这类缺陷给出的答案是"没问题"。
 *
 * 守卫二:顶层的 const NAME = ... 必须在别处被引用
 * --------------------------------------------------
 * ParticleFx.ts 里同一个缺陷出现过**三次**(SMOKE_MAX_PUFFS、SMOKE_DRIFT,
 * 以及注释里残留的旧数值)。三者的共同形态是:
 *   一个常量没人读,但它的注释**替它说话** ——
 *   描述着一个不存在的机制(比如"烟横向漂移 0.5 米/秒")。
 * 后来的人读到注释,会以为机制存在。**没人读的常数不会报错,
 * 只有它的注释在骗人**,这是它比死代码更值得清的理由。
 *
 * ⚠️ 三个真实实例**都不是 export 的**。所以这条守卫必须同时匹配
 *    `const` 与 `export const` —— 只查 export 的话,它一个都抓不到。
 *    这正是"守卫自己也要被验证"的例子,见文件末尾的自检。
 *
 * 守卫三:src/ 的 TS 里不许出现种子字面量
 * -----------------------------------------
 * 底数原先在三个 TS 文件里各写了一份(`ParticleFx.ts` / `composition.ts`
 * / `rng.ts`),而它真正的来源是 `blender/config.py` —— 经 stats.json 流到
 * `src/data/spots.json`,再被人手抄进那三处。
 *
 * 手抄的代价不是"抄错"那一刻,是**换种子重新构建之后**:json 跟着变了,
 * 三份 TS 没变,网页上模型是新的、音乐和粒子还是旧种子。种子只决定
 * "哪一间铺子冒烟",所以画面上**看不出任何异常**,也不报错。
 *
 * 现在它们全部由 `src/data/seeds.ts` 从 json 派生。这条守卫负责别让它退回去:
 * **TS 里出现那个数就是缺陷**,注释里也算 —— 一句把数值写死的注释,会在换种子
 * 之后变成假话。
 *
 * ⚠️ 被扫的数是**从 spots.json 现读的**,不是写死在这个文件里的。否则种子一换,
 *    这条守卫会继续去查一个已经不存在的旧数值,然后永远打印"通过"。
 *
 * 用法:
 *   node tests/source_guards.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(ROOT, 'src');

/**
 * 守卫二的**豁免名单**。加进来必须写理由 —— 理由本身是这次豁免值不值钱的判据。
 *
 * ⚠️ 目前是空的,而且**曾经的那一条已经毕业了**:`SPOT_SEED` 原先是"故意没有
 *    调用方"的溯源字段,现在被 `data/seeds.ts` 当作全作品种子的底数读取,
 *    于是它不再需要豁免。豁免条目要在被豁免的东西找到真正的用途时删掉 ——
 *    留着的话,这条守卫会对它永久失明。
 */
const ALLOW_UNREFERENCED = new Map([]);

/**
 * 守卫四。扫 `page.evaluate(反引号 ... 反引号)` 这类**页内代码**所在的模板字面量。
 *
 * 为什么单独一条:守卫一写在 src/,而这类代码全在 tools/ 与 tests/。
 * 守卫一的"能力边界"里当时写着"那一类靠跑一次测试暴露" —— 这话对**截断**成立
 * (页面立刻抛 SyntaxError),对**转义**不成立:转义被吞掉之后,页内代码是合法的,
 * 它只是**算错了**,然后打印出一份看着很合理的读数。所以它必须静态查。
 *
 * 两条规则,都来自真实事故(都在 `tools/perf/once/tag_dump.mjs`):
 *
 *   ① 页内代码里出现**没转义的反引号** —— 会把外层模板字面量从中间截断。
 *      实际发生:注释里用「反引号包住一个标识符」做强调,截断之后
 *      `node --check` 直接放行(反引号成对,重新配平),报错位置指不到这里;
 *      而页内代码照样能跑,只是**算出来的东西不对**。
 *      判据不是"看见反引号"(转义过的反引号是合法的,页内要生成 HTML 就得用),
 *      而是**"模板在哪儿结束的"**:正常收尾后面只能跟逗号(还有参数)或右括号。
 *      跟着别的字符 = 提前结束了。
 *   ② 页内代码里出现**会被静默吞掉的反斜杠**。在模板字面量里:
 *        反斜杠+反斜杠+d → 页面收到 反斜杠+d(正则想要的就是这个)
 *        反斜杠+d        → 页面收到 d(无效转义,反斜杠被吃掉)
 *      于是正则退化成匹配字母 d,一次都匹配不上 —— 而读数照常打印。
 *
 *   允许的反斜杠:合法转义(`\n` `\t` 等)、`\\`、`\``、`\${`。
 *   ⚠️ 边界:`\b` `\n` `\t` `\r` `\f` `\v` `\0` 在**正则里**是元字符,在字符串里
 *      是合法转义 —— 这条守卫按后者的口径判,**不会**报它们。写成 `/x\b/` 的人
 *      仍然拿不到他想要的东西,这一半得靠人读。
 */
const OK_BACKSLASH_LETTERS = 'nrtbfvxu0';
const BAD_BACKSLASH_PUNCT = '.+-()[]{}^?|*';

/**
 * 把源码里**所有的模板字面量**找出来,并且只返回它们**字面量部分**的位置区间
 * (被 `${...}` 插进去的那段代码不算)。
 *
 * 为什么要一个真的扫描器,而不是几行正则
 * --------------------------------------
 * 第一版就是正则:找「反引号 + 内容 + 反引号 + 右括号」。实跑一次,
 * 它在 162 段上报了 **60 多条**,全是误报,三种原因各来一遍:
 *
 *   · 收尾找错:`page.evaluate(模板, {returnByValue:true})` 的收尾反引号后面
 *     跟的是**逗号**,不是右括号 —— 于是它一路找到下一个 evaluate 的收尾,
 *     把中间整段当成了页内代码;
 *   · 分不清「转义的反引号」:页内代码里要生成 HTML 时会写一个被转义的反引号,
 *     它能看见反引号、看不见前面那个反斜杠,于是报"会把模板截断";
 *   · 分不清「两个反斜杠」:正则里正确写法是反斜杠+反斜杠+d,它的循环逐字符走,
 *     第二个反斜杠又和后一个 d 组成一对,于是合法的写法被报成"无效转义"。
 *
 * ⚠️ 这三条都不是"手滑",是**用模式匹配去解析一门语言**必然的失败方式。
 *    一条 60/162 误报的守卫会被直接无视,那样比没有守卫更坏(同守卫二那段)。
 *    所以这里改用一个小状态机:注释 / 普通字符串 / 模板字面量三种状态分开走,
 *    `${` 进入代码态、配对的 `}` 回到模板态,反斜杠在字符串与模板里都吃掉两格。
 *    它不需要理解 JS 的语法,只需要**认得出自己在哪一层**。
 */
function scanTemplateLiterals(text) {
  const out = [];
  const stack = [{ kind: 'code', braces: 0 }];
  let i = 0;
  let segStart = -1; // 当前模板字面量里这一段"字面量"的起点
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    const top = stack[stack.length - 1];
    if (top.kind === 'code') {
      if (c === '/' && d === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && d === '*') {
        i = text.indexOf('*/', i + 2);
        i = i < 0 ? text.length : i + 2;
        continue;
      }
      if (c === "'" || c === '"') {
        i++;
        while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
        i++;
        continue;
      }
      if (c === '`') {
        const node = { start: i, segs: [], end: -1 };
        out.push(node);
        stack.push({ kind: 'template', node });
        i++;
        segStart = i;
        continue;
      }
      if (c === '{') { top.braces++; i++; continue; }
      if (c === '}') {
        if (top.braces === 0 && stack.length > 1) { stack.pop(); i++; continue; }
        top.braces--; i++; continue;
      }
      i++;
      continue;
    }
    // —— 模板字面量态 ——
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      const t = stack.pop();
      t.node.segs.push({ start: segStart, end: i });
      t.node.end = i;
      i++;
      continue;
    }
    if (c === '$' && d === '{') {
      stack[stack.length - 1].node.segs.push({ start: segStart, end: i });
      stack.push({ kind: 'code', braces: 0 });
      i += 2;
      continue;
    }
    i++;
  }
  return out;
}

function checkPageCode(files) {
  const problems = [];
  let blocks = 0;
  const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
  // 页内代码的调用点:`page.evaluate(` / `page.send(` 后面跟一个模板字面量
  // (允许换行、允许缩进)。`page.screenshot(模板)` 是**路径**,不是页内代码,
  // 所以这里只认这两个方法名,不认"后面跟模板的都算"。
  const CALL = /\.(?:evaluate|send)\(\s*$/;
  for (const { f, text } of files) {
    const skipWs = (idx) => {
      let j = idx;
      while (j < text.length && /[ \t\r\n]/.test(text[j])) j++;
      return j;
    };
    const templates = scanTemplateLiterals(text);
    const byStart = new Map(templates.map((t) => [t.start, t]));
    for (const t of templates) {
      if (!CALL.test(text.slice(Math.max(0, t.start - 60), t.start))) continue;
      // 页内代码常常是**几段模板拼起来的**:`…` + `…`。所以要顺着加号把整条链
      // 走完 —— 只看第一段的话,它的收尾后面跟的是加号,会被误判成"提前结束"
      // (第一版正则就是在这儿报了 4 条误报的)。
      const chain = [t];
      for (;;) {
        const cur = chain[chain.length - 1];
        if (cur.end < 0) break;
        const plus = skipWs(cur.end + 1);
        if (text[plus] !== '+') break;
        const next = byStart.get(skipWs(plus + 1));
        if (!next) break;
        chain.push(next);
      }
      blocks++;
      // ① 截断:页内代码里出现一个没转义的反引号,会让模板**提前结束**。
      //    判据不是"看见反引号"(转义过的反引号是合法的),而是**整条链的收尾
      //    后面跟的是什么**:正常只有逗号(还有参数)或右括号(参数完了)。
      const last = chain[chain.length - 1];
      if (last.end < 0) {
        problems.push(`${relative(ROOT, f)}:${lineOf(text, last.start)} page.evaluate 的模板字面量没有收尾`);
      } else {
        const nxt = text[skipWs(last.end + 1)];
        if (nxt !== ',' && nxt !== ')') {
          problems.push(`${relative(ROOT, f)}:${lineOf(text, last.end)} page.evaluate 的模板字面量在这个反引号处**提前结束**了` +
            `(收尾后面跟的是 "${nxt ?? '文件尾'}")—— 页内代码里多半有一个没转义的反引号。` +
            ` 前后:…${text.slice(Math.max(0, last.end - 40), last.end + 20).split('\n').join('⏎').trim()}`);
        }
      }
      for (const piece of chain) {
        for (const seg of piece.segs) {
          const body = text.slice(seg.start, seg.end);
          let line = lineOf(text, seg.start);
          for (let k = 0; k < body.length; k++) {
            const ch = body[k];
            if (ch === '\n') { line++; continue; }
            if (ch !== '\\') continue;
            const nb = body[k + 1];
            const bad =
              (nb >= 'a' && nb <= 'z' && !OK_BACKSLASH_LETTERS.includes(nb)) ||
              (nb >= 'A' && nb <= 'Z') ||
              BAD_BACKSLASH_PUNCT.includes(nb);
            if (bad) {
              const src = body.slice(Math.max(0, k - 30), k + 30).split('\n').pop();
              problems.push(`${relative(ROOT, f)}:${line} 页内代码里的 "\\${nb}" 是**无效转义**, ` +
                `页面收到的是 "${nb}"(反斜杠被吞掉)—— 想传给页面一个反斜杠要写两个。` +
                ` 行:…${src.trim()}`);
            }
            k++; // 合法的转义吃两格,别把第二个字符再当一次起点
          }
        }
      }
    }
  }
  return { problems, blocks };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ── 两条守卫的检测逻辑,写成纯函数,好让末尾的自检直接调用 ──────────────

/** 守卫一。返回问题条目数组。 */
function checkGlslTemplates(files) {
  const problems = [];
  let blocks = 0;
  for (const { f, text } of files) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/\/\*\s*glsl\s*\*\/\s*`\s*$/.test(lines[i])) continue;
      // 收尾用项目里统一的写法:单独一行、只有反引号加分号。
      // **不能**用"下一个反引号"当收尾 —— 那正是会被缺陷骗到的找法:
      // 截断处的那个反引号会被当成收尾,于是内容看起来干干净净。
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*`;\s*$/.test(lines[j])) { end = j; break; }
      }
      if (end < 0) {
        problems.push(`${relative(ROOT, f)}:${i + 1} 这段 glsl 模板字面量找不到收尾行(单独一行的 反引号+分号)`);
        continue;
      }
      blocks++;
      for (let j = i + 1; j < end; j++) {
        if (lines[j].includes('`')) {
          problems.push(`${relative(ROOT, f)}:${j + 1} glsl 模板字面量里出现反引号 —— ` +
            `会把着色器源码截断,且 node --check 查不出来`);
        }
        if (lines[j].includes('${')) {
          problems.push(`${relative(ROOT, f)}:${j + 1} glsl 模板字面量里出现美元花括号 —— ` +
            `会被当成 JS 插值,同样截断着色器`);
        }
      }
    }
  }
  return { problems, blocks };
}

/**
 * 守卫二。只在 src/ 内部数引用。
 *
 * 注意:被 tools/ 或 tests/ 引用的常量会因此**被误报**,豁免名单要给它们留位置。
 * 宁可误报要人去豁免,也不要把搜索范围放大到整个仓库 —— 放大的话,一个常量
 * 只要被某个一次性探针提过一次就永远不会再被这条守卫看见,
 * 而一次性探针是最先被删掉的东西。
 */
function checkUnreferenced(files) {
  const problems = [];
  let decls = 0;
  // 顶层 = 行首无缩进。函数内部的 const 不在此列:那些常常是单次使用,
  // 报出来是噪音,而噪音会让整条守卫被无视。
  const DECL = /^(?:export )?const ([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=/gm;
  for (const { f, text } of files) {
    for (const m of text.matchAll(DECL)) {
      const name = m[1];
      decls++;
      if (ALLOW_UNREFERENCED.has(name)) continue;
      // 数"别处"的引用:声明那一处算 1,所以总数 > 1 才算有人读。
      const used = files.some(({ text: t }) =>
        (t.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length > 1);
      if (!used) {
        problems.push(`${relative(ROOT, f)} 顶层常量 ${name} 在 src/ 里没有任何引用 —— ` +
          `若它只是溯源/文档字段,加进 ALLOW_UNREFERENCED 并写理由;否则删掉,` +
          `因为它那句注释正在替一个不存在的机制作证`);
      }
    }
  }
  return { problems, decls };
}

/**
 * 守卫三。扫的是**传入的那个种子**,不是本文件里的字面量。
 *
 * 种子位数太少时**拒绝扫描并如实说明** —— 一个 4 位数的种子会命中源码里
 * 到处都是的数字,报出来的全是误报;而"扫不了"与"没有"必须分开报,
 * 否则这一条会变成另一个"从不报警的警报器"。
 */
function checkSeedLiterals(files, seed) {
  const s = String(seed);
  if (!Number.isInteger(seed) || s.length < 5) {
    return { problems: [], scanned: false, seed, why: `种子 ${s} 不足 5 位,字面量扫描会全是误报` };
  }
  // 前后不许再有数字:避免把 120240601 这种更长的数误判成种子。
  const re = new RegExp(`(?<!\\d)${s}(?!\\d)`);
  const problems = [];
  for (const { f, text } of files) {
    text.split('\n').forEach((line, i) => {
      if (re.test(line)) {
        problems.push(`${relative(ROOT, f)}:${i + 1} 出现种子字面量 ${s} —— ` +
          `种子只许出现在 src/data/*.json(数据)与 blender/config.py(源头),` +
          `TS 里一律从 data/seeds.ts 派生。注释里写死的数值会在换种子之后变成假话`);
      }
    });
  }
  return { problems, scanned: true, seed };
}

// ── 自检:守卫本身先被证明能抓到它该抓的东西 ──────────────────────────
// 这一段存在的理由:守卫二的第一版只写了 `^export const`,而三个真实实例
// **全都没 export** —— 那条守卫会一次都抓不到,却每次都打印"通过"。
// 一个从不报警的警报器,比没有警报器更危险。
const SELF_TEST = [
  {
    name: '守卫一 能抓到 glsl 里的反引号',
    run: () => checkGlslTemplates([{
      f: 'fixture.ts',
      text: 'const V = /* glsl */ `\nvoid main() {\n' +
        '  // 这里有个 `NAME` 反引号\n}\n`;\n',
    }]).problems.length === 1,
  },
  {
    name: '守卫一 能抓到 glsl 里的插值',
    run: () => checkGlslTemplates([{
      f: 'fixture.ts',
      text: 'const V = /* glsl */ `\nfloat a = ${x};\n`;\n',
    }]).problems.length === 1,
  },
  {
    name: '守卫一 对干净的 glsl 不误报',
    run: () => checkGlslTemplates([{
      f: 'fixture.ts',
      text: 'const V = /* glsl */ `\nvoid main() { gl_Position = vec4(1.0); }\n`;\n',
    }]).problems.length === 0,
  },
  {
    name: '守卫二 能抓到**没有 export** 的无引用常量(三个真实实例都是这种)',
    run: () => checkUnreferenced([{
      f: 'fixture.ts',
      // 文件里除了声明处再无此名 → 必须报。
      text: 'const SMOKE_DRIFT = 0.5;\nexport function f() { return 1; }\n',
    }]).problems.length === 1,
  },
  {
    name: '守卫二 能抓到 export 的无引用常量',
    run: () => checkUnreferenced([{
      f: 'fixture.ts',
      text: 'export const DEAD_THING = 3;\n',
    }]).problems.length === 1,
  },
  {
    name: '守卫二 对被引用的常量不误报',
    run: () => checkUnreferenced([{
      f: 'fixture.ts',
      text: 'const A = 1;\nexport function f() { return A; }\n',
    }]).problems.length === 0,
  },
  {
    name: '守卫三 能抓到代码里的种子字面量',
    run: () => checkSeedLiterals([{
      f: 'fixture.ts',
      text: 'const FX_SEED = 20240601 + 4093;\n',
    }], 20240601).problems.length === 1,
  },
  {
    name: '守卫三 能抓到**注释里**的种子字面量(注释一样会过期)',
    run: () => checkSeedLiterals([{
      f: 'fixture.ts',
      text: '/** 种子是 20240601 */\nexport const A = 1;\n',
    }], 20240601).problems.length === 1,
  },
  {
    name: '守卫三 不把更长的数字串误判成种子',
    run: () => checkSeedLiterals([{
      f: 'fixture.ts',
      text: 'const T = 120240601;\n',
    }], 20240601).problems.length === 0,
  },
  {
    name: '守卫三 对没有种子的源码不误报',
    run: () => checkSeedLiterals([{
      f: 'fixture.ts',
      text: "import { FX_SEED } from '../data/seeds';\nconst a = FX_SEED + 1;\n",
    }], 20240601).problems.length === 0,
  },
  {
    // 页内注释里用反引号做强调 → 模板提前结束。这里期望的是**报出来**,
    // 而且报的是"提前结束"而不是"看见反引号"。
    name: '守卫四 能抓到页内代码里没转义的反引号(表现为提前结束)',
    run: () => {
      const r = checkPageCode([{
        f: 'fixture.mjs',
        text: 'await page.evaluate(`(() => {\n  // 强调 `x` 这个名字\n  return 1;\n})()`);\n',
      }]);
      return r.problems.length === 1 && r.problems[0].includes('提前结束');
    },
  },
  {
    name: '守卫四 能抓到**会被吞掉的反斜杠**(正则里的 \\d)',
    run: () => checkPageCode([{
      f: 'fixture.mjs',
      text: 'await page.evaluate(`(() => {\n  return /^a\\d+/.test(x);\n})()`);\n',
    }]).problems.length === 1,
  },
  {
    name: '守卫四 不误报**合法写法** \\\\d(两个反斜杠)',
    run: () => checkPageCode([{
      f: 'fixture.mjs',
      text: 'await page.evaluate(`(() => {\n  return /^a\\\\d+/.test(x);\n})()`);\n',
    }]).problems.length === 0,
  },
  {
    name: '守卫四 不误报合法转义 \\n / \\t',
    run: () => checkPageCode([{
      f: 'fixture.mjs',
      text: 'await page.evaluate(`(() => {\n  return "a\\nb\\tc";\n})()`);\n',
    }]).problems.length === 0,
  },
  {
    // 页内自己要用模板字面量(生成 HTML 之类)必须写成 反斜杠+反引号,
    // 那是**对的**写法,不能报。
    name: '守卫四 不误报页内**转义过的**反引号',
    run: () => checkPageCode([{
      f: 'fixture.mjs',
      text: 'await page.evaluate(`(() => {\n  const t = \\`hi\\`;\n  return t;\n})()`);\n',
    }]).problems.length === 0,
  },
  {
    // 收尾后面跟逗号(带 options 的 evaluate)是正常写法 —— 第一版正则
    // 在这里把后面整段都当成页内代码,误报就是这么来的。
    name: '守卫四 不误报收尾后跟逗号的写法',
    run: () => checkPageCode([{
      f: 'fixture.mjs',
      text: 'await page.evaluate(`(() => { return 1; })()`, { returnByValue: true });\n',
    }]).problems.length === 0,
  },
  {
    // 真实写法:`evaluate( 第一段 + 第二段 )`。只看第一段的收尾会误报"提前结束"。
    name: '守卫四 不误报**几段模板拼起来**的页内代码',
    run: () => checkPageCode([{
      f: 'fixture.mjs',
      text: 'await page.evaluate(\n  `(() => { const a = [${x}], ` +\n' +
        '  `b = [${y}]; return a.concat(b); })()`,\n);\n',
    }]).problems.length === 0,
  },
  {
    name: '守卫四 不管 evaluate 之外的模板字面量(边界,不是漏洞)',
    run: () => checkPageCode([{
      f: 'fixture.mjs',
      text: 'console.log(`普通日志 \\d 随便写`);\n',
    }]).problems.length === 0,
  },
  {
    name: '守卫三 位数太少的种子报"没扫",而不是报"通过"',
    run: () => {
      const r = checkSeedLiterals([{ f: 'fixture.ts', text: 'const a = 42;\n' }], 42);
      return r.scanned === false && r.problems.length === 0 && typeof r.why === 'string';
    },
  },
];

console.log('── 守卫自检 ──');
let selfFailed = 0;
for (const t of SELF_TEST) {
  const ok = t.run();
  if (!ok) selfFailed++;
  console.log(`  ${ok ? '✅' : '❌'} ${t.name}`);
}
if (selfFailed) {
  console.log('');
  console.log(`  ❌ 自检有 ${selfFailed} 项没过 —— 守卫本身坏了,下面的扫描结果不可信。`);
  process.exitCode = 1;
}

// ── 扫描真实源码 ──────────────────────────────────────────────────────
// 守卫一、二、三扫 src/(TS);守卫四扫 tools/ 与 tests/ —— 页内代码在这两处。
const files = walk(SRC).filter((f) => /\.tsx?$/.test(f))
  .map((f) => ({ f, text: readFileSync(f, 'utf8') }));
const probeFiles = [...walk(join(ROOT, 'tools')), ...walk(join(ROOT, 'tests'))]
  .filter((f) => /\.mjs$/.test(f))
  .map((f) => ({ f, text: readFileSync(f, 'utf8') }));

// 被扫的种子**现读**自 spots.json —— 写死在这里的话,种子一换,这条守卫
// 会继续去查一个已经不存在的旧数值,然后永远打印"通过"。
const spotsDoc = JSON.parse(readFileSync(join(SRC, 'data', 'spots.json'), 'utf8'));

const g1 = checkGlslTemplates(files);
const g2 = checkUnreferenced(files);
const g3 = checkSeedLiterals(files, spotsDoc.seed);
const g4 = checkPageCode(probeFiles);

console.log('');
console.log('── 扫描 src/ ──');
console.log(`  守卫一:${g1.blocks} 段 glsl 模板字面量`);
console.log(`  守卫二:${g2.decls} 个顶层常量(豁免 ${ALLOW_UNREFERENCED.size} 个)`);
console.log(g3.scanned
  ? `  守卫三:扫种子 ${g3.seed}(读自 src/data/spots.json)`
  : `  守卫三:⚠️ 没扫成 —— ${g3.why}`);
console.log('── 扫描 tools/ + tests/ ──');
console.log(`  守卫四:${g4.blocks} 段 page.evaluate 模板字面量`);

const problems = [...g1.problems, ...g2.problems, ...g3.problems, ...g4.problems];
console.log('');
if (problems.length) {
  for (const p of problems) console.log(`  ❌ ${p}`);
  console.log('');
  console.log(`  ${problems.length} 项失败`);
  process.exitCode = 1;
} else if (!g3.scanned) {
  console.log(`  ⚠️ 其余守卫通过,但守卫三**没跑成**(${g3.why})—— 不算通过。`);
  process.exitCode = 1;
} else if (!selfFailed) {
  console.log('  ✅ 四项守卫都通过');
  console.log('');
  console.log('  ⚠️ 四条守卫各自的能力边界:');
  console.log('     · 守卫一只覆盖本项目写成 glsl 标记的模板字面量(src/ 内)。');
  console.log('       原话是"tools/ 与 tests/ 里那类截断靠跑一次测试暴露,因为页面内');
  console.log('       代码会立刻抛 SyntaxError" —— **这句话错了一半,现已改由守卫四');
  console.log('       承担**。错的是一半:截断确实会在某些行上抛 SyntaxError,但');
  console.log('       反斜杠被吞掉那类**不抛**,它只是算错,然后打印一份看着很合理的');
  console.log('       读数。当时那句话把两类混成了一句。');
  console.log('     · 守卫二只数 src/ 内的引用,所以被探针引用的常量会误报。');
  console.log('       它查的是"有没有人读",**查不出"读了但读错了"**;');
  console.log('       也查不出"常量是活的、但它的注释在描述一个不存在的机制" ——');
  console.log('       SMOKE_DRIFT 的注释就是这么错的,那一半只能靠人读。');
  console.log('     · 守卫三只保证"TS 里没有那个数",**不保证派生出来的值是对的**。');
  console.log('       有人把 BASE_SEED 改成常量、或把偏移量改错,它一样通过 ——');
  console.log('       那一半由 data/seeds.ts 的结构(底数只有一个来源)承担,');
  console.log('       不由这条守卫承担。');
  console.log('       它也扫不到 json 与 blender/config.py —— 那两处正是种子**应该**');
  console.log('       在的地方,所以这是边界,不是漏洞。');
  console.log('     · 守卫四只认**紧挨着** `.evaluate(` / `.send(` 的模板字面量。');
  console.log('       页内代码先存进变量、再传进去的写法它看不到 —— 那样写的话,');
  console.log('       这一条守卫对它完全失明。');
  console.log('       它也查不出 `\\b` 那类"在正则里是元字符、在字符串里是合法转义"');
  console.log('       的用错(见函数注释里的边界说明),那一半只能靠人读。');
}
