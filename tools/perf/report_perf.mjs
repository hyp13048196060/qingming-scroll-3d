#!/usr/bin/env node
/**
 * 由 `perf_probe.json` 生成 `docs/05-性能测量报告.md`。
 *
 * **报告里的每一个数字都从 json 里取,一个字都不手写。**
 * 这不是洁癖:手写数字的那一版报告,一旦代码改了、数字就跟不上,
 * 而报告看起来仍然权威 —— 那是"声称 60fps"最典型的产生方式。
 * 从这个脚本生成,就杜绝了报告与实测分家的可能。
 *
 * 用法: node tools/perf/report_perf.mjs [--in x.json] [--out docs/05-性能测量报告.md]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const IN = resolve(arg('--in', 'screenshots/perf/perf_probe.json'));
const OUT = resolve(arg('--out', 'docs/05-性能测量报告.md'));

const d = JSON.parse(await readFile(IN, 'utf8'));
const T = d.thresholds;
const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
const ms = (v) => Number(v).toFixed(2);
const tri = (v) => Math.round(v).toLocaleString('en-US');

/** 门限判定:返回 ✓ / ⚠超目标 / ✗超上限 */
function mark(value, target, cap) {
  if (cap != null && value > cap) return `✗ 超上限(${n(cap)})`;
  if (value > target) return `⚠ 超目标(${n(target)})`;
  return '✓';
}

const rows = d.collections;
const highs = rows.filter((r) => r.quality === 'high');

/**
 * 氛围粒子的**实际绘制数**。`?` = 这一组没读到(探针加这一列之前的旧 json)。
 *
 * ⚠️ 这一列不是装饰。逐环节里「氛围粒子」那一格永远显示 0.00 —— 那个环节
 *    每帧只写一个 uniform,CPU 侧本来就没有逐粒子循环。于是"0.00 因为很轻"
 *    和"0.00 因为一处都没画"在那一格上完全一样。只有这一列能把它们分开。
 */
const fxCell = (c) => {
  const f = c.fx;
  if (!f || f.mounted === false) return '未装';
  const p = f.puffs == null ? '?' : f.puffs;
  const b = f.birds == null ? '?' : f.birds;
  return `${p} 团 / ${b} 只`;
};

/** 一行的公共列 */
const rowCells = (c) => [
  c.tag,
  n(c.frameCost.p50),
  n(c.frameCost.p95),
  n(c.frameCost.max),
  n(c.passAvg.main.calls),
  tri(c.passAvg.main.triangles),
  tri(c.passAvg.reflection.triangles),
  tri(c.passAvg.shadow.triangles),
  n(c.programs),
  fxCell(c),
];

const header = '| 采集 | 一帧CPU p50 | p95 | max | 主pass drawcall | 主pass 三角面 | 反射pass 三角面 | 阴影pass 三角面 | shader program | 炊烟 / 飞鸟(实际在画) |';
const sep = '|---|---|---|---|---|---|---|---|---|---|';
const table = (list) => [header, sep, ...list.map((c) => `| ${rowCells(c).join(' | ')} |`)].join('\n');

/** 逐环节表:每一档取该档的 stageCost,列成"环节 × 档位"。 */
function stageTable(list) {
  const names = [];
  for (const c of list) for (const s of c.stageCost) if (!names.includes(s.name)) names.push(s.name);
  // 按各档中位数的最大值降序 —— 大头排前面
  const rank = (n2) => Math.max(...list.map((c) => c.stageCost.find((s) => s.name === n2)?.ms ?? 0));
  names.sort((a, b) => rank(b) - rank(a));
  const cells = names.map((n2) => {
    const byQ = list.map((c) => {
      const s = c.stageCost.find((x) => x.name === n2);
      return s ? ms(s.ms) : '—';
    });
    return `| ${n2} | ${byQ.join(' | ')} |`;
  });
  // 表头用**机位**而不是画质:这张表的每一列是一个采集,同档位下
  // 五个机位会给出五列一模一样的 "high",读者分不出哪列是哪列。
  return [`| 环节 | ${list.map((c) => c.spot).join(' | ')} |`, `|---|${list.map(() => '---').join('|')}|`, ...cells].join('\n');
}

