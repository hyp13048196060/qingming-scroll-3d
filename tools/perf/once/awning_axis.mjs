#!/usr/bin/env node
/**
 * 风动权重的**梯度轴**是不是"布自由摆动的那条轴"。
 *
 * 为什么要专门量这一条
 * --------------------
 * `propsAnim.ts` 推权重时用的是**局部 Y**:
 *
 *     weights[i] = clamp((bb.max.y - pos.getY(i)) / freeLen, 0, 1)
 *
 * 这个式子对**幌子**是对的 —— 幌子局部 Y 就是它垂下来的方向,实测
 * 权重沿 Y 线性(corr = −1.000)。但它被当成了一条通则,而通则里
 * 藏着一个未经检验的前提:**"局部 Y = 布的自由方向"**。
 *
 * 茶肆凉棚不满足这个前提。它是一片近乎水平的棚布,绷在**墙檐**与
 * **外沿撑杆**之间,自由方向是从墙往外挑的那 1.7 米(X 向);
 * 而它的局部 Y 是**铺面进深方向**,也就是沿街那十几米。
 * 若真是这样,推出来的权重就是"每一间棚布从街这头钉到街那头",
 * 摆起来是一端被钉死、另一端甩 —— 而物理上该是"贴墙那条边钉死、
 * 外沿自由"。
 *
 * 判据(三个数一起看,单看一个都会误判)
 * ------------------------------------
 *   ① 权重对局部 x / y / z 的相关系数 —— 梯度落在哪条轴上;
 *   ② 包围盒在三条轴上的尺寸 —— 哪条轴才是布的自由边长;
 *   ③ ①那条轴的尺寸 vs ②里最长的轴。
 * 若 ① 的轴与 ② 的最长轴一致 → 这套推法对这件是对的;
 * 若不一致 → 那是**一根轴搞错了**,不是幅度问题(幅度会被 clamp
 * 掩盖,从读数上看不出来)。
 *
 * 用法: node tools/perf/once/awning_axis.mjs [URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=low&hud=0&tags=1';

const { page, close } = await launch({ width: 900, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(3000);

  // ⚠️ 页内代码里**不要写正则**:模板字面量会把单反斜杠吃掉(见
  //    tag_dump.mjs 那次事故)。这里全部用逐字符比较与算术。
  const out = await page.evaluate(`(() => {
    const qm = window.__QM__;
    const rows = [];
    qm.scene.traverse((o) => {
      const gu = o.material && o.material.userData && o.material.userData.qmFlexUniforms;
      if (!gu) return;
      const geo = o.geometry;
      const w = geo.getAttribute('qmFlex');
      if (!w) return;
      const pos = geo.getAttribute('position');
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const n = Math.min(w.count, pos.count);
      const S = { x: [0, 0, 0], y: [0, 0, 0], z: [0, 0, 0], w: [0, 0, 0] };
      for (let i = 0; i < n; i++) {
        const v = [pos.getX(i), pos.getY(i), pos.getZ(i)];
        const k = w.getX(i);
        const acc = [S.x, S.y, S.z];
        for (let a = 0; a < 3; a++) { acc[a][0] += v[a]; acc[a][1] += v[a] * k; acc[a][2] += v[a] * v[a]; }
        S.w[0] += k; S.w[1] += k * k;
      }
      const mean = (s) => s[0] / n;
      const sd = (s) => Math.sqrt(Math.max(0, s[2] / n - mean(s) * mean(s)));
      const sw = Math.sqrt(Math.max(0, S.w[1] / n - (S.w[0] / n) * (S.w[0] / n)));
      const corr = (s) => {
        const cov = s[1] / n - mean(s) * (S.w[0] / n);
        const d = sd(s) * sw;
        return d < 1e-9 ? 0 : cov / d;
      };
      const ext = {
        x: bb.max.x - bb.min.x,
        y: bb.max.y - bb.min.y,
        z: bb.max.z - bb.min.z,
      };
      const cs = { x: corr(S.x), y: corr(S.y), z: corr(S.z) };
      const axes = ['x', 'y', 'z'];
      let grad = 'x';
      for (const a of axes) if (Math.abs(cs[a]) > Math.abs(cs[grad])) grad = a;
      let longest = 'x';
      for (const a of axes) if (ext[a] > ext[longest]) longest = a;
      // 权重从哪一端钉到哪一端:沿梯度轴,权重最小/最大处的坐标
      let lo = Infinity, hi = -Infinity, loC = 0, hiC = 0;
      for (let i = 0; i < n; i++) {
        const k = w.getX(i);
        const c = grad === 'x' ? pos.getX(i) : (grad === 'y' ? pos.getY(i) : pos.getZ(i));
        if (k < lo) { lo = k; loC = c; }
        if (k > hi) { hi = k; hiC = c; }
      }
      // 这条轴上权重跨了多少几何长度 = 权重真正扫过的"布长"
      const spanAll = ext[grad];
      rows.push({
        name: o.name,
        anim: o.userData.qm_anim,
        n,
        ext: [+ext.x.toFixed(3), +ext.y.toFixed(3), +ext.z.toFixed(3)],
        corr: [+cs.x.toFixed(4), +cs.y.toFixed(4), +cs.z.toFixed(4)],
        gradAxis: grad,
        longestAxis: longest,
        same: grad === longest,
        spanOnGradAxis: +spanAll.toFixed(3),
        pinnedAt: +loC.toFixed(3),
        freeAt: +hiC.toFixed(3),
        wRange: [+lo.toFixed(3), +hi.toFixed(3)],
      });
    });
    const authored = rows.filter((r) => r.name.indexOf('awning') < 0);
    return { rows, nAuthored: authored.length };
  })()`);

  const pad = (s, n) => String(s).padEnd(n);
  console.log('物体'.padEnd(24) + '轴 ext(x,y,z)'.padEnd(26) + 'corr(w,x/y/z)'.padEnd(26) +
    '梯度轴 / 最长轴'.padEnd(18) + '扫描长度');
  console.log('-'.repeat(112));
  for (const r of out.rows) {
    const mark = r.same ? ' ' : '⚠';
    console.log(
      `${mark}${pad(r.name, 23)} ${pad(r.ext.join(', '), 25)} ${pad(r.corr.join(', '), 25)} ` +
      `${pad(r.gradAxis + ' / ' + r.longestAxis, 17)} ${r.spanOnGradAxis}`,
    );
  }
  const bad = out.rows.filter((r) => !r.same);
  console.log(`\n共 ${out.rows.length} 件风动件;权重梯度轴与最长轴**不一致**的 ${bad.length} 件。`);
  for (const r of bad) {
    console.log(`  · ${r.name}:梯度沿 ${r.gradAxis}(扫描 ${r.spanOnGradAxis}m,` +
      `权重 ${r.wRange[0]}→${r.wRange[1]} 从 ${r.pinnedAt} 到 ${r.freeAt}),` +
      `而 ${r.longestAxis} 向长 ${r.ext['xyz'.indexOf(r.longestAxis)]}m`);
  }
  console.log('\n不一致 ≠ 一定错:只有当"最长的那条轴"确实是布的自由方向时才错。');
  console.log('要看的是**梯度轴是不是钉住端→自由端的那条轴**,得对着这件东西的构造读。');
} finally {
  await close();
}
