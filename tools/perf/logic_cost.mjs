#!/usr/bin/env node
/**
 * rAF 的间隔里,那些不在渲染上的时间到底在哪 —— 四种口径并排量。
 *
 * ## 为什么要做这个
 *
 * 报告里原本写着"无头 Chrome 的 rAF 节拍地板约 33Hz(30.26ms),所以
 * rAF 口径的 p95 不是帧时"。这个说法**已被推翻**:
 * `tools/perf/raf_floor.mjs` 在空页面上重复测 8 次,每次都读到 **6.1ms**。
 * 30.26 是一次离群值(那一轮 max 是 200ms,机器在忙)。
 *
 * 所以现在的状态是:
 *   - 渲染只要 ~4ms(连渲口径,逐帧 gl.finish,还是偏保守的上界)
 *   - rAF 间隔却是 24~30ms
 *   - 而空页面的地板只有 6.1ms
 *
 * **中间那 ~20ms 没有出处。** 它只有两种可能:作品自己的 CPU 逻辑,
 * 或者无头浏览器的合成/呈现路径。本脚本就是把这两种分开:
 *
 *   A  rAF 间隔        —— 真循环里两次回调的间隔(合成器节拍)
 *   B  只绘制          —— measureFrameCost,不含任何逻辑
 *   C  只逻辑          —— frameStep(..., false),不含任何绘制
 *   D  逻辑 + 绘制     —— frameStep(..., true),真循环里一帧的 CPU 总开销
 *
 * 判读:
 *   - 若 C 很大 → 时间在作品的逻辑里,那是**真缺陷**,该去优化逻辑;
 *   - 若 C 很小而 A 远大于 D → 时间在浏览器侧,那是**量具的性质**,
 *     报告里只能如实说"这一段未定位",不能说成作品的开销,
 *     更不能像我上一版那样编一个"节拍地板"去解释它。
 *
 * 用法: node tools/perf/logic_cost.mjs [--spot bridge] [--n 240]
 */
import { launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const SPOT = arg('--spot', 'bridge');
const N = Number(arg('--n', 240));
const W = 1920, H = 1080;
const WARMUP_MS = 8000, MEASURE_MS = 8000;

const { page, close, browserVersion } = await launch({ width: W, height: H });
const rows = [];
try {
  console.log(`视口 ${W}×${H}  spot=${SPOT}  逻辑步数 ${N}  浏览器 ${browserVersion}\n`);

  // ① 空页面地板:必须**每次重测**,不能引用一个常数。
  await page.goto('about:blank');
  const floor = await page.evaluate(`(async () => {
    const ts = [];
    await new Promise((res) => { let n = 0;
      const f = (t) => { ts.push(t); if (++n < 200) requestAnimationFrame(f); else res(); };
      requestAnimationFrame(f); });
    const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
    d.sort((a, b) => a - b);
    const r2 = (v) => Math.round(v * 100) / 100;
    return { p50: r2(d[Math.floor(d.length * 0.5)]), p95: r2(d[Math.floor(d.length * 0.95)]) };
  })()`);
  console.log(`空页面 rAF 地板(本次实测): p50=${floor.p50}ms  p95=${floor.p95}ms\n`);

  for (const q of ['low', 'mid', 'high']) {
    await page.goto(`http://127.0.0.1:4173/?q=${q}&hud=0&spot=${SPOT}`);
    await page.waitForReady({ timeout: 180000 });
    await sleep(WARMUP_MS);

    await page.evaluate('window.__QM__.loop.resetStats()');
    await sleep(MEASURE_MS);
    const raf = await page.evaluate('window.__QM__.loop.stats()');
    const render = await page.evaluate(`window.__QM__.measureFrameCost(${N})`);
    // 只逻辑:跑两遍,取第二遍 —— 第一遍会把 JIT 还没热的那些分支算进来
    await page.evaluate(`window.__QM__.measureLogicCost(${N}, false)`);
    const logic = await page.evaluate(`window.__QM__.measureLogicCost(${N}, false)`);
    const both = await page.evaluate(`window.__QM__.measureLogicCost(${N}, true)`);

    rows.push({ q, raf: raf.p50, render: render.p50, logic: logic.p50, both: both.p50,
                logicP95: logic.p95, bothP95: both.p95, renderP95: render.p95 });
    console.log(
      `${q.padEnd(5)} A rAF间隔 ${String(raf.p50).padStart(7)}ms   ` +
      `B 只绘制 ${String(render.p50).padStart(6)}ms   ` +
      `C 只逻辑 ${String(logic.p50).padStart(6)}ms   ` +
      `D 逻辑+绘制 ${String(both.p50).padStart(6)}ms   ` +
      `| A − D = ${(raf.p50 - both.p50).toFixed(2)}ms`,
    );
  }
} finally {
  await close();
}

console.log('\n逐档细看(p50 / p95):');
for (const r of rows) {
  console.log(`  ${r.q.padEnd(5)} 只逻辑 ${r.logic} / ${r.logicP95}   逻辑+绘制 ${r.both} / ${r.bothP95}   只绘制 ${r.render} / ${r.renderP95}`);
}

/**
 * 判读。**这一段是脚本自己算的,不是我读表后手写的** ——
 * 免得又一次"看着差不多就下结论"。
 */
const worst = rows.reduce((a, b) => (b.both > a.both ? b : a));
const gap = worst.raf - worst.both;
console.log('\n判读:');
console.log(`  逻辑最重的一档是 ${worst.q}:${worst.logic}ms(占其 rAF 间隔的 ${(worst.logic / worst.raf * 100).toFixed(1)}%)`);
console.log(`  该档 rAF 间隔 ${worst.raf}ms − 一帧 CPU 总开销 ${worst.both}ms = ${gap.toFixed(2)}ms`);
if (worst.logic > worst.raf * 0.5) {
  console.log('  → 逻辑吃掉了 rAF 间隔的一半以上。这是作品侧的真实开销,应当去优化逻辑。');
} else if (gap > 8) {
  console.log('  → 逻辑很轻,缺口主要不在作品这一侧。**这一段未定位**,');
  console.log('    报告里如实写"未定位",不得写成作品开销,也不得再编一个节拍地板去解释。');
} else {
  console.log('  → 逻辑与渲染合起来已经能解释 rAF 间隔,缺口不大。');
}