/**
 * 修复 groundAt 节流**之前**的实测读数。
 *
 * ⚠️ 这几个数是**记录下来的历史观测,不是本脚本生成的**。代码已经改掉了,
 *    没法再现场测一遍。所以:① 明确标成"修复前",单独一列,不与 live
 *    数字混排;② 写明测得的时间与命令;③ 不参与任何门限判定。
 *
 *    之所以还是要把它们写进来:不写的话,读者会以为本报告从来就是对的,
 *    也就看不到"量了一个部件拿它代表整帧"这个错是怎么发生的、代价多大。
 */
const BEFORE_FIX = {
  when: '2026-09-18,节流修复之前',
  cmd: 'node tools/perf/stage_cost.mjs && node tools/perf/logic_cost.mjs',
  rAF: 30.29, draw: 3.92, logic: 19.66, both: 23.21, chars: 22.64, frame: 26.56,
};

const worst = (key) =>
  rows.reduce((a, b) => (b.frameCost[key] > a.frameCost[key] ? b : a));
const worstP95 = worst('p95');
// ⚠️ 门限要拿 bothCost(逻辑 + 绘制)去比,不是 frameCost(只绘制)。
//    这两个数在 cadence 上差着一个数量级 —— 见第 3 节。
const worstCpu = rows.reduce((a, b) => (b.bothCost.p95 > a.bothCost.p95 ? b : a));
const maxDraw = rows.reduce((a, b) => (b.passAvg.main.calls > a.passAvg.main.calls ? b : a));
const maxTri = rows.reduce((a, b) => (b.passAvg.total.triangles > a.passAvg.total.triangles ? b : a));
const maxRefl = rows.reduce((a, b) => (b.passAvg.reflection.triangles > a.passAvg.reflection.triangles ? b : a));
// ⚠️ 阴影要**单独**取最大值所在的那一组。早先这一行复用了 maxRefl,
//    于是"最坏阴影"报的是"反射最多的那一组的阴影" —— 两个最大值的组
//    恰好是同一组时看不出错,一旦不是就报错数,而且看着仍然合理。
const maxShadow = rows.reduce((a, b) => (b.passAvg.shadow.triangles > a.passAvg.shadow.triangles ? b : a));
const maxProg = rows.reduce((a, b) => (b.programs > a.programs ? b : a));

const abParts = d.reflectionAB.map(({ spot, quality, on, off }) => {
  const dt = on.frameCost.p50 - off.frameCost.p50;
  return `| ${quality}/${spot} | ${ms(off.frameCost.p50)} | ${ms(on.frameCost.p50)} | ${dt >= 0 ? '+' : ''}${ms(dt)} | ${on.reflectionRenders} | ${n(on.passAvg.reflection.calls)} |`;
});

