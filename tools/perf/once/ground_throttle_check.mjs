#!/usr/bin/env node
/**
 * 地面采样节流改完之后,人**还踩在地上吗** —— 一次性核查,不进正式流程。
 *
 * 改动的风险很具体:节流之后 `pos.y` 每 0.3 米才更新一次,两次更新之间
 * 高度是缓存的旧值。走上虹桥拱面时,真实地面在升、`pos.y` 不动,
 * 于是人可能**陷进桥面**或者**浮起来**。画面上这个差别在几十厘米级别
 * 看得出来,但"看着像悬空"和"真的悬空"用眼睛分不了 —— 必须量。
 *
 * 量法是拿一条**独立于被改动代码**的路径对质:
 *   · 人物自己记的 `pos[1] − baseOffsetY`(走的是节流后的缓存高度)
 *   · 探针现场打的 `groundAt(pos[0], pos[2])`(走的是未节流的射线)
 * 两者之差就是节流引入的高度误差。再核对:
 *   · 有没有人站在 `groundAt` 打不到的地方(说明走进了河里/走出地形);
 *   · 一段时间里每个人是否都在移动(说明没人被自己的节流判据卡死)。
 *
 * 用法: node tools/perf/once/ground_throttle_check.mjs
 */
import { launch, sleep } from '../lib/cdp.mjs';

const { page, close } = await launch({ width: 1920, height: 1080 });
try {
  await page.goto('http://127.0.0.1:4173/?q=high&hud=0&spot=bridge');
  await page.waitForReady({ timeout: 180000 });
  await sleep(8000);

  const check = `(() => {
    const qm = window.__QM__;
    const snap = qm.actorsSnapshot();
    const errs = [], onWater = [], notGrounded = [];
    for (const a of snap) {
      if (!a.grounded) { notGrounded.push(a.id); continue; }
      const g = qm.groundAt(a.pos[0], a.pos[2]);
      if (g === null) { onWater.push(a.id); continue; }
      // 脚底应有的高度 = pos.y − baseOffsetY;与现场打出来的地面比
      errs.push({ id: a.id, err: (a.pos[1] - a.baseOffsetY) - g });
    }
    errs.sort((p, q) => Math.abs(p.err) - Math.abs(q.err));
    const abs = errs.map((e) => Math.abs(e.err));
    const r4 = (v) => Math.round(v * 10000) / 10000;
    return {
      total: snap.length,
      checked: errs.length,
      notGrounded: notGrounded.length,
      onWater,
      errP50: r4(abs[Math.floor(abs.length * 0.5)] ?? 0),
      errP95: r4(abs[Math.floor(abs.length * 0.95)] ?? 0),
      errMax: r4(abs[abs.length - 1] ?? 0),
      worst: errs.slice(-3).map((e) => ({ id: e.id, err: r4(e.err) })),
    };
  })()`;

  const a = await page.evaluate(check);
  console.log('① 贴地与高度误差(节流后):');
  console.log(`   人数 ${a.total},参与核对 ${a.checked},不贴地(船上)${a.notGrounded}`);
  console.log(`   |pos.y − baseOffsetY − groundAt|: p50=${a.errP50}m  p95=${a.errP95}m  max=${a.errMax}m`);
  console.log(`   误差最大的三个: ${JSON.stringify(a.worst)}`);
  console.log(`   站在打不到地面的位置(走进河里/出地形): ${a.onWater.length} 人 ${JSON.stringify(a.onWater.slice(0, 8))}`);

  // ② 有没有人被卡死:隔 6 秒看两次位移
  const p0 = await page.evaluate('window.__QM__.actorsSnapshot().map((a) => [a.id, a.pos[0], a.pos[2]])');
  await sleep(6000);
  const p1 = await page.evaluate('window.__QM__.actorsSnapshot().map((a) => [a.id, a.pos[0], a.pos[2]])');
  const m0 = new Map(p0.map((r) => [r[0], r]));
  let moved = 0, stuck = 0;
  const stuckIds = [];
  for (const r of p1) {
    const b = m0.get(r[0]);
    if (!b) continue;
    const d = Math.hypot(r[1] - b[1], r[2] - b[2]);
    if (d > 0.2) moved++; else { stuck++; stuckIds.push(r[0]); }
  }
  console.log(`\n② 6 秒内的位移:移动 >0.2m 的 ${moved} 人,几乎没动的 ${stuck} 人`);
  console.log(`   没动的(站桩的撑船/摆摊人本来就不动,清单供核对): ${JSON.stringify(stuckIds.slice(0, 12))}`);

  // ③ 高度误差是不是随坡度变大 —— 上桥的人误差应当比平地的人大
  const onBridge = await page.evaluate(`(() => {
    const qm = window.__QM__;
    const snap = qm.actorsSnapshot();
    let n = 0, maxErr = 0;
    for (const a of snap) {
      if (!a.grounded) continue;
      const g = qm.groundAt(a.pos[0], a.pos[2]);
      if (g === null) continue;
      if (g > 1.0) {  // 桥面高于地面,粗判在桥上
        n++;
        maxErr = Math.max(maxErr, Math.abs((a.pos[1] - a.baseOffsetY) - g));
      }
    }
    return { n, maxErr: Math.round(maxErr * 10000) / 10000 };
  })()`);
  console.log(`\n③ 桥面上的人 ${onBridge.n} 个,其中最大高度误差 ${onBridge.maxErr}m(拱面是坡度最大的地方)`);
} finally {
  await close();
}
