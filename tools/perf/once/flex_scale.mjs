#!/usr/bin/env node
/**
 * 风动幅度相对**布面尺寸**是多少。
 *
 * 0.20 米的顶点位移,放在一面 3 米的大旗上是微风,
 * 放在一块 0.5 米的小幌子上就是把布扯成三角形。
 * 只看"位移 0.2 米"是看不出这件事的 —— 必须拿它跟布自己的尺寸比。
 *
 * 判据:位移 / 最短边。经验上布面被扯得能看出"飘"但不"破"，
 * 大致落在 5%~25% 之间;超过 40% 基本就是折叠而不是飘动了。
 */
import { launch, sleep } from '../lib/cdp.mjs';
const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=high&hud=0&spot=market';
const { page, close } = await launch({ width: 900, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(3000);
  const out = await page.evaluate(`(() => {
    const qm = window.__QM__, THREE = qm.THREE;
    const rows = [];
    qm.scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const gu = o.material.userData && o.material.userData.qmFlexUniforms;
      if (!gu) return;
      const g = o.geometry;
      g.computeBoundingBox();
      const b = g.boundingBox;
      const size = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
      const amp = gu.uQmAmp.value, vert = gu.uQmVert.value;
      // 布面的自由长度 = 局部 Y 向尺寸(权重沿 Y 线性,顶端 0、下缘 1)。
      // 幅度按它的比例取,所以必须把这个分母也打出来 ——
      // 否则"幅度 0.13"是一个无法核对来源的数。
      const freeLen = size[1];
      // 权重=1 时位移的**幅值上界**:水平项 |sin| 最大 0.72+0.28=1,竖直项 1
      const maxH = amp, maxV = amp * vert;
      const total = Math.sqrt(maxH * maxH + maxV * maxV);
      // ⚠️ 布是**面**,不是块:它的"厚度"只有几厘米,那是法线方向,
      //    跟风的位移没关系。上一版取全体最小边,于是 8 米长的布帘
      //    被 0.03 米的厚度除了,比值 6.96 —— 一个纯粹由尺子造成的
      //    "布要被扯烂了"。要比的是**面内**的尺寸,所以先滤掉退化边。
      const inPlane = size.filter((s) => s > 0.08);
      const minSide = inPlane.length ? Math.min(...inPlane) : Math.min(...size);
      rows.push({
        name: o.name, anim: o.userData.qm_anim,
        size: size.map((s) => +s.toFixed(3)),
        amp, vert,
        maxDisp: +total.toFixed(3),
        minSide: +minSide.toFixed(3),
        ratio: +(total / minSide).toFixed(3),
        freeLen: +freeLen.toFixed(3),
        ampK: +(amp / freeLen).toFixed(3),
      });
    });
    return rows;
  })()`);
  out.sort((a, b) => b.ratio - a.ratio);
  console.log('  name                   anim   局部尺寸(x×y×z 米)          自由长  幅度  幅度/自由长  最大位移  最短边  位移/最短边');
  for (const r of out) {
    const flag = r.ratio > 0.4 ? '  ← 过 40%,会扯成折叠' : r.ratio < 0.05 ? '  ← 过 5%,几乎看不出' : '';
    console.log(`  ${r.name.padEnd(22)} ${String(r.anim).padEnd(6)} [${r.size.join(' × ').padEnd(24)}] ${String(r.freeLen).padStart(6)} ${String(r.amp).padEnd(5)} ${String(r.ampK).padStart(9)}  ${String(r.maxDisp).padStart(7)}  ${String(r.minSide).padStart(6)}  ${String(r.ratio).padStart(6)}${flag}`);
  }
  const ks = out.map((r) => r.ampK);
  console.log(`\n  幅度/自由长: 最小 ${Math.min(...ks)}  最大 ${Math.max(...ks)}  (按尺寸缩放时这一列应当几乎恒定)`);
  const rs = out.map((r) => r.ratio).sort((a, b) => a - b);
  console.log(`\n  位移/最短边: 最小 ${rs[0]}  中位 ${rs[Math.floor(rs.length / 2)]}  最大 ${rs[rs.length - 1]}`);
} finally { await close(); }
