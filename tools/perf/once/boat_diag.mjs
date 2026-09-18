#!/usr/bin/env node
/**
 * 一次性诊断:船壳真的在转**它自己**吗?船上的静态件跟着走了吗?
 *
 * 起因:probe_ui 的「船壳摇动会带动船上的静态部件」实测位移**恰好为 0**,
 * 而同一批样本里 `lastAngle` 的极差有 1.1~1.8°。两者不可能同时为真 ——
 * 要么角没被用上,要么被转的不是那件东西。
 *
 * 这个脚本把链条上每一环都打出来,不做判断:
 *   1. 船壳自己的世界位置/四元数(它在动吗)
 *   2. 船壳的父级是谁(parent 空间换算对不对的前提)
 *   3. 船壳身上 qm_pivot / qm_axis 的原始标签 + 换算到 three 空间后的值
 *   4. 船壳的每个子节点的世界位置(谁跟着动了、谁没动)
 *
 * 只读,不改场景。用法:
 *   node tools/perf/once/boat_diag.mjs --url http://127.0.0.1:4173/
 */
import { launch, sleep } from '../lib/cdp.mjs';

const url = (() => {
  const i = process.argv.indexOf('--url');
  return i >= 0 ? process.argv[i + 1] : 'http://127.0.0.1:4173/';
})();

/**
 * ⚠️ 上一版这个探针量的是 `getWorldPosition()`,即对象的**原点**。
 * 船上的舱篷/肋骨/舾装件原点就落在船壳的锚点上 —— 而锚点正是横摇的
 * 轴心,是旋转的**不动点**。于是量出来恒等于 0,而船其实摇得好好的。
 * 那是取景框的错,不是船的错(见 instrument-error-pattern 第 39 条:
 * "点在框里"不等于"看得见")。
 *
 * 改成量**材质点**:几何体包围盒中心在物体局部空间里的位置,再经
 * matrixWorld 送到世界空间。包围盒中心离轴心有一个力臂,横摇时它真的走。
 */
const SAMPLE = `
(() => {
  const q = window.__QM__;
  const V3 = q.scene.position.constructor;
  const out = [];

  // 一个物体的"材质点":几何包围盒中心(local)→ 世界
  const matPoint = (o) => {
    const g = o.geometry;
    if (!g) return null;
    if (!g.boundingBox) g.computeBoundingBox();
    o.updateWorldMatrix(true, false);
    return g.boundingBox.getCenter(new V3()).applyMatrix4(o.matrixWorld);
  };

  // Blender Z-up → three Y-up: toYUp(x,y,z) = (x, z, -y)
  const vec = (tag) => {
    const raw = String(tag || '').split(',').map(Number);
    if (raw.length !== 3 || raw.some((v) => !Number.isFinite(v))) return null;
    return new V3(raw[0], raw[2], -raw[1]);
  };

  // 点到**轴线**的垂直距离。这才是绕轴转动的真正力臂 ——
  // 到轴心**点**的距离不是:沿轴方向的分量再大也不产生位移。
  const perpToAxis = (p, pivot, axis) => {
    const w = p.clone().sub(pivot);
    return w.sub(axis.clone().multiplyScalar(w.dot(axis))).length();
  };

  const angles = {};
  for (const b of q.boatSnapshot()) angles[b.id] = b.rockDeg;

  q.scene.traverse((o) => {
    if (o.userData.qm_anim !== 'hull_rock') return;
    o.updateWorldMatrix(true, false);
    const pivot = vec(o.userData.qm_pivot);
    const axis = vec(o.userData.qm_axis);
    const ax = axis && axis.lengthSq() > 1e-12 ? axis.normalize() : null;
    const hullPt = matPoint(o);

    const kids = o.children.map((c) => {
      c.updateWorldMatrix(true, false);
      const origin = c.getWorldPosition(new V3());
      const pt = matPoint(c);
      return {
        name: c.name,
        anim: c.userData.qm_anim === undefined ? '(无)' : c.userData.qm_anim,
        org: [origin.x, origin.y, origin.z].map((v) => +v.toFixed(5)),
        pt: pt ? [pt.x, pt.y, pt.z].map((v) => +v.toFixed(5)) : null,
        // 到轴**心**的距离(上一版用的错力臂,留着对照)
        arm: pt && pivot ? +pt.distanceTo(pivot).toFixed(4) : null,
        // 到轴**线**的距离(真力臂)
        rPerp: pt && pivot && ax ? +perpToAxis(pt, pivot, ax).toFixed(4) : null,
      };
    });

    out.push({
      name: o.name,
      parent: o.parent ? o.parent.name : '(无父级)',
      parentQuat: o.parent
        ? [o.parent.quaternion.x, o.parent.quaternion.y, o.parent.quaternion.z,
           o.parent.quaternion.w].map((v) => +v.toFixed(6))
        : null,
      pivotTag: o.userData.qm_pivot,
      axisTag: o.userData.qm_axis,
      // 标签换算出来的世界轴心/轴向(不经父级矩阵)
      pivotWorld: pivot ? [pivot.x, pivot.y, pivot.z].map((v) => +v.toFixed(4)) : null,
      axisWorld: ax ? [ax.x, ax.y, ax.z].map((v) => +v.toFixed(4)) : null,
      pos: [o.position.x, o.position.y, o.position.z].map((v) => +v.toFixed(5)),
      quat: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]
        .map((v) => +v.toFixed(6)),
      hullPt: hullPt ? [hullPt.x, hullPt.y, hullPt.z].map((v) => +v.toFixed(5)) : null,
      hullRPerp: hullPt && pivot && ax ? +perpToAxis(hullPt, pivot, ax).toFixed(4) : null,
      rockDeg: angles[o.name] === undefined ? null : angles[o.name],
      kids,
    });
  });
  return out;
})()
`;

