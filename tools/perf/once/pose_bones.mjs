#!/usr/bin/env node
/**
 * 按姿态拆开的骨骼/贴地读数 —— 定位"是整批姿态错了,还是个别实例错了"。
 *
 * 上一版只印了全体分位(p50 −0.008m 看着很好),把两个尾巴盖住了:
 * carry 姿态整齐地 +0.679m、actor_020 单独 −2.007m。
 * 分位是**为了掩盖离散**而生的统计量,这里恰恰要看离散,所以必须按姿态拆。
 *
 * 三个读数分开印,因为它们指向完全不同的病因:
 *   · 蒙皮后最低点 − 原点   → 动画把整个人抬起来了
 *   · 绑定姿势最低点 − 原点 → **几何本身就是这么摆的**(Blender 侧的问题)
 *   · 脚踝骨骼 − 原点       → 驱动写进去的旋转对不对
 *
 * `bindMatrix` 那一步是这里的关键:顶点在绑定空间,乘 `bindMatrix` 回到
 * 蒙皮前的世界位置。它不受任何骨骼旋转影响 —— 所以它能分开
 * "模型做出来就浮着"和"被动画抬起来了",而这两件事的修法完全不同。
 *
 * 用法: node tools/perf/once/pose_bones.mjs [URL]
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
    const base = (n) => n.replace(/_\\d+$/, '');
    const re = /^actor_\\d+_(walk|carry|hold|lead|punt|push|vendor)$/;
    const rigs = [];
    qm.scene.traverse((o) => { if (re.test(o.name)) rigs.push(o); });

    const rows = [];
    for (const rig of rigs) {
      // ⚠️ 取**身体**网格,不是"第一个 SkinnedMesh"。
      //    一具实例底下挂着两个:身体 char_<pose> 与配件 acc_<pose>_*
      //    (扁担 / 船篙)。traverse 撞上谁全看遍历顺序,而**配件先被撞上**
      //    —— 于是"几何最低点 0.679m"量的是那根扁担,不是人。
      //    读数看着照样合理(扁担本来就扛在半空),所以错得毫无征兆:
      //    结论一度是"carry 姿态的腿没做出来",而 Blender 的 stats.json
      //    里 char_carry 的包围盒明明是 z∈[0, 1.705]。
      //    名字是唯一能分辨两者的东西 —— 按名字取,不按顺序取。
      let mesh = null;
      const bones = {};
      rig.traverse((o) => {
        if (!mesh && o.isSkinnedMesh && /^char_/.test(o.name)) mesh = o;
        if (o.isBone) bones[base(o.name)] = o;
      });
      if (!mesh) continue;
      const pos = mesh.geometry.attributes.position;
      const v = new THREE.Vector3();

      let minSkinned = Infinity, minBind = Infinity, minRaw = Infinity, maxRaw = -Infinity;
      // 分段直方图:能分开"整个模型被抬高"和"底部一节根本没做"
      //   · 整体抬高  → 每一个 bin 都有顶点,只是最矮的那些也不低于 0.679
      //   · 底部缺失  → 0~0.6m 之间**一个顶点都没有**
      const bin = [0, 0, 0, 0, 0, 0]; // 每 0.3m 一格
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        // ① 绑定姿势:顶点位置直接进世界(不含任何骨骼旋转)
        const b = v.clone().applyMatrix4(mesh.bindMatrix).applyMatrix4(mesh.matrixWorld);
        if (b.y < minBind) minBind = b.y;
        // ② 蒙皮后
        v.fromBufferAttribute(pos, i);
        mesh.applyBoneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        if (v.y < minSkinned) minSkinned = v.y;
        // ③ 什么矩阵都不乘,纯几何原始 Y —— 用来判断顶点是不是本来就带偏移
        const raw = pos.getY(i);
        if (raw < minRaw) minRaw = raw;
        if (raw > maxRaw) maxRaw = raw;
        const k = Math.floor(raw / 0.3);
        if (k >= 0 && k < 6) bin[k]++;
      }
      const mat = mesh.material && mesh.material.color ? mesh.material.color.getHexString() : '??????';

      const wy = (name) => {
        const bn = bones[name];
        if (!bn) return null;
        const p = new THREE.Vector3();
        bn.getWorldPosition(p);
        return +(p.y - rig.position.y).toFixed(3);
      };
      let driven = 0;
      rig.traverse((o) => { if (o.isBone && o.userData.qmDriven) driven++; });

      rows.push({
        id: rig.name.split('_').slice(0, 2).join('_'),
        pose: rig.name.replace(/^actor_\\d+_/, ''),
        rigY: +rig.position.y.toFixed(3),
        bones: Object.keys(bones).length,
        skinned: +(minSkinned - rig.position.y).toFixed(3),
        bind: +(minBind - rig.position.y).toFixed(3),
        raw: +minRaw.toFixed(3),
        rawMax: +maxRaw.toFixed(3),
        bin,
        verts: pos.count,
        mat,
        footL: wy('foot_L'), footR: wy('foot_R'),
        shinL: wy('shin_L'), pelvis: wy('pelvis'), head: wy('head'),
      });
    }
    return rows;
  })()`);

  const poses = [...new Set(out.map((r) => r.pose))];
  console.log('id            姿态    原y     骨骼  蒙皮−原  绑定−原  原始y  shin_L pelvis  head');
  for (const p of poses) {
    const g = out.filter((r) => r.pose === p);
    console.log(`—— ${p} (${g.length} 具) ——`);
    for (const r of g.slice(0, 4)) {
      console.log(
        `  ${r.id.padEnd(12)} ${String(r.rigY).padStart(6)}  ${String(r.bones).padStart(3)}  ` +
          `${String(r.skinned).padStart(7)}  ${String(r.bind).padStart(7)}  ` +
          `${String(r.raw).padStart(6)}  ${String(r.shinL).padStart(6)} ${String(r.pelvis).padStart(6)} ${String(r.head).padStart(6)}`,
      );
    }
    const sk = g.map((r) => r.skinned).sort((a, b) => a - b);
    const bd = g.map((r) => r.bind).sort((a, b) => a - b);
    const p50 = (a) => a[Math.floor(a.length / 2)];
    console.log(
      `  蒙皮−原: p50 ${p50(sk)}  [${sk[0]}, ${sk[sk.length - 1]}]   ` +
        `绑定−原: p50 ${p50(bd)}  [${bd[0]}, ${bd[bd.length - 1]}]   骨骼数 ${[...new Set(g.map((r) => r.bones))].join('/')}`,
    );
    const r0 = g[0];
    console.log(
      `  几何原始 Y: 最低 ${r0.raw}  最高 ${r0.rawMax}  顶点 ${r0.verts}  材质 #${r0.mat}  ` +
        `分段(每0.3m) [${r0.bin.join(', ')}]`,
    );
  }
} finally {
  await close();
}
