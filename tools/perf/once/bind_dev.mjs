#!/usr/bin/env node
/**
 * 哪些骨**偏离了绑定姿势** —— 而且是加载进来就偏的,不是动画写的。
 *
 * vendor 的读数自相矛盾:driven=0、1.2 秒内一动不动,可蒙皮最低点比
 * 绑定姿势高 0.3057m。骨骼不动却偏离绑定,只有一种可能:
 * **GLB 里节点的 TRS 与 inverseBindMatrices 不是同一套**。
 * 这既不是网页的错也不是动画的错,是导出侧的。
 *
 * 判据:每根骨的 `matrixWorld × boneInverse` 相对单位阵的偏差。
 * 绑定姿势下这个乘积**恒等于单位阵** —— 所以它是个能归零的量,
 * 不依赖任何本项目的公式。
 */
import { launch, sleep } from '../lib/cdp.mjs';
const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=high&hud=0';
const { page, close } = await launch({ width: 900, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(3000);
  const out = await page.evaluate(`(() => {
    const qm = window.__QM__, THREE = qm.THREE;
    const rigs = {};
    const re = /^actor_[0-9]+_(walk|carry|hold|lead|punt|push|vendor)$/;
    qm.scene.traverse((o) => {
      const m = re.exec(o.name);
      if (m && !rigs[m[1]]) rigs[m[1]] = o;
    });
    const res = [];
    for (const [pose, rig] of Object.entries(rigs)) {
      let mesh = null;
      rig.traverse((o) => { if (!mesh && o.isSkinnedMesh && /^char_/.test(o.name)) mesh = o; });
      const sk = mesh.skeleton;
      const I = new THREE.Matrix4();
      const M = new THREE.Matrix4();
      const rows = [];
      for (let i = 0; i < sk.bones.length; i++) {
        // 绑定姿势下 matrixWorld * boneInverse == I
        M.multiplyMatrices(sk.bones[i].matrixWorld, sk.boneInverses[i]);
        let dev = 0;
        const e = M.elements, ie = I.elements;
        for (let k = 0; k < 16; k++) dev = Math.max(dev, Math.abs(e[k] - ie[k]));
        // 平移量:绑定姿势下应为 0
        const t = new THREE.Vector3().setFromMatrixPosition(M);
        rows.push({ bone: sk.bones[i].name, dev: +dev.toFixed(4), tY: +t.y.toFixed(4),
                    worldY: +new THREE.Vector3().setFromMatrixPosition(sk.bones[i].matrixWorld).y.toFixed(3) });
      }
      rows.sort((a, b) => b.dev - a.dev);
      res.push({ pose, worst: rows.slice(0, 3), deviants: rows.filter((r) => r.dev > 1e-3).length, total: rows.length });
    }
    return res;
  })()`);
  for (const r of out) {
    console.log(`${r.pose.padEnd(8)} 偏离绑定的骨 ${String(r.deviants).padStart(2)}/${r.total}  最大偏差 ${r.worst[0].dev} (${r.worst[0].bone})`);
    for (const w of r.worst.slice(0, 2)) {
      console.log(`         ${w.bone.padEnd(16)} dev=${String(w.dev).padStart(7)}  平移y=${String(w.tY).padStart(8)}  骨世界y=${w.worldY}`);
    }
  }
} finally { await close(); }