// launch() 返回的是 { page, close, port, browserVersion, stderr } ——
// 不是 Page 本身。写成 `const page = await launch(...)` 会在
// page.goto 那一行炸,而报错说的是"goto 不是函数"、
// 听上去像方法名写错了,其实是没有解构。
const { page, close } = await launch({ width: 1600, height: 900 });
try {
  await page.goto(url);
  await page.waitForReady();
  await sleep(1500);

  const shots = [];
  for (let i = 0; i < 4; i++) {
    shots.push(await page.evaluate(SAMPLE));
    await sleep(600);
  }

  const first = shots[0];
  console.log(`\n抓到 ${first.length} 条 hull_rock\n`);
  console.log('船名 / 父级 / pivot 标签 / axis 标签 / 子节点数');
  for (const b of first) {
    console.log(
      `  ${b.name}\n` +
        `    父级 ${b.parent}  子节点 ${b.kids.length}\n` +
        `    pivot=${JSON.stringify(b.pivotTag)}  axis=${JSON.stringify(b.axisTag)}`,
    );
  }

  for (let bi = 0; bi < first.length; bi++) {
    const name = first[bi].name;
    console.log(`\n${'='.repeat(70)}\n${name}`);
    const spread = (xs) => {
      let m = 0;
      for (let i = 0; i < xs.length; i++) {
        for (let j = i + 1; j < xs.length; j++) {
          m = Math.max(
            m,
            Math.hypot(xs[i][0] - xs[j][0], xs[i][1] - xs[j][1], xs[i][2] - xs[j][2]),
          );
        }
      }
      return m;
    };

    console.log('  船壳自身:');
    for (let s = 0; s < shots.length; s++) {
      const b = shots[s][bi];
      console.log(`    [${s}] quat=${JSON.stringify(b.quat)}`);
    }
    console.log(
      `    船壳材质点真力臂 ${first[bi].hullRPerp} m,` +
        ` 位移 ${spread(shots.filter((sh) => sh[bi].hullPt).map((sh) => sh[bi].hullPt)).toFixed(5)} m` +
        `  (船壳自身力臂就小 —— 它不是好见证)`,
    );

    // 取角度最小/最大那两个样本 —— 同一次 boatSnapshot 里的角度与材质点,
    // 不存在跨调用对时的问题。
    const angs = shots.map((sh) => sh[bi].rockDeg);
    if (angs.some((v) => v === null)) {
      console.log('  (被 qm_beached 挡下,不参与转动核对)\n');
      continue;
    }
    let lo = 0;
    let hi = 0;
    for (let i = 1; i < angs.length; i++) {
      if (angs[i] < angs[lo]) lo = i;
      if (angs[i] > angs[hi]) hi = i;
    }
    const dTheta = ((angs[hi] - angs[lo]) * Math.PI) / 180;
    console.log(
      `  采样角度 ${JSON.stringify(angs)}° → Δθ=${((dTheta * 180) / Math.PI).toFixed(3)}°` +
        `(样本 ${lo}↔${hi})`,
    );

    console.log('  子节点(真力臂 = 材质点到横摇**轴线**的垂直距离):');
    console.log('    ⚠️ 上一版用的是到轴**心点**的距离,那是错的:沿轴向的分量再大也不产生位移。');
    console.log('    ⚠️ 刚体判据:真力臂理应**恒定**,且位移应等于 2·力臂·sin(Δθ/2)。');
    // 按**名字**取子节点,不按下标 —— 下标顺序没有谁保证过
    // (这个坑在本文件里已经踩过一次,上一次的表现是"静默取到另一个对象")。
    const kidOf = shots.map((sh) => {
      const m = {};
      for (const c of sh[bi].kids) m[c.name] = c;
      return m;
    });
    const counts = shots.map((sh) => sh[bi].kids.length);
    if (new Set(counts).size !== 1) {
      console.log(`    ⚠️ 子节点数在各次采样间不一致:${JSON.stringify(counts)} —— 场景在自己加/删对象`);
    }

    const kids = first[bi].kids;
    for (const k of kids) {
      const seq = kidOf.map((m) => m[k.name]);
      if (seq.some((c) => !c)) {
        console.log(`    ?? ${k.name} 有一半采样里取不到 —— 跳过`);
        continue;
      }
      const orgMove = spread(seq.map((c) => c.org));
      const ptMove = spread(seq.map((c) => c.pt));
      const rpSpread = spread(seq.map((c) => [c.rPerp, 0, 0]));
      const a = seq[lo].pt;
      const b = seq[hi].pt;
      const chord = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0;
      const pred = 2 * k.rPerp * Math.sin(Math.abs(dTheta) / 2);
      const err = pred > 1e-6 ? chord - pred : chord;
      console.log(
        `    ${ptMove > 0.0005 ? '动了' : '没动'} 真力臂 ${String(k.rPerp).padStart(6)}` +
          `±${(rpSpread * 1000).toFixed(2)}mm  原点位移 ${orgMove.toFixed(6)}` +
          `  实位移 ${chord.toFixed(6)} / 预测 ${pred.toFixed(6)}` +
          ` (差 ${(err * 1000).toFixed(2)}mm)  ${k.name}  anim=${k.anim}`,
      );
    }
    console.log('');
  }
} finally {
  await close();
}
