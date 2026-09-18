#!/usr/bin/env node
/** 炊烟/飞鸟的第一张实拍。看之前先确认它们真的被画出来了。 */
import { launch, sleep } from '../lib/cdp.mjs';
import { mkdirSync } from 'node:fs';

mkdirSync('screenshots/web', { recursive: true });
const q = process.argv[2] || 'high';
const { page, close } = await launch({ width: 1280, height: 800 });
try {
  await page.goto(`http://127.0.0.1:4173/?spot=bridge&q=${q}&hud=0&t=26`);
  await page.waitForReady({ timeout: 120000 });
  await sleep(3500);
  const rt = await page.evaluate(`(() => {
    const qm = window.__QM__;
    return { fx: qm.fxRuntime(), gpu: qm.gpu, q: qm.store.read().quality };
  })()`);
  console.log('gpu :', rt.gpu.renderer);
  console.log('档位:', rt.q);
  console.log('fx  :', JSON.stringify(rt.fx, null, 1));
  await page.screenshot(`screenshots/web/fx_${q}_bridge.png`);
  console.log('→ screenshots/web/fx_' + q + '_bridge.png');
} finally { await close(); }
