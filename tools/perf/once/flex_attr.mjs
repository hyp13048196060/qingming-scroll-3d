#!/usr/bin/env node
/**
 * 风动权重到底有没有导出来 —— 以及它叫什么名字。
 *
 * 计划书写的是:Blender 写一个名为 `flex` 的颜色属性 → `export_attributes=True`
 * → `COLOR_0` → 网页里 `geometry.attributes.color`,且 `material.vertexColors`
 * 保持 false(只当普通浮点属性读)。
 *
 * 这中间有**三道**转换,每一道都可能把属性丢掉,而丢掉的后果不是报错,
 * 是"幌子一动不动" —— 在一张静帧里和"今天没风"完全一样。
 * 所以先量再写。
 *
 * 同时量:`wind` 与 `sway` 两类的权重分布是否真的不同(顶端 1、根部 0),
 * 否则两个名字只是同一件事的两种叫法。
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=low&hud=0';

const { page, close } = await launch({ width: 900, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(2500);
  const out = await page.evaluate(`(() => {
    const qm = window.__QM__;
    const rows = [];
    const want = { banner_000: 1, willow_000_leaf: 1, cel_e00_cloth: 1, boat_cao_a_mooring: 1 };
    qm.scene.traverse((o) => {
      if (!o.isMesh || !want[o.name]) return;
      const g = o.geometry;
      const attrs = Object.keys(g.attributes);
      const u = o.userData || {};
      const r = { name: o.name, anim: u.qm_anim, flex: u.qm_flex, attrs, verts: g.attributes.position.count,
                  vertexColors: !!(o.material && o.material.vertexColors) };
      for (const key of attrs) {
        if (key === 'position' || key === 'normal' || key === 'uv') continue;
        const a = g.attributes[key];
        const vals = [];
        for (let i = 0; i < Math.min(a.count, 2000); i++) vals.push(a.getX(i));
        vals.sort((x, y) => x - y);
        r[key] = {
          itemSize: a.itemSize,
          normalized: !!a.normalized,
          min: +vals[0].toFixed(3),
          max: +vals[vals.length - 1].toFixed(3),
          // 有多少个点权重 >0.5 —— 全是 0 或全是 1 都说明权重没写进去
          over: vals.filter((v) => v > 0.5).length,
          n: vals.length,
        };
      }
      rows.push(r);
    });
    return rows;
  })()`);

  for (const r of out) {
    console.log(`\n${r.name}  qm_anim=${r.anim} qm_flex=${r.flex} verts=${r.verts} vertexColors=${r.vertexColors}`);
    console.log(`  属性: ${r.attrs.join(', ')}`);
    for (const [k, v] of Object.entries(r)) {
      if (typeof v !== 'object' || !v || v.itemSize === undefined) continue;
      console.log(`  ${k.padEnd(12)} itemSize=${v.itemSize} normalized=${v.normalized} 取值[${v.min}, ${v.max}]   >0.5 的点 ${v.over}/${v.n}`);
    }
  }
} finally {
  await close();
}
