#!/usr/bin/env node
/**
 * 脚底贴地诊断 —— 把"看着像悬空"变成"量出来差几厘米"。
 *
 * 一张近景截图里,一个人**看起来**悬空和**真的**悬空长得一模一样:
 * 透视、坡面、脚下正好有台阶,都能骗过眼睛。而"脚底贴地"是阶段 2d
 * 的出口判据之一,不能靠看。
 *
 * 判据取**蒙皮变形之后**的最低顶点,不是骨骼位置:
 *   · 骨骼的 `foot_L` 原点在脚踝,离鞋底还有几厘米,拿它当"脚底"必然差一截;
 *   · 走路时膝盖弯、脚背抬,单帧的最低点未必是落地那只脚。
 * 所以这里逐顶点跑 `SkinnedMesh.applyBoneTransform`(CPU 端蒙皮),
 * 取**整只网格**的世界坐标最低点,再对**多次采样取最小** ——
 * 一个步态周期里总有一只脚是踩下去的,最小值才代表"这个人最低能到哪"。
 *
 * 地面高度用 `__QM__.groundAt(x, z)`,和人物自己判断站立用的是同一个函数:
 * 同一个函数量出来才有资格叫"对质",换一个公式就是自己跟自己比。
 *
 * 用法:
 *   node tools/perf/once/foot_contact.mjs [URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=high&hud=0';
const SAMPLES = 8;
const GAP_MS = 320;

const { page, close } = await launch({ width: 900, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(3000);

  // 采样循环放在页面里跑完再返回 —— 一次 evaluate 里做 N 次采样,
  // 免得 CDP 往返把采样间隔拉成不确定的量。
  const out = await page.evaluate(`(async () => {
    const qm = window.__QM__;
    const THREE = qm.THREE;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const rigs = [];
    const re = /^actor_\\d+_(walk|carry|hold|lead|punt|push|vendor)$/;
    qm.scene.traverse((o) => { if (re.test(o.name)) rigs.push(o); });

    const rec = new Map();   // id -> 逐次采样的读数
    let verts = 0;

    // ⚠️ gap 必须**在同一次采样里**算出来。
    //    上一版把"8 次采样里最低的那个网格点"和"8 次采样里最高的那个原点"
    //    相减 —— 对拱桥上的人,这是两个不同时刻的位置,相减得到的
    //    既不是那一刻的离地高度、也不是任何真实量。实测同一具 actor_000
    //    在两个脚本里分别是 +0.042 和 −0.183,而它自己一步没变。
    //    所以原点和地面都在**同一个循环里、同一帧**取。
    for (let s = 0; s < ${SAMPLES}; s++) {
      for (const rig of rigs) {
        // 只认身体 char_<pose>;配件 acc_*(扁担/船篙)不算 ——
        // 它本来就悬在半空,拿它量"脚离地多少"量的是那根杆子。
        // 详见 pose_bones.mjs 里同处的注释:这个坑真的踩过一次。
        let mesh = null;
        rig.traverse((o) => { if (!mesh && o.isSkinnedMesh && /^char_/.test(o.name)) mesh = o; });
        if (!mesh) continue;
        const pos = mesh.geometry.attributes.position;
        const v = new THREE.Vector3();
        let minY = Infinity;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i);
          mesh.applyBoneTransform(i, v);      // 输入输出同一向量:塞进局部顶点,吐出蒙皮后的网格局部坐标
          v.applyMatrix4(mesh.matrixWorld);   // 再进世界系
          if (v.y < minY) minY = v.y;
        }
        if (s === 0) verts += pos.count;

        const x = rig.position.x, z = rig.position.z, rigY = rig.position.y;
        const g = qm.groundAt(x, z);   // 同帧取值

        const key = rig.name;
        const cur = rec.get(key) || {
          id: key.split('_').slice(0, 2).join('_'),
          pose: rig.name.replace(/^actor_\\d+_/, ''),
          gaps: [], gapRigs: [], gs: [], minYs: [], rigYs: [],
        };
        cur.minYs.push(+minY.toFixed(3));
        cur.rigYs.push(+rigY.toFixed(3));
        cur.gs.push(g === null ? null : +g.toFixed(3));
        cur.gapRigs.push(+(minY - rigY).toFixed(3));
        if (g !== null) cur.gaps.push(+(minY - g).toFixed(3));
        rec.set(key, cur);
      }
      await sleep(${GAP_MS});
    }

    const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
    const rows = [];
    for (const r of rec.values()) {
      rows.push({
        id: r.id,
        pose: r.pose,
        rigYs: r.rigYs,
        gs: r.gs,
        minYs: r.minYs,
        // 每具实例的读数 = 各次采样的**中位**;离散度单列,不藏进一个数里
        rigY: med(r.rigYs),
        ground: med(r.gs.filter((x) => x !== null)),
        minY: med(r.minYs),
        gap: med(r.gaps),
        gapMin: r.gaps.length ? Math.min(...r.gaps) : null,
        gapMax: r.gaps.length ? Math.max(...r.gaps) : null,
        gapRig: med(r.gapRigs),
        n: r.gaps.length,
      });
    }

    // 材质色 —— 顺带回答"人物是不是全都一个颜色"
    const mats = new Map();
    for (const rig of rigs) {
      rig.traverse((o) => {
        if (o.isSkinnedMesh && o.material) {
          const hex = o.material.color ? o.material.color.getHexString() : '??????';
          mats.set(hex, (mats.get(hex) || 0) + 1);
        }
      });
    }
    return {
      rigs: rigs.length,
      vertsPerSample: verts,
      rows,
      mats: [...mats.entries()].sort((a, b) => b[1] - a[1]),
    };
  })()`);

  const usable = out.rows.filter((r) => r.gap !== null && r.pose !== 'punt');
  usable.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

  console.log(`实例 ${out.rigs} 具;逐顶点蒙皮 ${SAMPLES} 次采样,每次约 ${out.vertsPerSample} 个顶点`);
  console.log(`材质色分布(hex → 具数): ${out.mats.map(([h, n]) => h + '×' + n).join(', ')}`);
  console.log(`\n地面高度查得到 ${usable.length} 具(其余打不到地面,多为船上的 punt):`);
  console.log('  id            姿态     原点y    地面y   最低−地面(中位)  [最小, 最大]   原点y 区间');
  for (const r of usable.slice(0, 14)) {
    console.log(
      `  ${r.id.padEnd(13)} ${r.pose.padEnd(8)} ${String(r.rigY).padStart(6)}  ` +
        `${String(r.ground).padStart(7)}  ${String(r.gap).padStart(11)}  ` +
        `[${r.gapMin}, ${r.gapMax}]`.padEnd(18) +
        `  [${Math.min(...r.rigYs)}, ${Math.max(...r.rigYs)}]`,
    );
  }

  const gaps = usable.map((r) => r.gap).sort((a, b) => a - b);
  const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
  console.log(
    `\n最低−地面 的分位: 最小 ${gaps[0]}m  p10 ${q(0.1)}m  p50 ${q(0.5)}m  p90 ${q(0.9)}m  最大 ${gaps[gaps.length - 1]}m`,
  );

  const rigOffsets = usable.map((r) => r.gapRig).sort((a, b) => a - b);
  console.log(
    `最低−原点 的分位: 最小 ${rigOffsets[0]}m  p50 ${rigOffsets[Math.floor(rigOffsets.length / 2)]}m  最大 ${rigOffsets[rigOffsets.length - 1]}m`,
  );
  // 同一具实例在各次采样之间的摆动:远大于 p50 的那几个才是"看着在飘"的人
  const swings = usable.map((r) => +(r.gapMax - r.gapMin).toFixed(3)).sort((a, b) => b - a);
  console.log(`单具实例自身的离地高度在 ${SAMPLES} 次采样间的摆幅: 最大 ${swings[0]}m  中位 ${swings[Math.floor(swings.length / 2)]}m`);
  console.log('\n判读:中位为负是正常的(脚底略嵌进地面几毫米优于悬空);');
  console.log('      要警惕两件事:① 中位明显为正(整批人在飘);');
  console.log('      ② 单具自身的摆幅远大于中位(同一个人一时贴地一时悬空)。');
} finally {
  await close();
}
