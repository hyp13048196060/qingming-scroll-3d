#!/usr/bin/env node
/**
 * 轴心约定对不对 —— 以及屏幕上那根斜杆到底是什么。
 *
 * ## 为什么要单独查轴心
 *
 * 实测 `qm_pivot` 的 y 从 −46.7 铺到 +51.8,据此判定它是**世界坐标**。
 * 但"看起来像世界坐标"不是证明。真正的判据是:
 * **Blender 给的轴心,该落在 Blender 给的那件东西身上。**
 * 若把世界坐标误当局部坐标用,物体会绕着一个远在几十米外的点公转 ——
 * 在大范围截图里,"橹绕着河对岸转"和"橹正常插在船边"都可能被看成
 * 一根斜在水上的杆子,靠眼睛分不出来。
 *
 * 于是量:`重心到轴心的距离`。重心用包围盒中心(世界坐标)。
 * 对桅/橹/舵这类细长件,合理的值应当是**同一量级**(几米以内);
 * 若是几十米,约定就错了。
 *
 * ## 屏幕拾取
 *
 * 猜测"那根杆子是什么"没有意义。从相机穿过指定像素打一条线,
 * 让场景自己回答。
 *
 * 用法: node tools/perf/once/rigid_pivot_check.mjs [URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

// ⚠️ 画质档位必须**和要对照的那张截图一致**。
//    low 档反射是关的,`RiverFlatFallback` 那块平板会被显示出来并在拾取中挡住水面;
//    high 档它是隐藏的。用 low 拾取、拿 high 的截图对照,是对着两张不同的画面
//    说同一件事 —— 本项目已经在"截图档位与状态 json 不符"上栽过一次。
const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=high&hud=0&spot=boat';

// 要在屏幕上认的像素(1600×900 视口下的坐标)
const PICKS = [
  [800, 670, '船尾斜着的那块板'],
  [800, 550, '漕船船身'],
  [752, 470, '船上A形桅'],
  [790, 545, '船尾竖杆'],
  [1240, 560, '原先斜杆的位置(现在应当只有水)'],
];

const { page, close } = await launch({ width: 1600, height: 900 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(4000);

  const out = await page.evaluate(`(() => {
    const qm = window.__QM__, THREE = qm.THREE;

    const rows = [];
    const box = new THREE.Box3();
    qm.scene.traverse((o) => {
      const u = o.userData || {};
      const a = u.qm_anim;
      if (!a || a === 'none') return;
      if (o.isSkinnedMesh) return;
      if (!u.qm_pivot) return;
      const p = String(u.qm_pivot).split(',').map(Number);
      if (p.length !== 3 || !p.every(Number.isFinite)) return;

      o.updateWorldMatrix(true, false);
      box.setFromObject(o);
      if (box.isEmpty()) return;
      const c = box.getCenter(new THREE.Vector3());
      // 轴心是 Blender 的 Z 向上坐标,重心是 three 的 Y 向上坐标。
      // 不换算就比,是拿两把不同刻度的尺子量同一段长度 —— 必然差几十米,
      // 而这个差值看起来像"轴心错了"。换算规则 (x,y,z)→(x,z,−y)。
      const pivot = new THREE.Vector3(p[0], p[2], -p[1]);
      rows.push({
        name: o.name, anim: a,
        pivot: [+p[0].toFixed(2), +p[1].toFixed(2), +p[2].toFixed(2)],
        center: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
        size: [+(box.max.x - box.min.x).toFixed(2), +(box.max.y - box.min.y).toFixed(2), +(box.max.z - box.min.z).toFixed(2)],
        // 轴心到**包围盒**的距离:轴心通常贴在件的某一端,不一定在中心
        distCenter: +c.distanceTo(pivot).toFixed(2),
        insideBox: box.containsPoint(pivot),
      });
    });

    // 屏幕拾取
    const cam = qm.camera;
    cam.updateMatrixWorld();
    const picks = [];
    for (const [px, py, label] of ${JSON.stringify(PICKS)}) {
      const ndc = new THREE.Vector2((px / 1600) * 2 - 1, -(py / 900) * 2 + 1);
      const rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, cam);
      const hits = rc.intersectObjects(qm.scene.children, true);
      const h = hits.find((x) => x.object.visible);
      picks.push({
        label, px, py,
        hit: h ? {
          name: h.object.name,
          anim: (h.object.userData || {}).qm_anim || null,
          id: (h.object.userData || {}).qm_id || null,
          part: (h.object.userData || {}).qm_part || null,
          dist: +h.distance.toFixed(2),
          point: [+h.point.x.toFixed(2), +h.point.y.toFixed(2), +h.point.z.toFixed(2)],
          skinned: !!h.object.isSkinnedMesh,
        } : null,
      });
    }
    // 把被驱动的件投影到屏幕,给出一块**可以照着看的方框**。
    // 靠"图上大概在这个像素"猜是白费劲 —— 上一版猜了两次都打在水面上。
    const rects = [];
    for (const o of (() => {
      const a = [];
      qm.scene.traverse((x) => {
        const u = x.userData || {};
        if (u.qm_anim && u.qm_anim !== 'none' && u.qm_pivot && !x.isSkinnedMesh) a.push(x);
      });
      return a;
    })()) {
      o.updateWorldMatrix(true, false);
      const b = new THREE.Box3().setFromObject(o);
      if (b.isEmpty()) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
      for (let i = 0; i < 8; i++) {
        const v = new THREE.Vector3(
          i & 1 ? b.max.x : b.min.x,
          i & 2 ? b.max.y : b.min.y,
          i & 4 ? b.max.z : b.min.z,
        ).project(qm.camera);
        // z>1 在相机后面,投出来的坐标是镜像的假值,必须丢掉
        if (v.z > 1) continue;
        any = true;
        const sx = (v.x * 0.5 + 0.5) * 1600, sy = (-v.y * 0.5 + 0.5) * 900;
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
        y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
      if (!any) continue;
      const onScreen = x1 > 0 && y1 > 0 && x0 < 1600 && y0 < 900;
      rects.push({
        name: o.name, anim: o.userData.qm_anim,
        rect: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)],
        onScreen,
      });
    }
    rects.sort((a, b) => a.rect[1] - b.rect[1]);
    return { rows, picks, rects };
  })()`);

  console.log('===== 轴心 vs 件本身(世界坐标)=====');
  console.log('  name           anim       轴心                      重心                      尺寸(米)          轴心到重心  轴心在盒内');
  const rows = out.rows.sort((a, b) => b.distCenter - a.distCenter);
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(14)} ${r.anim.padEnd(10)} [${r.pivot.join(', ').padEnd(22)}] [${r.center.join(', ').padEnd(22)}] ` +
      `[${r.size.join(' × ').padEnd(18)}] ${String(r.distCenter).padStart(8)}   ${r.insideBox ? '是' : '否'}`,
    );
  }
  const ds = rows.map((r) => r.distCenter).sort((a, b) => a - b);
  const inside = rows.filter((r) => r.insideBox).length;
  console.log(`\n  轴心到重心距离: 最小 ${ds[0]}m  中位 ${ds[Math.floor(ds.length / 2)]}m  最大 ${ds[ds.length - 1]}m`);
  console.log(`  轴心落在件自身的包围盒内: ${inside}/${rows.length}`);

  console.log('\n===== 被驱动的件在屏幕上的位置(1600×900 视口)=====');
  console.log('  (照这些方框去看截图,不用猜像素)');
  for (const r of out.rects) {
    const [x0, y0, x1, y1] = r.rect;
    console.log(`  ${r.name.padEnd(14)} ${String(r.anim).padEnd(10)} 框 x ${String(x0).padStart(5)}–${String(x1).padStart(5)}  y ${String(y0).padStart(4)}–${String(y1).padStart(4)}  ` +
      `面积 ${String((x1 - x0) * (y1 - y0)).padStart(8)} px²  ${r.onScreen ? '' : '**画面外**'}`);
  }

  console.log('\n===== 屏幕拾取 =====');
  for (const p of out.picks) {
    if (!p.hit) { console.log(`  (${p.px},${p.py}) ${p.label} → **没打到任何东西**`); continue; }
    const h = p.hit;
    console.log(`  (${p.px},${p.py}) ${p.label.padEnd(12)} → ${h.name.padEnd(22)} anim=${String(h.anim).padEnd(10)} part=${String(h.part).padEnd(9)} ` +
      `蒙皮=${h.skinned ? 'Y' : 'n'} 距离=${h.dist}m 命中点=[${h.point.join(', ')}]`);
  }
} finally {
  await close();
}
