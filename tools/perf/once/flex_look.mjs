#!/usr/bin/env node
/**
 * 风动件"看起来是什么样"的可核对版本:材质 + 屏幕方框。
 *
 * 市集机位那张图里,幌子是一片**纯白矩形**。这有两种可能,而且长得一样:
 *   ① 布本来就是白的(素材缺失);
 *   ② 布有贴图,只是贴图本身接近白(正常)。
 * 区分办法只有一条:**看 material.map 在不在**。
 * 白色基色 + 有 albedo 贴图 = 正常(本项目已验证过一次的颜色假警报);
 * 白色基色 + **没有** map = 真的没贴图。
 *
 * 顺带把每个风动件投到屏幕上 —— 不然"图里哪块是幌子"全靠猜。
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=high&hud=0&spot=market';
const W = 1600, H = 900;

const { page, close } = await launch({ width: W, height: H });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(4000);
  const out = await page.evaluate(`(() => {
    const qm = window.__QM__, THREE = qm.THREE;
    const rows = [];
    qm.scene.traverse((o) => {
      const u = o.userData || {};
      if (!o.isMesh || !o.material) return;
      const gu = o.material.userData && o.material.userData.qmFlexUniforms;
      if (!gu) return;
      const m = o.material;
      o.updateWorldMatrix(true, false);
      const b = new THREE.Box3().setFromObject(o);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
      for (let i = 0; i < 8; i++) {
        const v = new THREE.Vector3(
          i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z
        ).project(qm.camera);
        if (v.z > 1) continue;
        any = true;
        const sx = (v.x * 0.5 + 0.5) * ${W}, sy = (-v.y * 0.5 + 0.5) * ${H};
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
        y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
      rows.push({
        name: o.name, anim: u.qm_anim,
        mat: m.name, matType: m.type,
        color: m.color ? m.color.getHexString() : null,
        map: !!m.map, mapName: m.map ? (m.map.name || '(无名)') : null,
        vertexColors: !!m.vertexColors,
        transparent: !!m.transparent, opacity: m.opacity,
        side: m.side,
        verts: o.geometry.attributes.position.count,
        rect: any ? [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)] : null,
      });
    });
    // 材质去重:多少件共用一份材质
    const byMat = {};
    for (const r of rows) byMat[r.mat + '|' + r.matType] = (byMat[r.mat + '|' + r.matType] || 0) + 1;
    return { rows, byMat };
  })()`);

  console.log(`===== 风动件的材质与屏幕位置(共 ${out.rows.length} 个)=====`);
  console.log('  name                   anim   材质                 基色     贴图  顶点   屏幕框');
  for (const r of out.rows) {
    console.log(
      `  ${r.name.padEnd(22)} ${String(r.anim).padEnd(6)} ${String(r.mat).padEnd(20)} #${String(r.color).padEnd(7)} ` +
      `${r.map ? '有' : '**无**'}  ${String(r.verts).padStart(5)}  ${r.rect ? 'x ' + r.rect[0] + '–' + r.rect[2] + ' y ' + r.rect[1] + '–' + r.rect[3] : '画面外'}`,
    );
  }

  const noMap = out.rows.filter((r) => !r.map);
  console.log(`\n没有贴图的风动件: ${noMap.length} 个${noMap.length ? ' —— ' + noMap.map((r) => r.name).join(', ') : ''}`);
  const white = out.rows.filter((r) => r.color === 'ffffff');
  console.log(`基色是纯白的: ${white.length} 个;其中**既纯白又无贴图**的 ${white.filter((r) => !r.map).length} 个`);
  const vc = out.rows.filter((r) => r.vertexColors);
  console.log(`开了 vertexColors 的: ${vc.length} 个${vc.length ? '(权重会被乘进基色,幌子会变黑)' : ' ✅'}`);
  console.log(`\n材质复用情况(材质 → 件数):`);
  for (const [k, n] of Object.entries(out.byMat).sort((a, b) => b[1] - a[1])) console.log(`  ${k} → ${n} 件`);
} finally {
  await close();
}
