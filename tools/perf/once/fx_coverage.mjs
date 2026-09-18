#!/usr/bin/env node
/**
 * 炊烟与飞鸟,在**五个景点机位**里各自看得见几个?
 *
 * 起因:`fx_ab.mjs` 在 `spot=bridge` 量出——6 个烟源里 **5 个不在画面内**,
 * 96 团烟只贡献出 1 团可见的烟,飞鸟一只都没有。于是"看不见烟和鸟"这话
 * 到底该怪谁,分成了两种完全相反的可能:
 *   A 粒子做得太淡/太小  → 加浓、加大
 *   B 相机压根没往那儿看 → 挪烟源、改航线
 * 桥机位的数据指向 B,但**一个机位不能代表五个**。若只凭桥机位就去加浓,
 * 会出现"桥边那一团浓得发腻,而另外四个机位依旧什么都看不见"——
 * 越改越糟,而且改的是错的那一半。所以先把五个机位一次量完。
 *
 * 量四件事(全部是投影计算,不含像素比对,所以很快):
 *   ① 相机的俯仰角与地平线所在行 → **天在画面里占几行**
 *      (天只有 30 行的话,飞鸟再完美也只是不在取景里)
 *   ② 每个烟源投影到哪、在不在画面内
 *   ③ 飞鸟盘旋的整个空域(环形网格)**有多少比例落在画面内**
 *      —— 不看单只鸟,看整条航线;单只鸟在不在是运气,航线在不在是设计
 *   ④ 每处能看到的天/烟源列表
 *
 * ⚠️ 全部用**自上而下**的行号(与肉眼、与截图、与 `fx_ab.mjs` 一致)。
 *    `project()` 出来的 NDC 已经翻好,这里不再二次翻转。
 *
 * ⚠️ 飞鸟空域取自 `fxRuntime().birdBand`,**不在这里抄一份常数** ——
 *    抄一份的话,改 `ParticleFx.ts` 不会改到这里,探针会拿旧航线算出一个
 *    "明明在画面里"的结论,而画面里其实没有。这类分家不会报错。
 *
 * 用法: node tools/perf/once/fx_coverage.mjs [BASE_URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:4173/';
const SPOTS = ['bridge', 'boat', 'teahouse', 'gate', 'market'];

const { page, close, browserVersion } = await launch({ width: 1280, height: 720 });
const rows = [];
try {
  for (const spot of SPOTS) {
    const url = `${BASE}?spot=${spot}&q=high&hud=0`;
    await page.goto(url);
    await page.waitForReady({ timeout: 120000 });
    // 相机是 tween 过去的,必须等它停 —— 在飞行途中量投影,
    // 量到的是"路过的一个机位",而不是景点机位本身。
    await sleep(4000);

    const r = await page.evaluate(`(() => {
      const qm = window.__QM__;
      const THREE = qm.THREE;
      const cam = qm.camera;
      cam.updateMatrixWorld();
      const gl = qm.renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;

      const toScreen = (v) => {
        const p = v.clone().project(cam);
        return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h,
                 inFront: p.z < 1 && p.z > -1 };
      };
      const inside = (s) => s.inFront && s.x >= 0 && s.x < w && s.y >= 0 && s.y < h;

      // 相机俯仰:视轴与水平面的夹角,向下为正
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      const pitchDeg = Math.asin(-fwd.y) * 180 / Math.PI;

      // 地平线行:沿水平方向取一个极远点投影
      const flat = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
      const horizonPt = cam.position.clone().addScaledVector(flat, 100000);
      const horizon = toScreen(horizonPt);

      const rt = qm.fxRuntime();
      const emitters = rt.emitters.map((e) => {
        const s = toScreen(new THREE.Vector3(e.at[0], e.at[1], e.at[2]));
        return { from: e.from, x: Math.round(s.x), y: Math.round(s.y), on: inside(s) };
      });

      // 飞鸟空域:环形网格。半径取内/中/外,高度取上下限与中点,
      // 角度每 15° 一个 —— 240 个点足以说清整条航线有多少落在取景里。
      const b = rt.birdBand;
      let bandTotal = 0, bandInside = 0, bandFront = 0;
      const insideYs = [];
      for (const radius of [b.rMin, (b.rMin + b.rMax) / 2, b.rMax]) {
        for (const y of [b.yMin, (b.yMin + b.yMax) / 2, b.yMax]) {
          for (let a = 0; a < 360; a += 15) {
            const rad = a * Math.PI / 180;
            const p = new THREE.Vector3(
              b.center[0] + Math.cos(rad) * radius, y, b.center[1] + Math.sin(rad) * radius);
            const s = toScreen(p);
            bandTotal++;
            if (s.inFront) bandFront++;
            if (inside(s)) { bandInside++; insideYs.push(Math.round(s.y)); }
          }
        }
      }

      return {
        w, h,
        camPos: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1), +cam.position.z.toFixed(1)],
        pitchDeg: +pitchDeg.toFixed(1),
        vfovDeg: +cam.fov.toFixed(1),
        horizonRow: Math.round(horizon.y),
        skyRows: Math.max(0, Math.round(horizon.y)),
        emitters,
        emitterOn: emitters.filter((e) => e.on).length,
        bandTotal, bandInside, bandFront,
        bandYSpan: insideYs.length ? [Math.min(...insideYs), Math.max(...insideYs)] : null,
        puffs: rt.puffs, birds: rt.birds,
      };
    })()`);
    r.spot = spot;
    rows.push(r);
  }
} finally {
  await close();
}

console.log(`浏览器 ${browserVersion}`);
console.log('');
const pad = (s, n) => String(s).padEnd(n);
console.log('景点      相机位置               俯仰    地平线行  天占行数  在画面内的烟源  飞鸟空域在画面内');
for (const r of rows) {
  const on = r.emitters.filter((e) => e.on).map((e) => e.from).join(',') || '—';
  console.log(
    pad(r.spot, 9) +
      pad(`(${r.camPos.join(', ')})`, 23) +
      pad(`${r.pitchDeg}°`, 8) +
      pad(r.horizonRow, 10) +
      pad(r.skyRows, 10) +
      pad(`${r.emitterOn}/${r.emitters.length}  ${on}`, 16) +
      `${r.bandInside}/${r.bandTotal} (${((r.bandInside / r.bandTotal) * 100).toFixed(0)}%)` +
      (r.bandYSpan ? ` y${r.bandYSpan[0]}..${r.bandYSpan[1]}` : ''),
  );
}
console.log('');
for (const r of rows) {
  console.log(`── ${r.spot}  视场竖直 ${r.vfovDeg}°  俯仰 ${r.pitchDeg}°(正=向下看)`);
  for (const e of r.emitters) {
    console.log(`     ${e.on ? '✔' : '·'} ${pad(e.from, 26)} 屏幕(${String(e.x).padStart(5)}, ${String(e.y).padStart(5)})`);
  }
}
