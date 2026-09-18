#!/usr/bin/env node
/**
 * 一次性诊断:朝向自检为什么没有样本。
 *
 * 判据依赖两个字段同时非 null:`bodyFwd`/`armFwd` 与两次快照的位移。
 *   前者来自 `i.speed > 0` + rig 四元数;
 *   后者来自髋/肩连线。
 * 只印"没有样本"是没法定位的 —— 得知道**是哪一个**为 null,以及有几具。
 *
 * 用法: node tools/perf/once/snap.mjs [URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=low&hud=0';

const { page, close } = await launch({ width: 800, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(1500);

  const out = await page.evaluate(`(() => {
    const snap = window.__QM__.actorsSnapshot();
    let mdYes = 0, shYes = 0, both = 0;
    const byPose = {};
    for (const s of snap) {
      const m = !!s.bodyFwd, sh = !!s.armFwd;
      if (m) mdYes++;
      if (sh) shYes++;
      if (m && sh) both++;
      const k = s.pose;
      byPose[k] = byPose[k] || { n: 0, m: 0, sh: 0 };
      byPose[k].n++; if (m) byPose[k].m++; if (sh) byPose[k].sh++;
    }
    // 取一个"在走"的样本来细看
    const sample = snap.find((s) => s.pose === 'walk') || snap[0];
    return { total: snap.length, mdYes, shYes, both, byPose, sample };
  })()`);

  console.log(`总数 ${out.total}  bodyFwd 非空 ${out.mdYes}  armFwd 非空 ${out.shYes}  两者都有 ${out.both}`);
  console.log('按姿态:');
  for (const [k, v] of Object.entries(out.byPose)) {
    console.log(`  ${k.padEnd(8)} n=${String(v.n).padStart(2)}  bodyFwd ${v.m}  armFwd ${v.sh}`);
  }
  console.log('\n样本:');
  console.log(JSON.stringify(out.sample, null, 2));

  // —— 把 measureFacingFrom 的算法在页面里**原样重放**一遍 ——
  // 目的是分清两种死法:
  //   (a) 查不到骨头            → 名字/层级问题
  //   (b) 查到了,但左右两点重合 → 读数问题(_left ≈ 0)
  // `null` 本身不区分这两者,而修法完全不同。
  const replay = await page.evaluate(`(() => {
    const s = window.__QM__.scene;
    let rig = null;
    s.traverse((o) => { if (!rig && /^actor_\\d+_walk$/.test(o.name)) rig = o; });
    if (!rig) return { err: '没找到 walk 实例' };
    const base = (n) => n.replace(/_\\d+$/, '');
    const rows = [];
    for (const pair of [['thigh_L','thigh_R'], ['shoulder_L','shoulder_R'],
                        ['upperarm_L','upperarm_R'], ['forearm_L','forearm_R'],
                        ['hand_L','hand_R']]) {
      let oa = null, ob = null;
      rig.traverse((o) => {
        const n = base(o.name);
        if (n === pair[0]) oa = o;
        if (n === pair[1]) ob = o;
      });
      if (!oa || !ob) { rows.push({ pair: pair.join('/'), found: false, a: oa && oa.name, b: ob && ob.name }); continue; }
      const A = new oa.position.constructor(); const B = new oa.position.constructor();
      oa.getWorldPosition(A); ob.getWorldPosition(B);
      const d = { x: A.x - B.x, y: A.y - B.y, z: A.z - B.z };
      const lenXZ = Math.hypot(d.x, d.z);
      rows.push({ pair: pair.join('/'), found: true, a: oa.name, b: ob.name,
                  A: [+A.x.toFixed(3), +A.y.toFixed(3), +A.z.toFixed(3)],
                  B: [+B.x.toFixed(3), +B.y.toFixed(3), +B.z.toFixed(3)],
                  lenXZ: +lenXZ.toFixed(4), lenFull: +Math.hypot(d.x,d.y,d.z).toFixed(4) });
    }
    return { rig: rig.name, rows };
  })()`);
  console.log('\n重放 measureFacingFrom:');
  console.log(JSON.stringify(replay, null, 2));
  const turn = await page.evaluate(`(() => {
    const snap = window.__QM__.actorsSnapshot();
    const abs = snap.map((s) => Math.abs(s.turnDiffDeg ?? 0)).sort((a, b) => a - b);
    return {
      turnDiff_min: abs[0],
      turnDiff_p50: abs[Math.floor(abs.length / 2)],
      turnDiff_max: abs[abs.length - 1],
      near180: abs.filter((d) => d > 150).length,
      near0: abs.filter((d) => d < 30).length,
      curYawDeg_sample: snap.slice(0, 6).map((s) => s.curYawDeg),
      targetYaw_sample: snap.slice(0, 6).map((s) => s.yawDeg),
    };
  })()`);
  console.log('\n转身读数(目标 − 实际欧拉角,单位:度):');
  console.log(JSON.stringify(turn, null, 2));
} finally {
  await close();
}

// —— 转身读数 ——
// update() 用的是 `diff = it.yaw - it.rig.rotation.y`。若两者不同口径,
// diff 会恒为 ±180°,表现为"所有走动的人都在缓慢自转"。
// 这一组直接把它印出来,不再靠推理。
