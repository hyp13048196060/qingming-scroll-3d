#!/usr/bin/env node
/**
 * uAlpha → 画面上的 Δ,到底是线性还是亚线性?
 *
 * ── 起因:一次**没有分辨力**的复量 ──────────────────────────────────────
 * SMOKE_ALPHA 从 0.26 改到 0.40 时,代码里写下过一条预期:
 *   "单团峰值约 33,叠加处约 60~80,平均约 13~16"。改完复量,桥机位实测
 *   平均 9.05~11.67 —— 低于预期。到这一步,"预期没中"是清楚的。
 *
 * 但**不能**就此断言"Δ 与 alpha 不是线性关系",因为同一批 0.40 的六个时刻,
 * 平均自己就在 9.05~11.67 之间晃(29% 的幅度),而 0.26→0.40 想测的变化
 * 是 ×1.18。**要测的东西比量具自身的抖动还小。**
 * 而且两次复量是**两次构建、两批时刻**(t 不同),烟团位置根本不一样,
 * 它们的像素集合既不重合也不嵌套 —— 拿两组不同的像素集去比"均值涨了多少",
 * 比的是 alpha 和时刻这两件事的**混合**,分不开。
 *
 * ── 换个测法:同一个冻结时刻内改 alpha ──────────────────────────────────
 * `uAlpha` 是烟材质上**活的 uniform**(`smokeMat.uniforms.uAlpha`),不需要
 * 重建、不需要重载材质。于是在一个冻结时刻里:
 *   先关烟拍一张基准 → 开烟,逐个 alpha 各拍一张 → 各自与**同一张基准**比
 * 烟的位置、鸟的位置、相机、时间全都没动,两次之间唯一的差别就是 alpha。
 * 这才是"归因由构造决定",而不是靠两次运行的统计量去推。
 *
 * 一个时刻给一条 alpha→Δ 曲线,六个时刻给六条。**如果六条曲线彼此接近**,
 * 说明曲线是系统性质;如果六条散得很开,说明它主要是时刻的性质,任何
 * 关于"alpha 的作用"的结论都还得再收窄。
 *
 * ── 读到的 Δ 是**输出**上的,不是线性光 ──────────────────────────────────
 * 读像素读的是 8bit sRGB、且已经过 AgX 色调映射。对**线性的乘法**变化,
 * 输出 Δ 本来就会小于线性(AgX 在亮部压缩,而烟的背景多是亮天空);
 * 加上多团叠加本身就是 1−∏(1−a) 的形式,也小于线性。
 * 所以"亚线性"是预期之内 —— 这支探针要量的不是"是不是亚线性",
 * 而是**有多亚**(log-log 斜率),以及这个斜率稳不稳。
 *
 * 用法: node tools/perf/once/smoke_alpha.mjs [URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?spot=bridge&q=high&hud=0';
/** 采样时刻数。每个时刻:一组基准 + 每个 alpha 各一张,全部在同一冻结时刻内。 */
const INSTANTS = 6;
/** 要扫的 alpha。0.26 与 0.40 是这次改动的两端,其余用来定斜率。 */
const ALPHAS = [0.20, 0.26, 0.33, 0.40, 0.50];

