#!/usr/bin/env node
/**
 * 一次性诊断:`effects.mjs` 的 B1/E1 偶发(607 个差异像素,峰值 32/255)
 * 到底是**哪一帧和哪一帧**不一样。
 *
 * 已知的读数特征(来自加了包围盒的 B1/E1):
 *   · `off` ≠ `off2`,但 `off2` ≡ `off3`(B1 与 E1 报的是同一个数)
 *   · 差异散在一个大窗口里(实测 x 0~973, y 308~717),不是一小块
 *   · 峰值只有 32/255 —— 不是烟/鸟出现或消失(那会差得多)
 *
 * 所以嫌疑集中在"**第一次 render 与之后的不一样**"。这个脚本就拍一串
 * **连续**的帧(中间不改任何状态),逐对比,把"从第几帧起稳定"直接量出来。
 *
 * 同时把几路可能随时间变动的量一起读回来:
 *   · RiverReflector 的 reflectionPasses / skippedPasses(节流有没有参与)
 *   · 帧计数器
 * 如果差异帧上反射 pass 的次数没变,那反射就不是原因。
 *
 * 用法: node tools/perf/once/fx_settle.mjs --url http://127.0.0.1:4173/
 */
import { launch, sleep } from '../lib/cdp.mjs';

const url = (() => {
  const i = process.argv.indexOf('--url');
  return i >= 0 ? process.argv[i + 1] : 'http://127.0.0.1:4173/';
})();

const { page, close } = await launch({ width: 1600, height: 900 });
try {
  await page.goto(url);
  await page.waitForReady();
  await sleep(6000);
  await page.evaluate('window.__QM__.loop.stop(window.__QM__.renderer)');
  await sleep(200);

  const setup = await page.evaluate(`(() => {
    const qm = window.__QM__;
    const gl = qm.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    window.__FD__ = {
      w: w, h: h, frames: [],
      grab: function () {
        qm.renderer.render(qm.scene, qm.camera);
        const buf = new Uint8Array(this.w * this.h * 4);
        gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        this.frames.push(buf);
        return this.frames.length - 1;
      },
      cmp: function (a, b) {
        const A = this.frames[a], B = this.frames[b];
        let changed = 0, maxD = 0;
        let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
        for (let i = 0; i < A.length; i += 4) {
          const m = Math.max(Math.abs(A[i]-B[i]), Math.abs(A[i+1]-B[i+1]), Math.abs(A[i+2]-B[i+2]));
          if (m > 0) {
            changed++;
            const px = (i >> 2) % this.w;
            const py = this.h - 1 - Math.floor((i >> 2) / this.w);
            if (px < x0) x0 = px;
            if (px > x1) x1 = px;
            if (py < y0) y0 = py;
            if (py > y1) y1 = py;
          }
          if (m > maxD) maxD = m;
        }
        return { changed: changed, maxD: maxD, box: [x0, y0, x1, y1] };
      },
    };
    return { w: w, h: h };
  })()`);
  console.log(`drawingBuffer ${setup.w}x${setup.h}`);

  const probe = () =>
    page.evaluate(`(() => {
      const q = window.__QM__;
      const r = q.riverReflect ? q.riverReflect.report() : null;
      return { refl: r ? { passes: r.reflectionPasses, skipped: r.skippedPasses } : null };
    })()`);

  const key = [];
  console.log('\n每条 = 一次 render,中间不改任何状态。');

  // 甲:直接连拍 8 帧,看"第一帧"是不是异类
  for (let i = 0; i < 8; i++) {
    await page.evaluate('window.__FD__.grab()');
    key.push(await probe().catch(() => null));
  }
  let out = [];
  for (let i = 1; i < 8; i++) {
    out.push(await page.evaluate(`window.__FD__.cmp(${i - 1}, ${i})`));
  }
  console.log('\n[A] 不停状态,连拍 8 帧 —— 相邻两帧的差异:');
  out.forEach((d, i) => {
    console.log(
      `    帧 ${i} → ${i + 1}: ${String(d.changed).padStart(6)} px  峰值 ${String(d.maxD).padStart(3)}` +
        `  窗口 ${JSON.stringify(d.box)}` +
        (key[i + 1] && key[i + 1].refl
          ? `   反射 pass ${key[i].refl.passes}→${key[i + 1].refl.passes}` +
            ` 跳过 ${key[i].refl.skipped}→${key[i + 1].refl.skipped}`
          : ''),
    );
  });

  // 乙:模仿 effects.mjs 的真实顺序 —— 切一次 fx 状态,再连拍
  console.log('\n[B] 切一次 setFxOverride(0,0) 之后再连拍 6 帧:');
  const base = await page.evaluate('window.__FD__.frames.length');
  await page.evaluate(`(() => window.__QM__.setFxOverride(0, 'smoke'))()`);
  await page.evaluate(`(() => window.__QM__.setFxOverride(0, 'birds'))()`);
  for (let i = 0; i < 6; i++) await page.evaluate('window.__FD__.grab()');
  for (let i = 1; i < 6; i++) {
    const d = await page.evaluate(`window.__FD__.cmp(${base + i - 1}, ${base + i})`);
    console.log(
      `    切后帧 ${i - 1} → ${i}: ${String(d.changed).padStart(6)} px  峰值 ${String(d.maxD).padStart(3)}` +
        `  窗口 ${JSON.stringify(d.box)}`,
    );
  }
} finally {
  await close();
}
