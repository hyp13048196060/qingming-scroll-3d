#!/usr/bin/env node
/**
 * 每具人物实例底下**到底挂了几个网格** —— 分辨"网格错了"和"我取错了网格"。
 *
 * 上一步的读数自相矛盾:同一具实例的骨骼位置正常、材质是白的、
 * 几何最低点在 0.679m。而 Blender 自己的 stats.json 写着 `char_carry`
 * 的包围盒 z 从 0 到 1.705、168 个顶点。两边对不上,有两种可能:
 *   (a) 导出/加载过程中网格变了;
 *   (b) **我读的不是那具身体的网格** —— `traverse` 取的是"第一个 SkinnedMesh",
 *       一具实例底下若有多个(身体 + 扁担 + 道具),先撞上谁全看遍历顺序。
 * 这两种的修法完全不同,而 `traverse` 取第一个的写法**不区分**它们。
 *
 * 所以这里把每一具实例底下的**全部** SkinnedMesh 逐个印出来。
 *
 * 用法: node tools/perf/once/rig_meshes.mjs [URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=high&hud=0';

const { page, close } = await launch({ width: 900, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(3000);

  const out = await page.evaluate(`(() => {
    const qm = window.__QM__;
    const THREE = qm.THREE;
    // 看**模板**(直接用加载进来的 scene，不经过 clone 的实例)——
    // 阶段 2d 的产物是模板,实例只是克隆,查模板能少受克隆逻辑干扰。
    const res = { templates: [], instances: [] };
    const re = /^actor_\\d+_(walk|carry|hold|lead|punt|push|vendor)$/;
    const seen = new Set();
    qm.scene.traverse((o) => {
      const m = /^(char_(?:walk|carry|hold|lead|punt|push|vendor))$/.exec(o.name);
      if (m && !seen.has(m[1])) { seen.add(m[1]); res.templates.push(o.name); }
    });

    // 一具实例底下的所有网格
    let rig = null;
    qm.scene.traverse((o) => { if (!rig && /^actor_\\d+_carry$/.test(o.name)) rig = o; });
    let rigPunt = null;
    qm.scene.traverse((o) => { if (!rigPunt && /^actor_\\d+_punt$/.test(o.name)) rigPunt = o; });

    const dump = (r) => {
      if (!r) return null;
      const list = [];
      r.traverse((o) => {
        if (!o.isMesh) return;
        const pos = o.geometry.attributes.position;
        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < pos.count; i++) {
          const y = pos.getY(i);
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        list.push({
          name: o.name,
          type: o.type,
          skinned: !!o.isSkinnedMesh,
          verts: pos.count,
          tris: (o.geometry.index ? o.geometry.index.count : pos.count) / 3,
          zRange: [+minY.toFixed(3), +maxY.toFixed(3)],
          mat: o.material && o.material.color ? o.material.color.getHexString() : '??????',
          groups: o.geometry.groups ? o.geometry.groups.length : 0,
          multiMat: Array.isArray(o.material),
        });
      });
      return { rig: r.name, meshes: list };
    };
    res.instances.push(dump(rig), dump(rigPunt));
    return res;
  })()`);

  console.log('加载进来的模板根名:', out.templates.join(', ') || '(没有以 char_* 命名的对象)');
  for (const d of out.instances) {
    if (!d) continue;
    console.log(`\n实例 ${d.rig} 底下的网格 (${d.meshes.length} 个):`);
    if (!d.meshes.length) console.log('  ⚠️ 一个 Mesh 都没有 —— 那么"最低点 0.679"根本不是从身体量出来的');
    for (const m of d.meshes) {
      console.log(
        `  ${m.name.padEnd(28)} ${m.type.padEnd(14)} skinned=${m.skinned ? 'Y' : 'n'} ` +
          `verts=${String(m.verts).padStart(4)} tris=${String(m.tris).padStart(4)} ` +
          `局部y∈[${m.zRange[0]}, ${m.zRange[1]}] mat=#${m.mat} groups=${m.groups} multiMat=${m.multiMat}`,
      );
    }
  }
} finally {
  await close();
}
