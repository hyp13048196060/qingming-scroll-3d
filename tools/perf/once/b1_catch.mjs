#!/usr/bin/env node
/**
 * 一次性诊断:专门逮 `effects.mjs` B1 的偶发差异,并把**像素本身**带回来。
 *
 * 已知(来自 8 次运行):
 *   · 4 次复现,计数 230/236/305/314/607,窗口每次不同 → 不是固定形状
 *   · 差异聚成 3~5 px 的小块,散在画面各处
 *   · 绝大多数 |Δ| = 1/255,少数到 31/255
 *   · 循环是**停掉的**(effects.mjs:153),所以两次采样之间场景是静止的
 *
 * "几个像素、峰值多少"说不清"那是什么";**颜色**能:
 * 烟是暖白、水是青蓝、阴影是压暗、鸟是深色小点。所以这一次除了位置,
 * 还把每个差异块中心的**两帧 RGB** 一起取回来。
 *
 * 顺序也照抄 effects.mjs:采样之间夹着 evaluate 往返(那是真实差异的一部分,
 * 不能为了好看把它省掉)。
 *
 * 用法: node tools/perf/once/b1_catch.mjs --url http://127.0.0.1:4173/ --rounds 12
 */
import { writeFileSync } from 'node:fs';
import { launch, sleep } from '../lib/cdp.mjs';

const argv = process.argv;
const pick = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
// ⚠️ 默认值**必须**与 effects.mjs 的 B1 一致,否则就是另一场实验:
//   窗口 1600x900 vs 1280x720、默认机位 vs ?spot=boat&q=high&hud=0,
//   两者都会换掉渲染路径。第一版这里用了默认值,12 轮 0 复现 —— 那是没复现出
//   我自己的条件,不是没复现出 B1(见 instrument-error-pattern 第 34 条)。
const url = pick('--url', 'http://127.0.0.1:4173/?spot=boat&q=high&hud=0');
const rounds = Number(pick('--rounds', '12'));

