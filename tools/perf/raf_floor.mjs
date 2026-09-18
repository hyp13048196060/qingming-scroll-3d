#!/usr/bin/env node
/**
 * rAF 自己的节拍地板是多少 —— 以及它为什么让 `loop.stats()` 的 p95 不能当帧时。
 *
 * 这是本项目的量具校准件。无头 Chrome 的 rAF 大约跑在 33Hz,
 * 于是**任何**在没有其它负载时测到的"帧时"都会趋近 30ms。
 * 如果不先把这个地板量出来,就会把 30ms 读成"作品每帧花了 30 毫秒",
 * 进而去优化一个本来有 3~4 倍余量的场景。
 *
 * 用法: node tools/perf/raf_floor.mjs
 */
import { launch, sleep } from './lib/cdp.mjs';
const W = 1920, H = 1080;
const { page, close } = await launch({ width: W, height: H });
try {
  // ① 空页面:不含本作品任何代码,量到的是纯粹的这个浏览器的 rAF 节奏。
  //
  // ⚠️ 必须**重复测**。第一版只测了一次,读到 30.26ms 就写进报告说
  //    "无头 Chrome 的 rAF 节拍约 33Hz" —— 后来重跑却读到 6.1ms。
  //    也就是说这个地板本身是**不稳定**的(随合成器状态与机器负载变),
  //    不是一个可以引用的常数。只测一次就把它当成常数,
  //    等于用一把刻度会变的尺子去校准另一把尺子。
  const samples = [];
  for (let i = 0; i < 8; i++) {
    await page.goto('about:blank');
    samples.push(await page.evaluate(`(async () => {
      const ts = [];
      await new Promise((res) => { let n = 0;
        const f = (t) => { ts.push(t); if (++n < 200) requestAnimationFrame(f); else res(); };
        requestAnimationFrame(f); });
      const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
      d.sort((a, b) => a - b);
      const r2 = (v) => Math.round(v * 100) / 100;
      return { p50: r2(d[Math.floor(d.length * 0.5)]), p95: r2(d[Math.floor(d.length * 0.95)]) };
    })()`));
  }
  const p50s = samples.map((s) => s.p50).sort((a, b) => a - b);
  console.log('① 空页面 rAF 节拍地板(重复 8 次,每次 200 帧):');
  console.log(`   p50 逐次: ${samples.map((s) => s.p50).join(', ')}`);
  console.log(`   → 中位 ${p50s[4]}ms,最小 ${p50s[0]}ms,最大 ${p50s[7]}ms`);
  console.log('   → **地板本身不稳定**,不是一个可引用的常数。\n');

  // ② 同一台机器上,作品自己的 rAF 口径读数 + 连渲口径读数,并排看
  console.log('② 作品自身的两种口径:');
  console.log('   档位   rAF口径 p50 / p95 / max        连渲口径 p50 / p95        (后者才是开销)');
  for (const q of ['low', 'mid', 'high']) {
    await page.goto(`http://127.0.0.1:4173/?q=${q}&hud=0&spot=bridge`);
    await page.waitForReady({ timeout: 180000 });
    await sleep(8000);
    await page.evaluate('window.__QM__.loop.resetStats()');
    await sleep(8000);
    const f = await page.evaluate('window.__QM__.loop.stats()');
    const b = await page.evaluate('window.__QM__.measureFrameCost(150)');
    console.log(
      `   ${q.padEnd(5)}  ${String(f.p50).padStart(7)} / ${String(f.p95).padStart(7)} / ${String(f.max).padStart(7)}   ` +
      `  ${String(b.p50).padStart(7)} / ${String(b.p95).padStart(7)}`,
    );
  }
} finally { await close(); }