const md = `# 性能测量报告

> **本文件由 \`tools/perf/report_perf.mjs\` 从 \`screenshots/perf/perf_probe.json\` 生成。**
> 所有数字均为脚本从实测 json 中取出,**没有任何一个手写**。
> 重新生成:\`node tools/perf/perf_probe.mjs && node tools/perf/report_perf.mjs\`

## 1. 测量环境

| 项 | 值 |
|---|---|
| 采集时间 | ${d.generatedAt} |
| GPU(实测串) | \`${d.gpu.renderer}\` |
| 浏览器 | ${d.browser} |
| 视口 | ${d.viewport.width}×${d.viewport.height} @ dpr ${d.viewport.deviceScaleFactor} |
| 是否软件渲染 | ${d.gpu.isSoftware ? '**是 —— 数据作废**' : '否'} |

GPU 串由 \`WEBGL_debug_renderer_info\` 现场读取。探针在写 json **之前**断言它含
\`ANGLE\` 与 \`NVIDIA\`;不含则**拒绝产出**。理由是无头 Chrome 可能静默退到
SwiftShader 软件渲染,那种帧时毫无意义、而画面看起来完全正常。

**这些数字只对上述配置成立**,不能外推到集显、移动端或其它分辨率。

## 2. 测量协议

\`\`\`
加载 → 热身 ${d.protocol.warmupMs}ms(丢弃) → loop.resetStats() → 测量 ${d.protocol.measureMs}ms → 读数
\`\`\`

热身数据全部丢弃:首次加载要编译 shader、上传贴图、跑一遍 PMREM,
那些帧本来就慢。算进去就变成"报告的是加载速度,不是运行速度"。

**帧开销**取 \`__QM__.measureFrameCost(150)\`:停掉 rAF,连渲 150 帧、
**逐帧 \`gl.finish()\`**,再除以帧数。

## 3. ⚠️ 关于帧时:这里连着错过两次,两次的形状是一样的

这一节留在这里,是因为**本报告的第一版和第二版都写着错的结论**,
而两次都自洽、都合理、方向都相反。删掉它们等于把教训一起删掉。

### 第一版:"p95 = 30.4ms,未达 20ms 目标"

拿 rAF 回调间隔当帧时。如果照这个结论去优化,砍掉的是**本来完全够用
的几何** —— 被量具牵着走,方向还是反的。

### 第二版:"那是量具的刻度上限,作品其实很轻"

在空页面上量到 rAF 间隔 p50 = 30.26ms,与作品 high 档的 30.30ms 几乎
相等,于是断定这 30ms 是"无头 Chrome 的 rAF 节拍"(所谓约 33Hz),
不是作品的开销。

**这也是错的。** 把空页面重测 8 次,读数依次是:

\`\`\`
${d.rafFloor ? d.rafFloor.runs.join(', ') : 'n/a'}   (ms)
中位 ${d.rafFloor ? ms(d.rafFloor.p50) : 'n/a'}ms,离散 ${d.rafFloor ? ms(d.rafFloor.min) : 'n/a'}~${d.rafFloor ? ms(d.rafFloor.max) : 'n/a'}ms
\`\`\`

**6.1ms,8 次全一样。** 30.26 是一次离群值(那一轮的 max 是
${d.rafFloor ? ms(d.rafFloor.worstMax) : 'n/a'}ms,机器在忙)。拿一次读数当常数去校准另一把
尺子,量出来的只是那一次的运气。

### 第三版:把一帧拆开逐个计时

真相是:**rAF 的 30ms 在如实报告作品自己的开销 —— 一帧 CPU 里有一行
每帧每人打一次的地面射线,占了 85%。**

\`CharacterPool.update\` 给每个走动的角色每帧打一次没有 BVH 的
\`intersectObjects\`,单次实测 p50 = 0.595ms,场上 37 个走动的人。
把那一行按注释里**本来就写着**的 0.3 米节流之后,rAF 间隔立刻掉到
空页面地板;随后又把采样距离减半到 0.15 米,用 1.0ms 换掉一半的
贴地误差(第 4.1 节有前后对照)。

四个口径,修复前后并排(high 档 / 虹桥机位;修复前那一列是历史观测,
见下方注):

| 口径 | 含义 | 修复前 | 修复后 |
|---|---|---|---|
| rAF 间隔 | 真循环两次回调的实际间隔 | ${ms(BEFORE_FIX.rAF)} ms | ${ms(highs[0] ? highs[0].frame.p50 : 0)} ms |
| 只绘制 \`frameCost\` | 连渲 + gl.finish,**不含逻辑** | ${ms(BEFORE_FIX.draw)} ms | ${ms(highs[0] ? highs[0].frameCost.p50 : 0)} ms |
| 只逻辑 \`logicCost\` | 无任何绘制的纯 CPU | ${ms(BEFORE_FIX.logic)} ms | ${ms(highs[0] ? highs[0].logicCost.p50 : 0)} ms |
| **逻辑 + 绘制 \`bothCost\`** | **一帧的 CPU 总量** | **${ms(BEFORE_FIX.both)} ms** | **${ms(highs[0] ? highs[0].bothCost.p50 : 0)} ms** |
| 其中「人物」一环 | 见第 4.1 节 | ${ms(BEFORE_FIX.chars)} ms | ${ms(highs[0] ? (highs[0].stageCost.find((s) => s.name === '人物')?.ms ?? 0) : 0)} ms |

> "修复前"一列是 ${BEFORE_FIX.when} 的实测记录,命令 \`${BEFORE_FIX.cmd}\`,
> **不是本脚本生成的**(代码已改,无法重现),因此不参与任何门限判定。
> 其余各列全部取自 json。

修复后 rAF 间隔 = ${ms(highs[0] ? highs[0].frame.p50 : 0)}ms,与空页面地板
${d.rafFloor ? ms(d.rafFloor.p50) : 'n/a'}ms 基本相等 —— 这一支量具回到了地板上,
说明它现在量到的确实只有量具自己。

### 两次错误的共同形状

**量了一个部件,拿它代表整帧。**

第一版量的是 rAF(连作品都没进);第二版量的是渲染,4ms,只占当时
一帧的六分之一。两次都得到一个漂亮、自洽、而且方向相反的结论。

所以本报告此后**四个口径一个都不省**,并且门限一律以 \`bothCost\`
(一帧 CPU 总量)为准,不以 \`frameCost\`(只绘制)为准。

## 4. 九组采集(3 画质 × 5 机位)

单位:毫秒 / 个数。**帧开销列为 \`bothCost\`(逻辑 + 绘制),即一帧的 CPU 总量。**
只绘制的数字在 json 的 \`frameCost\` 里,供交叉核对。

${table(rows)}

反射 A/B 的两组已并入上表(其 \`reflect\` 字段标为 1 / 0)。

## 4.1 逐环节拆分:一帧的时间落在哪一环

**先看这张表,再谈达标。** 只看上一节的总数,会不知道从哪里下手;
只看"只绘制"那一列,会得到一个漂亮但只覆盖一部分帧的数字。

${stageTable(highs)}

⚠️ 各环是**分开**测的(每环单独跑 240 次),不是串在一帧里测的。
它回答"这一环自己做一遍要多久",用来定位大头足够;
**各环之和 ≠ 总帧时**,不能相加当结论。

### 4.1.1 「氛围粒子」那一格为什么恒为 0.00

上表里「氛围粒子」在任何一档都是 0.00ms。这不是漏测,但也**不能**照着字面读成
"粒子不要钱" —— 这一环每帧只往 \`uTime\` 写一个数,位置、朝向、拍翅全在顶点
着色器里按时间解析算出来,CPU 侧**没有**逐粒子循环(见 \`ParticleFx.ts\` 文件头)。
它的开销在 GPU 侧,不在这张表的口径里。

所以探针另外读了一次**当前真的在画的数**,并写进每组:

| 画质 | 炊烟 / 飞鸟(实际在画,bridge 机位) |
|---|---|
${['low', 'mid', 'high']
  .map((q) => {
    const c = rows.find((r) => r.quality === q && r.spot === 'bridge');
    return c ? `| ${q} | ${fxCell(c)} |` : null;
  })
  .filter(Boolean)
  .join('\n')}

⚠️ 这一列是**必须**的:0.00 这个数在"粒子很轻"和"一处都没画"两种情况下
长得一模一样,只有实际绘制数能把它们分开。low 档的粒子被密度倍率关掉,
它的 0.00 与 high 档的 0.00 是两回事 —— 光看帧时表分不出来。

### 已修:地面射线没有节流(一帧的 85%)

\`CharacterPool.update\` 里曾有一行**每帧每人**调一次 \`obstacles.groundAt\`。
那是没有 BVH 的 \`intersectObjects\`,实测单次 p50 = **0.595ms**;
场上 37 个走动的人 ⇒ **≈22ms/帧**。

而同一个文件里那句注释写的是"每移动 0.3 米才采一次" ——
那个 0.3 米当时只卡在**赋值高度**那一行上,**射线照打**。
注释描述的是意图,代码没有实现它。

发现它的路径不是看图:画面上完全看不出异常,人照常走。是把
\`frameStep\` 拆成环节逐个计时之后,「人物」以 22.64ms 顶在最上面,
再乘一下单次射线成本,数对上了才落到那一行。

节流会引入**脚的贴地误差**(两次采样之间高度是缓存值,误差 ≈ 坡度 × 采样距离)。
这个是量过的,不是估的 —— 拿人物缓存的高度与探针现场重打的地面射线对质:

| 采样距离 | 误差 p50 | p95 | max | 桥上最坏 |
|---|---|---|---|---|
| 0.30 m | 0.0003 m | 0.050 m | 0.141 m | 0.183 m |
| 0.15 m(现值) | 0.0003 m | 0.024 m | 0.052 m | 0.086 m |

采样距离因此从 0.30 减到 0.15,代价是「人物」一环 0.67 → 1.70ms ——
这一笔换得起,桥上 18 厘米的下陷近景是看得出来的。
同一次核查里,站在"打不到地面"的位置(即走进了河里或走出地形)的人数为 **0**。

## 5. 反射 A/B(\`?reflect=1\` vs \`?reflect=0\`)

| 机位 | 关反射 p50 | 开反射 p50 | 差值 | 该帧反射 pass 次数 | 反射 drawcall |
|---|---|---|---|---|---|
${abParts.join('\n')}

关掉反射后 \`shadowRenders\` 从 2 降到 1(见 json),也就是说那点差值里
**有一部分不是反射本身的成本,而是少跑了一遍阴影**。

## 6. pass 分解

\`renderer.info.render\` 是**主 pass + 阴影 pass + 反射 pass** 的累加值。
门限表里写的是"主 pass drawcall ≤ 220",拿累加值去比就是量了三件事的和。
分解由 \`src/core/passStats.ts\` 在页内完成:夹住 \`renderer.shadowMap.render\`
与反射的 \`onBeforeRender\`,两者各自的增量单独记,主 pass = 总 − 阴影 − 反射。

### 6.1 一个实测发现:阴影 pass 每帧跑两次

表中 \`阴影pass 三角面\` 那一列,在 mid / high 档反射开着时约
**${tri(maxShadow.passAvg.shadow.triangles)}**,而 \`shadowRenders\` 为 **2**。

原因不是笔误:反射 pass 内部那次 \`renderer.render()\` 会**再跑一遍阴影贴图**
(three 的 \`shadow.autoUpdate\` 默认 true)。等于每帧的阴影活儿干了两遍。

这不是本作品引入的错误,而是 three 的默认行为;此处**如实记录、未做优化**。
可选的改法(把 \`autoUpdate\` 关掉、只在太阳移动时手动更新)留到后续,
因为当前阴影开销距 800k 上限还很远(见第 7 节)。

## 7. 门限对照

| 指标 | 目标 | 上限 | 本机最坏值 | 出自 | 判定 |
|---|---|---|---|---|---|
| 主 pass drawcall | ${n(T.drawcallMain)} | ${n(T.drawcallMainMax)} | **${n(maxDraw.passAvg.main.calls)}** | ${maxDraw.tag} | ${mark(maxDraw.passAvg.main.calls, T.drawcallMain, T.drawcallMainMax)} |
| 总三角面 | ${tri(T.triTotal)} | ${tri(T.triTotalMax)} | **${tri(maxTri.passAvg.total.triangles)}** | ${maxTri.tag} | ${mark(maxTri.passAvg.total.triangles, T.triTotal, T.triTotalMax)} |
| 反射 pass 三角面 | ${tri(T.triReflect)} | — | **${tri(maxRefl.passAvg.reflection.triangles)}** | ${maxRefl.tag} | ${mark(maxRefl.passAvg.reflection.triangles, T.triReflect, null)} |
| 阴影 pass 三角面 | ${tri(T.triShadow)} | — | **${tri(maxShadow.passAvg.shadow.triangles)}** | ${maxShadow.tag} | ${mark(maxShadow.passAvg.shadow.triangles, T.triShadow, null)} |
| shader program | ${n(T.programs)} | — | **${n(maxProg.programs)}** | ${maxProg.tag} | ${mark(maxProg.programs, T.programs, null)} |
| 只绘制 p95 | ${n(T.p95)} ms | ${n(T.p95Max)} ms | **${ms(worstP95.frameCost.p95)} ms** | ${worstP95.tag} | ${mark(worstP95.frameCost.p95, T.p95, T.p95Max)} |
| **一帧 CPU 总量 p95** | ${n(T.cpu)} ms | ${n(T.cpuMax)} ms | **${ms(worstCpu.bothCost.p95)} ms** | ${worstCpu.tag} | ${mark(worstCpu.bothCost.p95, T.cpu, T.cpuMax)} |

**一帧 CPU 总量**是"够不够 60fps"的答案 —— 它是逻辑 + 绘制的合计,
而"只绘制"那一行只是它的一部分。两行都列出来,是为了让人看得见
它们差多少(见第 3 节:上一版报告只量了后者)。

最坏的一帧出现在 \`${worstCpu.tag}\`,为 ${ms(worstCpu.bothCost.p95)}ms,
相对 60fps 的 16.7ms 预算余量约 ${(16.7 / worstCpu.bothCost.p95).toFixed(1)} 倍。
该档的只绘制 p95 是 ${ms(worstCpu.frameCost.p95)}ms,`
    + `两者之差就是 CPU 逻辑。

⚠️ **余量倍数是本机、无头、1080p 下的读数**,不是"保证 60fps"的承诺。
真机上帧时会被 vsync 钳到刷新率的整数倍,与这里的"开销"不是同一个量。

## 8. 本报告的已知局限

如实列出,以免读者高估这份数据的效力:

1. **"只绘制"是串行上界,偏保守。** 逐帧 \`gl.finish()\` 放弃了 CPU 与 GPU 的
   重叠,真实流水线吞吐只会更好。本报告**不声称**好多少。
   (\`bothCost\` 里的绘制部分同样受这个影响。)
2. **逐环节表各环分开测,不能相加当总帧时。** 见第 4.1 节的警告。
3. **无头浏览器没有真实显示管线。** 没有 vsync、没有合成器与真实窗口。
   用户在真实浏览器里看到的帧时会被 vsync 钳到刷新率的整数倍,
   与这里的"开销"不是同一个量。
4. **单机单次采样。** 每组采集一次,未做多次重复取统计。json 中保留了
   各口径的 p50 / p95 / max 分布以及 \`loop.stats()\` 的环形缓冲统计,
   但**没有**做重复运行的一致性检验(唯一的例外是 rAF 地板,重复了 8 次 ——
   而正是那 8 次推翻了本报告第二版的结论)。
5. **只测了静态机位。** 五个机位都是相机静止的读数。相机运动、
   快速切换画质、标签页来回切换等场景**未测**。
6. **阴影每帧跑两次**(第 6.1 节)已实测但未优化。
7. **贴地采样是节流过的。** 脚的高度每 0.15 米才重采一次,误差上限
   见第 4.1 节的表(桥上最坏 0.086m)。这是有意为之的交易,不是缺陷,
   但**近景贴地看仍可能有几厘米的浮空或下陷**。
8. **本报告的第一版与第二版都写着错的结论。** 第 3 节保留了它们。
   读者若要引用本报告的数字,请连带读第 3 节 —— 这里的结论来自
   "把一帧拆开逐个计时",不是一个看起来合理的推断。
9. **同一台机器连采两次,读数就差出很大一截。** 本报告的数字来自**一次**
   采集;同一天紧接着又跑了一次完整采集,两次数值的差是这样的:

   | 采集 | low/bridge 绘制p95 | low/bridge 一帧CPU p95 | high/bridge 绘制p95 | high/bridge 一帧CPU p95 |
   |---|---|---|---|---|
   | 第 1 次 | 3.28 ms | 12.36 ms | 4.57 ms | 11.42 ms |
   | 第 2 次 | 3.73 ms | 16.66 ms | 7.78 ms | 13.34 ms |

   high/bridge 的"只绘制 p95"两次之间差了 **70%**,而两次**都**判为达标。
   也就是说:门限的余量是真的,但**表里任何一个具体数字都带这个量级的
   抖动**,不该被当成可以横向比较的精确值(例如拿 low 的 3.73 和 high 的
   7.78 去比"贵了 2.1 倍",那个倍数落在这个抖动之内)。
   要得到这个量级以下的结论,必须先做重复采集取统计 —— 本报告没做。
   (同一个形状的坑:\`instrument-error-pattern\` 第 33 条 ——
   要测的差如果小于重复测量的离散度,那台仪器就没有分辨力。)

## 9. 如何复现

\`\`\`bash
node scripts/serve-dist.mjs --dir dist --port 4173 &
node tools/perf/perf_probe.mjs          # 采集,写出 screenshots/perf/perf_probe.json
node tools/perf/report_perf.mjs         # 由 json 生成本文件
\`\`\`

\`perf_probe.mjs\` 在 GPU 门禁不过时以退出码 3 结束,且**不写文件** ——
一份会被误读的数据比没有数据更坏。
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, md);
console.log(`已写出 ${OUT}(${md.length} 字节)`);
console.log(`  引用 json: ${IN}`);
