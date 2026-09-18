#!/usr/bin/env node
/**
 * 风动**实际改变了多少个像素** —— 用两帧之差测量,不靠肉眼。
 *
 * ## 为什么要量
 *
 * "柳枝在摆"这件事,单张截图永远证明不了:一张静止的图里,
 * 一棵被吹歪 4% 的树和一棵完全静止的树长得一模一样。
 *
 * ## 量的是**峰峰值**,不是随便两帧之差
 *
 * 第一版随便取了两帧,结果每个件的读数都被"噪声地板"淹没 ——
 * 而那个地板本身就是假的:我用 `sleep(40)` 当作两帧间隔 40 毫秒,
 * 可 `captureScreenshot` 自己就要花几百毫秒,真实间隔是未知的,
 * 于是"噪声"里混着真实运动。**先用一把没刻度的尺子量长度**。
 *
 * 改法有两条:
 *   ① 帧的**场景时间**从页面里读(`uQmTime` uniform 就是 worldTime),
 *      不再拿墙钟当时间戳,每次截图都带上实际时刻;
 *   ② 采样点取**半个周期**。风动是 `sin(wt+φ)`,隔半周期正是
 *      +A 到 −A,两帧之差就是该件在整个周期里**最大**能变多少。
 *      这比"随便看两帧"有定义,也是"看不看得出来"的上界。
 *
 * 参照区(屋顶/地面/墙面)不参与风动,它们在两帧里必须**逐像素为 0**;
 * 不为 0 就说明这个量具本身有问题,先修量具再谈结论。
 *
 * ⚠️ 矩形是物体的屏幕包围盒,**包含背景**。读数只能说"这一片区域变了多少"。
 *
 * 用法: node tools/perf/once/flex_motion.mjs [URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

const argv = process.argv.slice(2);
const URL = argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:4173/?q=high&hud=0&spot=market';
const WARMUP = argv.includes('--warmup') ? Number(argv[argv.indexOf('--warmup') + 1]) : 5000;
const W = 1600, H = 900;

// 与 propsAnim.ts 的 FLEX_PROFILE 对应。改了那边要同步改这里 ——
// 采样点错了,量出来的就不是峰峰值。
const PERIOD = { wind: 2 * Math.PI / 2.2, sway: 2 * Math.PI / 0.95 };  // ≈2.86s / ≈6.61s

const CONTROLS = [
  [700, 120, 900, 200, '屋顶(静物)'],
  [200, 700, 400, 780, '地面(静物)'],
  [1150, 250, 1300, 330, '建筑墙面(静物)'],
];

const { page, close } = await launch({ width: W, height: H });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(WARMUP);

  const rects = await page.evaluate(`(() => {
    const qm = window.__QM__, THREE = qm.THREE;
    const out = [];
    qm.scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const gu = o.material.userData && o.material.userData.qmFlexUniforms;
      if (!gu) return;
      o.updateWorldMatrix(true, false);
      const b = new THREE.Box3().setFromObject(o);
      if (b.isEmpty()) return;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, any = false;
      for (let i = 0; i < 8; i++) {
        const v = new THREE.Vector3(
          i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z
        ).project(qm.camera);
        if (v.z > 1) continue;
        any = true;
        const sx = (v.x * 0.5 + 0.5) * ${W}, sy = (-v.y * 0.5 + 0.5) * ${H};
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
        y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
      if (!any) return;
      x0 = Math.max(0, x0); y0 = Math.max(0, y0);
      x1 = Math.min(${W}, x1); y1 = Math.min(${H}, y1);
      if (x1 - x0 < 6 || y1 - y0 < 6) return;   // 太小没有统计意义
      out.push({ name: o.name, anim: o.userData.qm_anim,
                 rect: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)] });
    });
    return out;
  })()`);

  /** 场景时间。uQmTime 就是喂进风动着色器的 worldTime,拿它当帧的时间戳。 */
  const sceneTime = () => page.evaluate(`(() => {
    let t = null;
    window.__QM__.scene.traverse((o) => {
      if (t !== null) return;
      const gu = o.material && o.material.userData && o.material.userData.qmFlexUniforms;
      if (gu) t = gu.uQmTime.value;
    });
    return t;
  })()`);

  async function captureAt(slot, targetT) {
    // 等到场景时间越过目标点**再**截,这样采样点落在周期上的指定相位
    if (targetT != null) {
      const deadline = Date.now() + 30000;
      for (;;) {
        const t = await sceneTime();
        if (t === null || t >= targetT) break;
        if (Date.now() > deadline) throw new Error('等待场景时间超时');
        await sleep(15);
      }
    }
    const { data } = await page.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
    });
    const tAfter = await sceneTime();   // 截图**之后**再读;与帧的实际时刻相差不超过一帧
    await page.evaluate(`(async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,${data}';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      window.__QM_DIFF__ = window.__QM_DIFF__ || {};
      window.__QM_DIFF__.${slot} = ctx.getImageData(0, 0, img.width, img.height);
      return true;
    })()`);
    return tAfter;
  }

  /**
   * 比较两槽。判据用**亮度差**:风动只挪位置不改颜色,
   * 用色差会把抗锯齿的彩边也算进去。
   *   pct6 —— 亮度差超过 6 的像素占比。6 大致是并排比较的可辨阈,
   *           这个数才是"眼睛能不能看出"的代理量。
   */
  const compare = (a, b, list) => page.evaluate(`(() => {
    const A = window.__QM_DIFF__.${a}.data, B = window.__QM_DIFF__.${b}.data;
    const w = window.__QM_DIFF__.${a}.width;
    const rows = [];
    for (const item of ${JSON.stringify(list)}) {
      const [x0, y0, x1, y1] = item.rect;
      let sum = 0, n = 0, over = 0, max = 0;
      for (let y = y0; y < y1; y++) {
        let idx = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, idx += 4) {
          const la = 0.2126 * A[idx] + 0.7152 * A[idx + 1] + 0.0722 * A[idx + 2];
          const lb = 0.2126 * B[idx] + 0.7152 * B[idx + 1] + 0.0722 * B[idx + 2];
          const d = Math.abs(la - lb);
          sum += d; n++;
          if (d > 6) over++;
          if (d > max) max = d;
        }
      }
      rows.push({ name: item.name, anim: item.anim || null, px: n,
                  meanAbs: +(sum / n).toFixed(2),
                  pct6: +(over / n * 100).toFixed(1), max: +max.toFixed(1) });
    }
    return rows;
  })()`);

  const ctrlList = CONTROLS.map((c) => ({ name: c[4], anim: '对照', rect: [c[0], c[1], c[2], c[3]] }));
  const list = [...rects, ...ctrlList];

  const t0 = await captureAt('a', null);
  const t1 = await captureAt('b', t0 + PERIOD.wind / 2);      // 风:半周期 → ±A
  const t2 = await captureAt('c', t0 + PERIOD.sway / 2);      // 柳:半周期 → ±A

  const wind = await compare('a', 'b', list);
  const sway = await compare('a', 'c', list);

  const windBy = Object.fromEntries(wind.map((r) => [r.name, r]));
  const swayBy = Object.fromEntries(sway.map((r) => [r.name, r]));
  const rows = [...rects, ...ctrlList].map((it) => {
    const isSway = it.anim === 'sway';
    const r = isSway ? swayBy[it.name] : windBy[it.name];
    return { ...r, dt: isSway ? (t2 - t0) : (t1 - t0) };
  });
  rows.sort((a, b) => b.pct6 - a.pct6);

  console.log(`机位 ${URL}`);
  console.log(`帧的场景时刻: t0=${t0.toFixed(2)}s  t1=${t1.toFixed(2)}s(+${(t1 - t0).toFixed(2)})  t2=${t2.toFixed(2)}s(+${(t2 - t0).toFixed(2)})`);
  console.log('每件取**自己类别的半周期**:风 2.86s→±A,柳 6.61s→±A,即该件一个周期内的最大变化\n');
  console.log('  名称                   类别   半周期   像素数   信号Δ亮度  变化>6占比  最大Δ');
  for (const r of rows) {
    const isCtrl = r.anim === '对照';
    const verdict = isCtrl
      ? (r.pct6 === 0 ? '  ✅ 静止(量具可信)' : '  ⚠️ 静止区却在变,量具可疑')
      : r.pct6 < 1
        ? '  ← 几乎无像素变化,看不见'
        : r.pct6 < 5
          ? '  ← 有变化,偏弱'
          : r.pct6 < 15
            ? '  ← 能看出在动'
            : '  ← 明显可见';
    console.log(
      `  ${r.name.padEnd(22)} ${String(r.anim ?? '').padEnd(6)} ${String(r.dt.toFixed(2)).padStart(6)}s ` +
      `${String(r.px).padStart(7)} ${String(r.meanAbs).padStart(9)}  ${String(r.pct6).padStart(9)}%  ` +
      `${String(r.max).padStart(6)}${verdict}`,
    );
  }
} finally {
  await close();
}