const { page, close, browserVersion } = await launch({ width: 1280, height: 720 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(6000);
  await page.evaluate(`(() => { window.__QM__.loop.stop(window.__QM__.renderer); return true; })()`);
  await sleep(200);

  // ⚠️ 名字有两套,别混:`FxSmoke` 是**对象**名,`fx_smoke` 是**材质**名
  //    (见 ParticleFx 里的 `smoke.name = 'FxSmoke'` 与材质参数里的 `name`)。
  //    第一版按 `o.name === 'fx_smoke'` 找,当然找不到;而找不到的后果被我
  //    写成了 `return false`,调用方**没看返回值** —— 于是失败一路静默到
  //    几十行之后,才以一个"Cannot read properties of undefined"的形式炸出来,
  //    离真正的原因隔了一层。所以这里改成直接抛,并且把两套名字都写进错误里。
  await page.evaluate(`(() => {
    const qm = window.__QM__;
    const gl = qm.renderer.getContext();
    let smoke = null;
    qm.scene.traverse((o) => {
      if (o.material && o.material.name === 'fx_smoke') smoke = o;
    });
    if (!smoke) {
      const names = [];
      qm.scene.traverse((o) => { if (o.name) names.push(o.name); });
      throw new Error('找不到烟材质(fx_smoke)。场景里的名字有:' + names.slice(0, 40).join(', '));
    }
    if (!(smoke.material.uniforms && smoke.material.uniforms.uAlpha)) {
      throw new Error('找到了 ' + smoke.name + ',但它没有 uAlpha uniform');
    }
    window.__SA__ = {
      w: gl.drawingBufferWidth, h: gl.drawingBufferHeight,
      alpha0: smoke.material.uniforms.uAlpha.value,
      S: {},
      setAlpha(a) { smoke.material.uniforms.uAlpha.value = a; return a; },
      sample(name) {
        qm.renderer.info.reset();
        qm.renderer.render(qm.scene, qm.camera);
        const buf = new Uint8Array(this.w * this.h * 4);
        gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        this.S[name] = buf;
        return true;
      },
      clear() { this.S = {}; return true; },
      // 与**同一张基准**比:每次比较都取自己那对缓冲,峰值按同一对算。
      cmp(base) {
        const A = this.S.off, B = this.S[base];
        let changed = 0, maxD = 0, sum = 0;
        for (let i = 0; i < A.length; i += 4) {
          const m = Math.max(Math.abs(A[i]-B[i]), Math.abs(A[i+1]-B[i+1]), Math.abs(A[i+2]-B[i+2]));
          if (m > 0) { changed++; sum += m; }
          if (m > maxD) maxD = m;
        }
        return { changed, maxD, meanD: changed ? sum / changed : 0 };
      },
      /**
       * 固定像素集上的统计。
       *
       * ⚠️ 为什么不能直接用"变了多少像素"上的统计量去比两个 α:
       *    α 越大,越多**边缘像素**的 Δ 越过 8bit 的量化地板(1/255),
       *    于是"变化的像素集"本身随 α 变大,而新进来的这些像素 Δ 最小。
       *    集合在动,均值就同时受两件事影响,分不开。
       *    所以这里把集合**钉住**:统计只在 mask 上做,而 mask 由基准帧
       *    (关烟)和"任意 α 下变过的像素的并集"定义 —— 它不含 α,
       *    是整个扫描共用的一把尺子。
       *    没变的像素按 0 计入,于是 meanFixed 是"在这块固定区域上的
       *    平均改动量",这正好是观感上该看的那个量。
       *
       * 同时按**基准帧的亮度**分桶:烟压暗的是它背后的东西,而 AgX 色调映射
       * 在亮部压缩得更狠。若亚线性主要来自色调映射,那么"压在亮背景上"那一桶
       * 的斜率应当**低于**"压在暗背景上"那一桶 —— 且这个差异是在**同一时刻、
       * 同一批烟团**内测出来的,不含时刻与几何的干扰。
       */
      stats(base, mask) {
        const A = this.S.off, B = this.S[base];
        const out = { n: 0, maxD: 0, sum: 0, bright: { n: 0, maxD: 0, sum: 0 }, dark: { n: 0, maxD: 0, sum: 0 } };
        for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
          if (!mask[p]) continue;
          const m = Math.max(Math.abs(A[i]-B[i]), Math.abs(A[i+1]-B[i+1]), Math.abs(A[i+2]-B[i+2]));
          const luma = 0.299 * A[i] + 0.587 * A[i+1] + 0.114 * A[i+2];
          const b = luma >= 150 ? out.bright : out.dark;
          out.n++; out.sum += m; if (m > out.maxD) out.maxD = m;
          b.n++; b.sum += m; if (m > b.maxD) b.maxD = m;
        }
        out.meanFixed = out.n ? out.sum / out.n : 0;
        for (const b of [out.bright, out.dark]) b.meanFixed = b.n ? b.sum / b.n : 0;
        return out;
      },
      /**
       * 掩膜里有多少像素是"贴着 8bit 量化地板"的(Δ ≤ 2)。
       *
       * 为什么要这个数:整幅读数都是 8bit 整数,而烟的边缘像素真实 Δ 可以远小于 1。
       * 一个真实 Δ 在 0.4~1.4 之间摆的像素,量化后就是 0 或 1 —— 它对均值的贡献
       * 在"0 与 1"之间跳,而不是跟着 α 平滑地走。**这类像素占比越高,量到的斜率
       * 越会被压平**,而且压平的方向是"看起来更亚线性"。
       * 所以两个机位的斜率若不同,先看这个占比是否也不同:
       * 占比差得多 ⇒ 差异可能只是量化,不是场景性质。
       */
      lowFrac(base, mask) {
        const A = this.S.off, B = this.S[base];
        let n = 0, low = 0;
        for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
          if (!mask[p]) continue;
          n++;
          const m = Math.max(Math.abs(A[i]-B[i]), Math.abs(A[i+1]-B[i+1]), Math.abs(A[i+2]-B[i+2]));
          if (m <= 2) low++;
        }
        return { n, low, frac: n ? low / n : 0 };
      },
      /** 并集掩膜:任一 α 下变过的像素。不含 α,是整场扫描共用的尺子。 */
      maskUnion(alphas) {
        const w = this.w, h = this.h, A = this.S.off;
        const mask = new Uint8Array(w * h);
        for (const a of alphas) {
          const B = this.S['a' + a];
          for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
            if (mask[p]) continue;
            const m = Math.max(Math.abs(A[i]-B[i]), Math.abs(A[i+1]-B[i+1]), Math.abs(A[i+2]-B[i+2]));
            if (m > 0) mask[p] = 1;
          }
        }
        return mask;
      },
    };
    return true;
  })()`);

  /** 在一个冻结时刻内扫完所有 alpha;返回该时刻的读数。 */
  const scanInstant = async () => {
    // 次序不能换:先清空本时刻的缓冲,**再**关烟拍基准,**最后**才开烟扫 alpha。
    // ⚠️ 第一版把 `clear()` 放在了"开烟之后、拍基准之前",于是拍出来的
    //    'off' 其实是一张**开着烟**的图(alpha 还是构建值)—— 基准错了,
    //    后面每一行 Δ 都会把"烟本身"算进去。这类错的可怕之处在于它不报错,
    //    只是所有数字都偏大一点,而偏大是"看起来更有效果"的方向。
    await page.evaluate(`(() => { window.__SA__.clear(); return true; })()`);
    await page.evaluate(`window.__QM__.setFxOverride(0, 'smoke')`);
    await page.evaluate(`window.__SA__.sample('off')`);
    await page.evaluate(`window.__SA__.sample('off2')`);
    await page.evaluate(`window.__QM__.setFxOverride(1, 'smoke')`);
    for (const a of ALPHAS) {
      await page.evaluate(`window.__SA__.setAlpha(${a})`);
      await page.evaluate(`window.__SA__.sample('a${a}')`);
    }
    // 收尾:alpha 还原成构建时的值,免得影响后面的时刻。
    await page.evaluate(`(() => { window.__SA__.setAlpha(window.__SA__.alpha0); return true; })()`);
    return page.evaluate(`(() => {
      const SA = window.__SA__;
      const frozen = SA.cmp('off2');
      const alphas = ${JSON.stringify(ALPHAS)};
      // 并集掩膜在**本时刻内**算,不含 α,后面五种 α 共用它。
      const mask = SA.maskUnion(alphas);
      return {
        frozen,
        alpha0: SA.alpha0,
        rows: alphas.map((a) => Object.assign({ a }, SA.cmp('a' + a))),
        fixed: alphas.map((a) => Object.assign({ a }, SA.stats('a' + a, mask))),
        // 贴地板的像素占比,按每个 α 各报一次 —— 它自己也随 α 变。
        lowFrac: alphas.map((a) => Object.assign({ a }, SA.lowFrac('a' + a, mask))),
      };
    })()`);
  };

  const instants = [];
  for (let i = 0; i < INSTANTS; i++) {
    const t = await page.evaluate(`+window.__QM__.loop.time.toFixed(2)`);
    instants.push(Object.assign({ t }, await scanInstant()));
    if (i < INSTANTS - 1) {
      await page.evaluate(`window.__QM__.loop.start(window.__QM__.renderer)`);
      await sleep(1300);
      await page.evaluate(`(() => { window.__QM__.loop.stop(window.__QM__.renderer); return true; })()`);
      await sleep(150);
    }
  }
  // 复原:循环重新跑起来。
  await page.evaluate(`window.__QM__.loop.start(window.__QM__.renderer)`);

  const f2 = (n) => n.toFixed(2);
  console.log(`浏览器 ${browserVersion}`);
  console.log(`URL      ${URL}`);
  console.log(`时刻数   ${INSTANTS}   alpha 扫描 ${ALPHAS.join(' / ')}`);
  console.log(`构建时 uAlpha = ${instants[0].alpha0}`);
  console.log('');
  console.log('── ① 逐时刻(每个时刻内:关烟两次作基准 + 各 alpha 各一张,全程同一冻结时刻)──');
  for (let i = 0; i < instants.length; i++) {
    const r = instants[i];
    console.log(`  #${i + 1}  t=${r.t}s   基准自比 Δ${r.frozen.changed}${r.frozen.changed === 0 ? ' ✅' : ' ⚠️ 冻结没生效,本时刻作废'}`);
    for (const row of r.rows) {
      console.log(`       α=${String(row.a).padEnd(5)} px=${String(row.changed).padStart(5)}   峰值 ${String(row.maxD).padStart(3)}   均 ${row.meanD.toFixed(3).padStart(7)}`);
    }
  }
  console.log('');

  // ② 斜率:对每个时刻、每个读数,在 log-log 上最小二乘拟合 Δ = k·α^n。
  //    在同一时刻内 alpha 是唯一变量,所以这里的斜率不含"时刻"这份噪声。
  const fit = (rows, key) => {
    const xs = rows.map((r) => Math.log(r.a));
    const ys = rows.map((r) => Math.log(r[key]));
    if (ys.some((y) => !isFinite(y))) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    return num / den;
  };
  console.log('── ② log-log 斜率(在每个时刻内拟合,α 是唯一变量 ⇒ 不含时刻噪声)──');
  console.log('    #    t(s)   峰值斜率   平均斜率   像素数斜率');
  const slopes = { maxD: [], meanD: [], changed: [] };
  for (let i = 0; i < instants.length; i++) {
    const r = instants[i];
    if (r.frozen.changed !== 0) { console.log(`    ${i + 1}    ${String(r.t).padStart(6)}   (冻结没生效,略)`); continue; }
    const sMax = fit(r.rows, 'maxD'), sMean = fit(r.rows, 'meanD'), sCnt = fit(r.rows, 'changed');
    for (const [k, v] of [['maxD', sMax], ['meanD', sMean], ['changed', sCnt]]) if (v !== null) slopes[k].push(v);
    console.log(`    ${i + 1}    ${String(r.t).padStart(6)}   ${(sMax === null ? '—' : f2(sMax)).padStart(6)}     ${(sMean === null ? '—' : f2(sMean)).padStart(6)}     ${(sCnt === null ? '—' : f2(sCnt)).padStart(6)}`);
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const rng = (a) => `${Math.min(...a).toFixed(2)}~${Math.max(...a).toFixed(2)}`;
  console.log('');
  console.log(`  峰值斜率  ${rng(slopes.maxD)}  均值 ${f2(avg(slopes.maxD))}   (线性 = 1.00)`);
  console.log(`  平均斜率  ${rng(slopes.meanD)}  均值 ${f2(avg(slopes.meanD))}`);
  console.log(`  像素数斜率 ${rng(slopes.changed)}  均值 ${f2(avg(slopes.changed))}`);
  console.log('');
  const spread = (a) => Math.max(...a) - Math.min(...a);
  console.log('── ③ 六条曲线彼此一致吗(散得开 ⇒ 斜率主要不是 alpha 的性质)──');
  console.log(`  峰值斜率极差 ${f2(spread(slopes.maxD))}   平均斜率极差 ${f2(spread(slopes.meanD))}`);

  // ④ 直接回答当初那条预期:同一时刻内 0.26 与 0.40 各是多少。
  console.log('');
  console.log('── ④ 同一冻结时刻内,0.26 对比 0.40(当初的预期正是这两个数之间)──');
  console.log('    #    0.26 峰值/平均        0.40 峰值/平均        峰值比   平均比');
  const ratios = { maxD: [], meanD: [] };
  for (let i = 0; i < instants.length; i++) {
    const r = instants[i];
    if (r.frozen.changed !== 0) continue;
    const lo = r.rows.find((x) => x.a === 0.26), hi = r.rows.find((x) => x.a === 0.40);
    const rp = hi.maxD / lo.maxD, rm = hi.meanD / lo.meanD;
    ratios.maxD.push(rp); ratios.meanD.push(rm);
    console.log(`    ${i + 1}    ${String(lo.maxD).padStart(3)} / ${lo.meanD.toFixed(2).padStart(7)}      ` +
      `${String(hi.maxD).padStart(3)} / ${hi.meanD.toFixed(2).padStart(7)}      ×${f2(rp)}    ×${f2(rm)}`);
  }
  console.log('');
  console.log(`  峰值比 ${rng(ratios.maxD)} 均值 ${f2(avg(ratios.maxD))}   平均比 ${rng(ratios.meanD)} 均值 ${f2(avg(ratios.meanD))}`);
  console.log(`  若 Δ 与 alpha 成正比,两个比都应是 ${(0.40 / 0.26).toFixed(2)}(= 0.40/0.26)。`);

  // ⑤ 固定像素集 + 按背景亮度分桶。
  //    上面的 ② 用的是"变了的像素"这一集合,而它会随 α 长大(见页内 stats 的注释);
  //    这里把集合钉死,并按基准帧亮度分桶,用来判亚线性的成因。
  console.log('');
  console.log('── ⑤ 固定像素集上的斜率,并按**背景亮度**分桶 ──');
  console.log('   (集合 = 本时刻内任一 α 下变过的像素的并集,不含 α;分桶按关烟时该像素的亮度)');
  console.log('    #    t(s)  全桶斜率   亮背景(≥150)   暗背景(<150)   亮/暗桶像素数');
  const buckets = { all: [], bright: [], dark: [] };
  const cnt = [];
  for (let i = 0; i < instants.length; i++) {
    const r = instants[i];
    if (r.frozen.changed !== 0) continue;
    const f = r.fixed;
    const sAll = fit(f, 'meanFixed');
    const sB = fit(f.map((x) => ({ a: x.a, meanFixed: x.bright.meanFixed })), 'meanFixed');
    const sD = fit(f.map((x) => ({ a: x.a, meanFixed: x.dark.meanFixed })), 'meanFixed');
    if (sAll !== null) buckets.all.push(sAll);
    if (sB !== null) buckets.bright.push(sB);
    if (sD !== null) buckets.dark.push(sD);
    const mid = f[Math.floor(f.length / 2)];
    cnt.push([mid.bright.n, mid.dark.n]);
    console.log(`    ${i + 1}    ${String(r.t).padStart(6)}  ${(sAll === null ? '—' : f2(sAll)).padStart(7)}   ` +
      `${(sB === null ? '—' : f2(sB)).padStart(9)}      ${(sD === null ? '—' : f2(sD)).padStart(9)}      ${mid.bright.n} / ${mid.dark.n}`);
  }
  console.log('');
  // 贴 8bit 地板的像素占比。两个机位的斜率若要拿来互比,先看这一行是否也不同。
  console.log('');
  console.log('  贴地板的像素占比(Δ≤2,按 α 从 0.20 到 0.50):');
  for (let i = 0; i < instants.length; i++) {
    const r = instants[i];
    if (r.frozen.changed !== 0) continue;
    console.log(`    ${i + 1}    ` + r.lowFrac.map((x) => `${(x.frac * 100).toFixed(1)}%`).join('  →  '));
  }

  const avgOr = (a) => (a.length ? f2(avg(a)) : '—(空桶)');
  console.log(`  全桶 均值 ${f2(avg(buckets.all))}   亮背景 均值 ${avgOr(buckets.bright)}   暗背景 均值 ${avgOr(buckets.dark)}`);
  console.log('');
  console.log('  ⚠️ 一处**预期落空**,先记下来:写这段判据时,我以为"桥机位俯视,');
  console.log('     烟是压在亮天空上的"。实测**亮桶一个像素都没有**,全在暗桶。');
  console.log('     桥机位的地平线在第 34 行,而那个发射点投影在 (514,179) —— ');
  console.log('     在本初子午线之下几百行,是屋面和地面,不是天。');
  console.log('     也就是说那句话是我按"俯视图里天占三分之一"推的,没量过背景亮度。');
  console.log('     所以**这一条在桥机位无从判起**,要换一个亮暗两桶都有的机位。');
  console.log('');
  console.log('  判据(把两种成因分开的关键):');
  console.log('  · 多团叠加 1−∏(1−α) 的亚线性,**与背景亮度无关** —— 叠得越密越亚线性,');
  console.log('    而"密"在同一时刻内是个定值,分桶分不开它。');
  console.log('  · AgX 色调映射的压缩,**只取决于背景有多亮** —— 亮背景那桶应更亚线性。');
  console.log('  所以:亮桶斜率明显低于暗桶 ⇒ 色调映射是成因之一;两桶接近 ⇒ 不是它。');
  console.log('');
  // ② 与 ⑤ 的对比本身是个发现,值得单独点出来。
  const sVar = avg(slopes.meanD);
  console.log(`  ⚠️ 另一个更重要的对比:② 的"平均斜率"是 ${f2(sVar)}(集合随 α 长大),`);
  console.log(`     ⑤ 的"全桶斜率"是 ${f2(avg(buckets.all))}(集合钉死),**两者只差像素集固不固定**。`);
  console.log('     这一大截差距说明:② 那份亚线性里,**大部分来自集合在长大,');
  console.log('     不是像素本身的响应**。要谈"α 的效果",该看 ⑤ 不是 ②。');
} finally {
  await close();
}
