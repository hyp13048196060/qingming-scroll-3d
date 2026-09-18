#!/usr/bin/env node
/**
 * 逐环节计时 —— 那 20ms 到底落在哪一环。
 *
 * `tools/perf/logic_cost.mjs` 量出每帧逻辑约 20ms,且 low/mid/high 三档
 * 完全一致(与画质无关 ⇒ 与渲染无关)。本脚本把这一帧按环节拆开,
 * 找出主要是谁。
 *
 * ⚠️ 各环是**分开**测的,不是串在一帧里测的。所以这张表回答的是
 *    "这一环自己做一遍要多久",用来定位大头足够;把它加起来当成总帧时
 *    会有偏差,报告里不能那么写。
 *
 * 用法: node tools/perf/stage_cost.mjs [--spot bridge] [--q high] [--n 240]
 */
import { launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const SPOT = arg('--spot', 'bridge');
const Q = arg('--q', 'high');
const N = Number(arg('--n', 240));

const { page, close, browserVersion } = await launch({ width: 1920, height: 1080 });
try {
  console.log(`逐环节计时  q=${Q}  spot=${SPOT}  每环 ${N} 次  浏览器 ${browserVersion}\n`);
  await page.goto(`http://127.0.0.1:4173/?q=${Q}&hud=0&spot=${SPOT}`);
  await page.waitForReady({ timeout: 180000 });
  await sleep(8000);

  // 跑两轮,只看第二轮:第一轮会把 JIT 还没热的那些分支算进去。
  // (measureStages 内部已有 8 次热身,这里再跑一轮是为了跨调用稳定)
  await page.evaluate(`window.__QM__.measureStageCost(${N})`);
  const stages = await page.evaluate(`window.__QM__.measureStageCost(${N})`);

  const total = stages.reduce((a, b) => a + b.ms, 0);
  console.log('环节            p50(ms)   p95(ms)   占比');
  console.log('─'.repeat(48));
  for (const s of stages) {
    const bar = '█'.repeat(Math.max(0, Math.round((s.ms / stages[0].ms) * 28)));
    console.log(`${s.name.padEnd(12)} ${String(s.ms).padStart(8)} ${String(s.p95).padStart(9)}   ${(s.share * 100).toFixed(1).padStart(5)}%  ${bar}`);
  }
  console.log('─'.repeat(48));
  console.log(`${'合计'.padEnd(11)} ${total.toFixed(2).padStart(8)}`);

  const logicOnly = stages.filter((s) => s.name !== '绘制' && s.name !== '界面更新');
  const logicSum = logicOnly.reduce((a, b) => a + b.ms, 0);
  const top = logicOnly[0];
  console.log(`\n其中逻辑部分合计 ${logicSum.toFixed(2)}ms,最大的一环是「${top.name}」${top.ms}ms` +
              `(占逻辑的 ${(top.ms / logicSum * 100).toFixed(1)}%)`);
} finally {
  await close();
}
