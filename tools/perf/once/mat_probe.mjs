#!/usr/bin/env node
/** 白色基色到底是"没上色"还是"颜色来自贴图" —— 两者在 color 上长得一样。 */
import { launch, sleep } from '../lib/cdp.mjs';
const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=high&hud=0';
const { page, close } = await launch({ width: 900, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(2500);
  const out = await page.evaluate(`(() => {
    const qm = window.__QM__;
    const seen = new Map();
    qm.scene.traverse((o) => {
      if (!o.isMesh) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) {
        if (!m || seen.has(m.uuid)) continue;
        seen.set(m.uuid, {
          mat: m.name,
          on: o.name,
          color: m.color ? m.color.getHexString() : null,
          map: !!m.map,
          normalMap: !!m.normalMap,
          roughnessMap: !!m.roughnessMap,
          rough: m.roughness,
          metal: m.metalness,
          side: m.side,
          transparent: m.transparent,
        });
      }
    });
    return [...seen.values()];
  })()`);
  const white = out.filter((m) => m.color === 'ffffff');
  console.log(`材质总数 ${out.length},其中基色为纯白的 ${white.length} 个:`);
  for (const m of white.slice(0, 20)) {
    console.log(`  ${String(m.mat).padEnd(28)} on ${String(m.on).padEnd(22)} map=${m.map ? 'Y' : 'n'} ` +
      `rough=${m.rough} metal=${m.metal} nMap=${m.normalMap ? 'Y' : 'n'} rMap=${m.roughnessMap ? 'Y' : 'n'}`);
  }
  const nonWhite = out.filter((m) => m.color !== 'ffffff' && m.mat && /char_|acc_/.test(m.mat));
  console.log(`\n人物相关材质:`);
  for (const m of nonWhite.slice(0, 14)) console.log(`  ${String(m.mat).padEnd(28)} #${m.color} on ${m.on}`);
} finally { await close(); }
