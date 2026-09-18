// 一次性探针:场景里**到底有什么可以被驱动**。
//
// 阶段 4 要把静态场景变成活的(风动布幌/柳枝、船体轻摇、人物走路)。
// 动手之前必须先把导出标签盘一遍 —— Blender 侧写的 `qm_anim` / `qm_flex` /
// `qm_pivot` / `qm_kind` 是网页侧唯一的接口,标签写错了或者没导出成功,
// 再写多少动画代码都是在空气里挥手。
//
// 这也是「先查仪器再查被测物」那条规矩的正面用法:先量清楚接口面。
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/';
const { page, close } = await launch({ width: 1280, height: 720 });

const INVENTORY = `(() => {
  const out = {
    kinds: {}, anims: {}, flex: 0, pivots: 0, hotspots: 0, lod: {}, zones: {},
    skinned: [], skinnedTotal: 0, rigidAnim: [], flexMats: 0, flexGeom: 0,
    reflect: 0, noReflect: 0, boneNames: null, mats: 0, textures: 0,
  };
  const seen = new Set();
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const root = window.__QM__.scene;
  root.traverse((o) => {
    const u = o.userData || {};
    const k = u.qm_kind;
    if (k) bump(out.kinds, k);
    const a = u.qm_anim;
    if (a && a !== 'none') { bump(out.anims, a); out.rigidAnim.push(o.name + ' [' + a + '] pivot=' + (u.qm_pivot || '无')); }
    if (u.qm_flex) out.flex++;
    if (u.qm_pivot) out.pivots++;
    if (u.qm_hotspot) out.hotspots++;
    if (u.qm_lod) bump(out.lod, u.qm_lod);
    if (u.qm_zone) bump(out.zones, u.qm_zone);
    if (u.qm_reflect === 0) out.noReflect++; else if (u.qm_reflect) out.reflect++;

    if (o.isSkinnedMesh) {
      out.skinnedTotal++;
      if (out.skinned.length < 12) {
        const sk = o.skeleton;
        out.skinned.push({
          name: o.name,
          bones: sk ? sk.bones.length : 0,
          headBone: sk && sk.bones[0] ? sk.bones[0].name : null,
          verts: o.geometry.attributes.position ? o.geometry.attributes.position.count : 0,
        });
        if (!out.boneNames && sk) out.boneNames = sk.bones.map((b) => b.name);
      }
    }
    const g = o.geometry;
    if (g && g.attributes && g.attributes.color) out.flexGeom++;
    const m = o.material;
    if (m && !seen.has(m.uuid)) {
      seen.add(m.uuid);
      out.mats++;
      if (m.vertexColors) out.flexMats++;
    }
  });
  out.textures = window.__QM__.renderer.info.memory.textures;
  out.tris = window.__QM__.renderer.info.render.triangles;
  out.calls = window.__QM__.renderer.info.render.calls;
  return out;
})()`;

try {
  await page.send('Page.navigate', { url: URL });
  await page.waitForReady({ timeout: 120000 });
  await sleep(1200);
  const r = await page.evaluate(INVENTORY);

  console.log('=== qm_kind 分布 ===');
  console.log('  ' + JSON.stringify(r.kinds));
  console.log('=== qm_anim 分布(非 none)===');
  console.log('  ' + JSON.stringify(r.anims));
  console.log('=== 可驱动对象 ===');
  console.log(`  qm_flex 标记 ${r.flex} 个 / 带 color 属性的几何 ${r.flexGeom} 个 / vertexColors 材质 ${r.flexMats} 个`);
  console.log(`  qm_pivot ${r.pivots} 个,qm_hotspot ${r.hotspots} 个`);
  console.log(`  qm_reflect:进反射 ${r.reflect} / 不进 ${r.noReflect}`);
  console.log('  qm_lod ' + JSON.stringify(r.lod) + '  qm_zone ' + JSON.stringify(r.zones));
  console.log('=== 刚体转动候选 ===');
  for (const s of r.rigidAnim) console.log('  ' + s);
  console.log(`=== 蒙皮网格 ${r.skinnedTotal} 个 ===`);
  for (const s of r.skinned) console.log(`  ${s.name}  骨 ${s.bones}  根骨 ${s.headBone}  顶点 ${s.verts}`);
  if (r.boneNames) console.log('  骨骼名:' + r.boneNames.join(' '));
  console.log(`=== 渲染 ===`);
  console.log(`  材质 ${r.mats} / 贴图 ${r.textures} / drawcall ${r.calls} / 三角面 ${r.tris}`);
} finally {
  await close();
}