const { page, close } = await launch({ width: 1280, height: 720 });
try {
  await page.goto(url);
  await page.waitForReady();
  await sleep(5000);

  // ---- 页内工具:采样、比较、取色、导出 PNG --------------------------------
  const setup = await page.evaluate(`(() => {
    const qm = window.__QM__;
    const gl = qm.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    window.__BC__ = {
      w: w, h: h, S: {},
      // 与 effects.mjs 的 __EF__.sample 同序:render → readPixels
      sample: function (name) {
        // 照抄 __EF__.sample 的第一行。info.reset() 本身不改输出,但少写这一行
        // 就不是同一个序列了 —— 复现实验里"顺手的简化"正是假阴性的常见来源。
        qm.renderer.info.reset();
        qm.renderer.render(qm.scene, qm.camera);
        const buf = new Uint8Array(this.w * this.h * 4);
        gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        this.S[name] = buf;
        return buf.length;
      },
      // 差异:块位置 + 每块**两帧各自的 RGB**(这才是"那是什么"的答案)
      diff: function (a, b) {
        const A = this.S[a], B = this.S[b];
        const seen = new Uint8Array(this.w * this.h);
        const blobs = [];
        let changed = 0, maxD = 0;
        const hist = {};
        for (let i = 0; i < A.length; i += 4) {
          const d = Math.max(Math.abs(A[i]-B[i]), Math.abs(A[i+1]-B[i+1]), Math.abs(A[i+2]-B[i+2]));
          if (d > 0) changed++;
          if (d > maxD) maxD = d;
          if (d > 0) hist[d] = (hist[d] || 0) + 1;
          if (d > 0) {
            const p = i >> 2;
            const px = p % this.w, py = this.h - 1 - Math.floor(p / this.w);
            if (seen[p]) continue;
            // 洪水填充这一块(4 邻域,把稠密连着的一片算一块)
            const stack = [p]; seen[p] = 1;
            let n = 0, sx = 0, sy = 0, mx = 0, cen = p;
            while (stack.length) {
              const c = stack.pop(); n++;
              const cx = c % this.w, cy = Math.floor(c / this.w);
              sx += cx; sy += cy;
              if (cx === px + 0 && cy === Math.floor(p / this.w) && mx === 0) cen = c;
              const nb = [c-1, c+1, c-this.w, c+this.w];
              for (const q of nb) {
                if (q < 0 || q >= this.w * this.h || seen[q]) continue;
                const j = q * 4;
                const dd = Math.max(Math.abs(A[j]-B[j]), Math.abs(A[j+1]-B[j+1]), Math.abs(A[j+2]-B[j+2]));
                if (dd > 0) { seen[q] = 1; stack.push(q); }
              }
            }
            const ci = cen * 4;
            blobs.push({
              x: Math.round(sx / n), y: this.h - 1 - Math.round(sy / n), n: n,
              A: [A[ci], A[ci+1], A[ci+2]], B: [B[ci], B[ci+1], B[ci+2]],
            });
            if (blobs.length >= 40) return { changed: changed, maxD: maxD, hist: hist, blobs: blobs, truncated: true };
          }
        }
        return { changed: changed, maxD: maxD, hist: hist, blobs: blobs, truncated: false };
      },
      dump: function (name) {
        const A = this.S[name];
        const cv = document.createElement('canvas');
        cv.width = this.w; cv.height = this.h;
        const ctx = cv.getContext('2d');
        const img = ctx.createImageData(this.w, this.h);
        for (let y = 0; y < this.h; y++) {
          const src = (this.h - 1 - y) * this.w * 4, dst = y * this.w * 4;
          img.data.set(A.subarray(src, src + this.w * 4), dst);
        }
        ctx.putImageData(img, 0, 0);
        return cv.toDataURL('image/png');
      },
    };
    return { w: w, h: h };
  })()`);
  console.log(`drawingBuffer ${setup.w}x${setup.h},共试 ${rounds} 轮\n`);

  await page.evaluate('window.__QM__.loop.stop(window.__QM__.renderer)');
  await sleep(200);

  let caught = 0;
  for (let r = 1; r <= rounds; r++) {
    // 照抄 B1:同状态连拍两张,中间夹一次 evaluate 往返
    await page.evaluate(`window.__QM__.setFxOverride(0, 'smoke')`);
    await page.evaluate(`window.__QM__.setFxOverride(0, 'birds')`);
    await page.evaluate(`window.__BC__.sample('a')`);
    await page.evaluate(`(() => { const A = window.__BC__.S.a; let mn = 255, mx = 0;
      for (let i = 0; i < A.length; i += 4) { const l = 0.299*A[i]+0.587*A[i+1]+0.114*A[i+2];
        if (l < mn) mn = l; if (l > mx) mx = l; } return [mn, mx]; })()`);
    await page.evaluate(`window.__BC__.sample('b')`);
    const d = await page.evaluate(`window.__BC__.diff('a', 'b')`);

    if (d.changed === 0) {
      console.log(`  轮 ${String(r).padStart(2)}  ✅ 0 px`);
      continue;
    }
    caught++;
    console.log(`  轮 ${String(r).padStart(2)}  ❌ ${d.changed} px,峰值 ${d.maxD}/255` +
      `  直方图 ${JSON.stringify(d.hist)}  块数 ${d.blobs.length}${d.truncated ? '+' : ''}`);
    for (const bl of d.blobs.slice(0, 12)) {
      console.log(`        (${String(bl.x).padStart(4)},${String(bl.y).padStart(4)}) n=${String(bl.n).padStart(3)}` +
        `  帧a rgb(${bl.A.join(',')})  帧b rgb(${bl.B.join(',')})`);
    }
    for (const nm of ['a', 'b']) {
      const durl = await page.evaluate(`window.__BC__.dump('${nm}')`);
      writeFileSync(`screenshots/web/b1catch_${nm}.png`, Buffer.from(durl.split(',')[1], 'base64'));
    }
    console.log('        两帧已写入 screenshots/web/b1catch_a.png / b1catch_b.png');
    if (caught >= 2) break;
  }
  console.log(`\n${rounds} 轮里复现 ${caught} 次`);
} finally {
  await close();
}
