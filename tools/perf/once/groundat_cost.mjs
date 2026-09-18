#!/usr/bin/env node
/**
 * `obstacles.groundAt` 单次调用有多贵 —— 一次性诊断,不进正式流程。
 *
 * 起因:`measureStageCost` 量出 `CharacterPool.update` 占了一帧的 85%(22.6ms),
 * 而这个循环本身看着很便宜(无分配、几个点测试)。它唯一的重活是
 * `groundAt` —— 没有 BVH 的 `intersectObjects`。本脚本量它单次多少钱,
 * 乘上"每帧调几次"就能判断它是不是那个 22ms,不用继续猜。
 */
import { launch, sleep } from '../lib/cdp.mjs';

const { page, close } = await launch({ width: 1920, height: 1080 });
try {
  await page.goto('http://127.0.0.1:4173/?q=high&hud=0&spot=bridge');
  await page.waitForReady({ timeout: 180000 });
  await sleep(6000);
  const r = await page.evaluate(`(() => {
    const qm = window.__QM__;
    const N = 200;
    for (let i = 0; i < 20; i++) qm.groundAt(1 + (i % 7) * 0.31, 67 + (i % 5) * 0.27);
    const ts = [];
    for (let i = 0; i < N; i++) {
      const x = 0.5 + (i % 37) * 0.9, z = 66 + (i % 23) * 0.8;
      const t0 = performance.now();
      qm.groundAt(x, z);
      ts.push(performance.now() - t0);
    }
    ts.sort((a, b) => a - b);
    const r2 = (v) => Math.round(v * 1000) / 1000;
    return { n: N, p50: r2(ts[Math.floor(N * 0.5)]), p95: r2(ts[Math.floor(N * 0.95)]), max: r2(ts[N - 1]) };
  })()`);
  console.log('groundAt 单次耗时(ms):', JSON.stringify(r));

  const rt = await page.evaluate('window.__QM__.actorsRuntime()');
  console.log('actorsRuntime:', JSON.stringify(rt).slice(0, 800));
} finally {
  await close();
}
