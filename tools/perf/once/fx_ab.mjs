#!/usr/bin/env node
/**
 * 炊烟与飞鸟到底画出来了没有、有多显眼、在画面哪儿 —— 只能"减掉它再比"。
 *
 * 起因:第一张 `fx_high_bridge.png` 里我只看到桥边一条极淡的烟、**一只鸟都没看到**。
 * 但"看不见"有三种完全不同的可能,静帧分辨不了:
 *   ① 根本没画(instanceCount=0,或者整块 mesh 没进视锥)
 *   ② 画了,但太淡 —— alpha/颜色/尺寸哪个都不够
 *   ③ 画了也确实够显眼,只是**不在这一帧的取景里**
 * ②③的修法完全相反:②要加浓,③要改机位或改航线。**照着截图猜一定会猜错一边。**
 *
 * ── 三张一组的判据 ────────────────────────────────────────────────────
 * 两张的差值非空,只能说明"这两次渲染不一样",**不能**说明差异来自粒子 ——
 * 也可能是我以为冻住了、其实没冻住(河岸上有 48 个在走的人)。于是拍三张:
 *   Z1 全关 → 渲一帧 → 读像素
 *   Z2 全关 → 再渲一帧 → 读像素   ← Z1 与 Z2 **必须逐像素相同**
 *   S  只开烟 / B  只开鸟         ← 各与 Z1 比
 * Z1≡Z2 是**冻结是否真的生效**的判据;Z1≠S、Z1≠B 才是粒子的证据。缺一不可。
 *
 * ── 为什么烟和鸟要分开开关 ─────────────────────────────────────────────
 * 两族一起开关的话,差值图里烟与鸟是**混在一起**的,而这两者的修法相反:
 * 烟不显眼要挪烟源或加浓,鸟不显眼要改航线。分开开关之后,"这块像素属于谁"
 * 是**构造上的事实**(这两帧之间只有这一族的 instanceCount 不同),不用猜。
 *
 * ⚠️ 第一版就是靠猜的,判据是"这块在**地平线以上**,所以是天空、所以是鸟"。
 *    它在船机位把三团烟(2184/484/113 像素)**全判成了鸟** —— 因为相机在
 *    2.9m 而屋面在 6.7~8.8m,**屋面上的烟一升起来就在地平线以上**。
 *    那个标注读起来像观测,其实是一句从没验过的假设,而且方向刚好是反的。
 *    凡是"用一个量去推断另一个量"的列,都要问一句:它们真的同向吗?
 *
 * ── 为什么要拍好几个时刻,不能只拍一个 ────────────────────────────────
 * ⚠️ 只拍一个冻结时刻时,这支探针报过"飞鸟**一个像素都没变** —— 不是太淡,
 *    是没画出来"。这句话是错的,而且错得理直气壮:同一支探针换个时刻再跑,
 *    鸟就出现在画面上了(46 px、峰值 Δ170、平均 Δ138)。
 *    **鸟在盘旋,它在不在取景里是时间的函数。** 一个冻结时刻 = 一次抽样,
 *    而我把一次抽样写成了关于整个系统的结论。
 *    现在每个时刻都拍一组,报的是"6 个时刻里有几个时刻看得到鸟",
 *    这个数才是"航线有没有铺进取景"的答案;单帧那套只能回答"此刻有没有"。
 *    这也是为什么下面那张最漂亮的差值图要**标明它取自哪个时刻** ——
 *    挑一张最好看的图是可以的,但**不能把挑出来的那一张当成常态**。
 *
 * ── 输出里的四样东西,各回答一个问题 ──────────────────────────────────
 *   冻结完整性(Z1 vs Z2)  —— 这个差值**能不能**用
 *   逐时刻表               —— 每个时刻各自看到了多少(含最差的那个时刻)
 *   分量计数(readings)     —— 差值是**谁**造成的(读数取自运行期,不是我的期望)
 *   发射点投影表           —— 烟**应该**在画面哪儿(不在表里 = 那个点没进视锥)
 *
 * 用法: node tools/perf/once/fx_ab.mjs [URL]
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?spot=bridge&q=high&hud=0';
const OUT = 'screenshots/perf';
/** 采样时刻数。每个时刻 = 一次冻结 + 一组三帧 + 让循环跑一会儿再冻下一次。 */
const INSTANTS = 6;

const { page, close, browserVersion } = await launch({ width: 1280, height: 720 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  // 让人走到画面中间、烟也确实升起来一段 —— 太早拍的话烟全在
  // `smoothstep(0,0.16,age)` 的淡入段,量到的是"刚点火"而不是"稳定态"。
  await sleep(6000);

  // 采样器与比较器都装在页面上,像素缓冲留在页面里 —— 1280×720×4 = 3.7MB,
  // 六个时刻全走 CDP 序列化传回来既慢又可能被截断。传回来的只有数字。
  await page.evaluate(`(() => {
    const qm = window.__QM__;
    const gl = qm.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;

    /** 行序统一:readPixels 自下而上,投影/肉眼/截图自上而下。
     *  ⚠️ 第一版把**两种行序的数直接放在一起比**:连通块的 y 来自 readPixels,
     *     地平线来自 project() 换算。当时那一条标注没触发,所以没人看出来。
     *     数值算错了会有人怀疑,**两个不同量纲的量摆在一张表里比大小**,
     *     谁都不会怀疑。这里在唯一的出口处翻一次。
     *  (这个注释里不能再出现反引号:整段是模板字符串,反引号会提前截断。)*/
    const toTop = (y) => h - 1 - y;

    /** 两个缓冲逐像素比。mask 是**二值**的:变 1 个色阶也算 ——
     *  第一版把差值放大 12 倍画成灰度图,结果 Δ=1 的像素在图上几乎全黑,
     *  我照着那张图读成"只有一团",而实际有 474 个像素在变。
     *  "放大到看得见"和"看得全"是两件事,仪器该先保证后者。 */
    const compare = (P, Q) => {
      let changed = 0, maxD = 0, sumD = 0;
      const mask = new Uint8Array(w * h);
      for (let i = 0, px = 0; px < w * h; px++, i += 4) {
        const m = Math.max(
          Math.abs(P[i] - Q[i]), Math.abs(P[i+1] - Q[i+1]), Math.abs(P[i+2] - Q[i+2]));
        if (m > 0) { mask[px] = 1; changed++; sumD += m; }
        if (m > maxD) maxD = m;
      }
      return { changed, maxD, meanD: changed ? +(sumD / changed).toFixed(3) : 0, mask };
    };

    /** 连通块(4 邻域)。像素数从大到小 —— "一大团"和"几十个小点"
     *  对下一步的指示完全不同,而总数分不出这两者。 */
    const components = (mask) => {
      const seen = new Uint8Array(w * h);
      const out = [];
      const stack = new Int32Array(w * h);
      for (let s = 0; s < w * h; s++) {
        if (!mask[s] || seen[s]) continue;
        let sp = 0; stack[sp++] = s; seen[s] = 1;
        let n = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
        while (sp) {
          const p = stack[--sp]; n++;
          const x = p % w, y = (p / w) | 0;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (x > 0   && mask[p-1] && !seen[p-1]) { seen[p-1] = 1; stack[sp++] = p-1; }
          if (x < w-1 && mask[p+1] && !seen[p+1]) { seen[p+1] = 1; stack[sp++] = p+1; }
          if (y > 0   && mask[p-w] && !seen[p-w]) { seen[p-w] = 1; stack[sp++] = p-w; }
          if (y < h-1 && mask[p+w] && !seen[p+w]) { seen[p+w] = 1; stack[sp++] = p+w; }
        }
        out.push({ n, x0, y0, x1, y1 });
      }
      return out.sort((a, b) => b.n - a.n);
    };

    /** 每个连通块的**峰值差**:一块 300 像素但峰值只有 2,和一块 30 像素峰值 60,
     *  后者才看得见。像素数分不出这个,所以逐块再扫一遍峰值。 */
    const peakOf = (c, P, Q) => {
      let pk = 0;
      for (let y = c.y0; y <= c.y1; y++) {
        for (let x = c.x0; x <= c.x1; x++) {
          const p = y * w + x;
          if (!(P[p*4] !== Q[p*4] || P[p*4+1] !== Q[p*4+1] || P[p*4+2] !== Q[p*4+2])) {
            // 掩膜里有、这一对却不差 —— 说明掩膜与缓冲对不上,不能让峰值静默为 0
            pk = Math.max(pk, -1);
            continue;
          }
          const i = p * 4;
          const m = Math.max(
            Math.abs(P[i] - Q[i]), Math.abs(P[i+1] - Q[i+1]), Math.abs(P[i+2] - Q[i+2]));
          if (m > pk) pk = m;
        }
      }
      return pk;
    };

    /** 一对缓冲 → 数值结果(不返回掩膜本身,缓冲留在页面里)。 */
    const analyze = (P, Q) => {
      const cmp = compare(P, Q);
      return {
        changed: cmp.changed, maxD: cmp.maxD, meanD: cmp.meanD,
        comps: components(cmp.mask).slice(0, 12).map((c) => ({
          n: c.n, peak: peakOf(c, P, Q),
          x0: c.x0, x1: c.x1, y0: toTop(c.y1), y1: toTop(c.y0),
        })),
      };
    };

    window.__FXAB__ = {
      w, h, S: {}, best: null, bestChanged: -1, bestT: null,
      /** 渲一帧并把**绘制缓冲**读进来(readPixels 原点在左下)。
       *  ⚠️ 走 readPixels 不走 Page.captureScreenshot:截图读的是**合成器**的
       *     输出,而 preserveDrawingBuffer 默认 false,合成之后绘制缓冲的内容
       *     规范上就是"未定义"。第一版走截图时,A1 与 A2 之间冒出 24 个 ±1 的
       *     像素 —— 它既可能被读成"冻结失效",也可能被读成"粒子太淡",
       *     两个结论都错,而且方向相反。 */
      sample(name) {
        qm.renderer.info.reset();
        qm.renderer.render(qm.scene, qm.camera);
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        this.S[name] = buf;
        return true;
      },
      analyze,
      /** 把当前这一组样本记为"至今鸟最多的一组",供最后出图用。 */
      keepIfBest(t, birdChanged) {
        if (birdChanged <= this.bestChanged) return false;
        this.bestChanged = birdChanged;
        this.bestT = t;
        // 只留引用:下一轮 sample() 会换成新数组,旧的不会被就地改写
        this.best = { Z1: this.S.Z1, S: this.S.S, B: this.S.B };
        return true;
      },
      time() { return qm.fxRuntime().time; },
      camPos() {
        const c = qm.camera.position;
        return [+c.x.toFixed(3), +c.y.toFixed(3), +c.z.toFixed(3)];
      },
    };
    return true;
  })()`);

  const instants = [];
  for (let k = 0; k < INSTANTS; k++) {
    if (k > 0) {
      // 让循环真的跑一会儿 —— 鸟的相位由 worldTime 推,时间不走就还是同一帧。
      await page.evaluate(`(() => { window.__QM__.loop.start(window.__QM__.renderer); return true; })()`);
      await sleep(1300);
    }
    // 冻结。此后除了我显式调用的 render(),没有任何一帧会自己发生。
    await page.evaluate(`(() => { window.__QM__.loop.stop(window.__QM__.renderer); return true; })()`);
    await sleep(150);

    const rec = await page.evaluate(`(() => {
      const F = window.__FXAB__, qm = window.__QM__;
      /** **每一帧都把两个覆盖位显式写一遍**,不靠上一步留下的值。
       *  ⚠️ 第一版只写要开的那一族(只写 birds),烟那一格于是**沿用**了上一步的 1 ——
       *     "只开鸟"那一帧其实烟也开着,两张差值表因此几乎一模一样。
       *     后果不是报错,而是**两张表都看着挺有内容**。只有逐行对齐看才会发现
       *     它们说的是同一件事。"只改一件事"的开关用在 A/B 上时,
       *     **没被改的那件事必须被显式钉住**。 */
      const set = (s, b) => { qm.setFxOverride(s, 'smoke'); return qm.setFxOverride(b, 'birds'); };
      const t = F.time();
      const camAt = F.camPos();

      const off = set(0, 0);
      F.sample('Z1'); F.sample('Z2');
      const sm = set(1, 0); F.sample('S');
      const bd = set(0, 1); F.sample('B');

      const frozen = F.analyze(F.S.Z1, F.S.Z2);
      const smoke = F.analyze(F.S.Z1, F.S.S);
      const birds = F.analyze(F.S.Z1, F.S.B);
      F.keepIfBest(t, birds.changed);

      return {
        t: +t.toFixed(2), camAt,
        readings: { off: [off.puffs, off.birds], smoke: [sm.puffs, sm.birds], birds: [bd.puffs, bd.birds] },
        frozen: { changed: frozen.changed, maxD: frozen.maxD },
        smoke: { changed: smoke.changed, maxD: smoke.maxD, meanD: smoke.meanD },
        birds: { changed: birds.changed, maxD: birds.maxD, meanD: birds.meanD,
                 peak: birds.comps.length ? birds.comps[0].peak : 0 },
        warnings: sm.warnings,
      };
    })()`);
    instants.push(rec);
  }

  // 恢复成全开,免得探针跑完留下一个半开的场景
  await page.evaluate(`(() => { window.__QM__.setFxOverride(1, 'smoke');
    window.__QM__.setFxOverride(1, 'birds'); return true; })()`);

  // 发射点投影与两个 mesh 的自述,都在最后一个时刻的状态下读。
  const tail = await page.evaluate(`(() => {
    const F = window.__FXAB__, qm = window.__QM__;
    const THREE = qm.THREE, cam = qm.camera;
    cam.updateMatrixWorld();
    const w = F.w, h = F.h;
    const toScreen = (v) => {
      const p = v.clone().project(cam);
      return { x: Math.round((p.x * 0.5 + 0.5) * w),
               y: Math.round((-p.y * 0.5 + 0.5) * h),
               inFront: p.z < 1 };
    };
    const horizon = (() => {
      const f = new THREE.Vector3();
      cam.getWorldDirection(f);
      f.y = 0; f.normalize();
      return toScreen(cam.position.clone().addScaledVector(f, 100000)).y;
    })();
    const emitters = qm.fxRuntime().emitters.map((e) => {
      const s = toScreen(new THREE.Vector3(e.at[0], e.at[1], e.at[2]));
      return { from: e.from, at: e.at, sx: s.x, sy: s.y,
               onScreen: s.inFront && s.x >= 0 && s.x < w && s.y >= 0 && s.y < h };
    });
    return { horizon, emitters, warnings: qm.fxRuntime().warnings,
             bestT: F.bestT, bestChanged: F.bestChanged };
  })()`);

  // ── 出图:只出"鸟最多的那个时刻"的那一组,并且**标明是哪个时刻** ──
  await mkdir(OUT, { recursive: true });
  const pngOf = (name) => page.evaluate(`(async () => {
    const F = window.__FXAB__, w = F.w, h = F.h;
    const src = F.best ? F.best['${name}'] : F.S['${name}'];
    const cv = new OffscreenCanvas(w, h);
    const cx = cv.getContext('2d');
    const im = cx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      // ⚠️ 行序要翻。readPixels 自下而上,而 putImageData 把第 0 行当**最上面** ——
      //    第一版没翻,存出来的差图是**上下颠倒**的。一张颠倒的差图叠在一张正的
      //    原帧上比对着看,是"读出完全相反结论"的绝佳配方,看的人不会有异样感。
      const s = (h - 1 - y) * w * 4;
      im.data.set(src.subarray(s, s + w * 4), y * w * 4);
    }
    cx.putImageData(im, 0, 0);
    const bl = await cv.convertToBlob({ type: 'image/png' });
    const u8 = new Uint8Array(await bl.arrayBuffer());
    let str = '';
    for (let i = 0; i < u8.length; i += 8192) str += String.fromCharCode.apply(null, u8.subarray(i, i+8192));
    return btoa(str);
  })()`);
  for (const n of ['Z1', 'S', 'B']) {
    const b64 = await pngOf(n);
    await writeFile(`${OUT}/fx_ab_${n === 'Z1' ? 'base_off' : n === 'S' ? 'smoke_only' : 'birds_only'}.png`,
      Buffer.from(b64, 'base64'));
  }

  // ── 报告 ──
  const anyFrozenBad = instants.some((r) => r.frozen.changed > 0);
  console.log(`浏览器 ${browserVersion}`);
  console.log(`URL      ${URL}`);
  console.log(`时刻数   ${INSTANTS}   地平线在第 ${tail.horizon} 行(仅表示天占多少,不用来推断像素归属)`);
  console.log('');
  console.log('── ① 逐时刻(每个时刻都重新冻结一次;t 是冻结时的 worldTime)──');
  console.log('    #    t(s)   相机位置                  读数(关/烟/鸟)      冻结Δ  ' +
    '炊烟 px(峰值/平均)        飞鸟 px(峰值/平均)');
  for (let i = 0; i < instants.length; i++) {
    const r = instants[i];
    const rd = r.readings;
    console.log(
      `    ${String(i + 1).padStart(2)}  ${String(r.t).padStart(6)}  ${r.camAt.join(', ').padEnd(24)}  ` +
      `${rd.off.join('/')} → ${rd.smoke.join('/')} → ${rd.birds.join('/')}  `.padEnd(22) +
      `${String(r.frozen.changed).padStart(5)}  ` +
      `${String(r.smoke.changed).padStart(5)} (${String(r.smoke.maxD).padStart(3)}/${String(r.smoke.meanD).padStart(6)})`.padEnd(24) +
      `${String(r.birds.changed).padStart(5)} (${String(r.birds.peak).padStart(3)}/${String(r.birds.meanD).padStart(6)})`);
  }
  console.log('');
  const withBirds = instants.filter((r) => r.birds.changed > 0).length;
  const withSmoke = instants.filter((r) => r.smoke.changed > 0).length;
  console.log(`  炊烟:${withSmoke}/${INSTANTS} 个时刻看到(像素数 ${Math.min(...instants.map((r) => r.smoke.changed))}~` +
    `${Math.max(...instants.map((r) => r.smoke.changed))})`);
  console.log(`  飞鸟:${withBirds}/${INSTANTS} 个时刻看到(像素数 ${Math.min(...instants.map((r) => r.birds.changed))}~` +
    `${Math.max(...instants.map((r) => r.birds.changed))})`);
  console.log(anyFrozenBad
    ? '  ⚠️ 有时刻的冻结没生效(冻结Δ > 0),那个时刻的差值不能读'
    : '  ✅ 所有时刻的 Z1 与 Z2 都逐像素相同 —— 上面的差值可用');
  // 三帧的隔离是否真的成立:判据不能只是"打印出来了",得是一条会红的断言。
  const isolateBad = instants.filter((r) => {
    const [o, s, b] = [r.readings.off, r.readings.smoke, r.readings.birds];
    return !(o[0] === 0 && o[1] === 0 && s[0] > 0 && s[1] === 0 && b[0] === 0 && b[1] > 0);
  }).length;
  console.log(isolateBad === 0
    ? '  ✅ 每个时刻都确实是"全关 / 只有烟 / 只有鸟" —— 两张差值表各说各的'
    : `  ❌ ${isolateBad} 个时刻两族没分开 —— 那些时刻的差值归属不成立`);
  console.log('');
  console.log('── ② 发射点投影(烟应该出现在哪)──');
  for (const e of tail.emitters) {
    console.log(`  ${e.from.padEnd(26)} 世界(${e.at.map((n) => n.toFixed(1)).join(', ')})  ` +
      `屏幕(${String(e.sx).padStart(5)}, ${String(e.sy).padStart(4)})  ` +
      (e.onScreen ? '在画面内' : '★不在画面内'));
  }
  const onCount = tail.emitters.filter((e) => e.onScreen).length;
  console.log(`  ${onCount}/${tail.emitters.length} 个发射点在画面内`);
  console.log(`  warnings ${JSON.stringify(tail.warnings)}`);
  console.log('');
  console.log(`  差值图取自**鸟最多的那个时刻**(t=${tail.bestT}s,${tail.bestChanged} px):`);
  console.log(`    ${OUT}/fx_ab_base_off.png / fx_ab_smoke_only.png / fx_ab_birds_only.png`);
  console.log(`  ⚠️ 这一组是 6 个时刻里挑出来的**最好**的一次,不代表常态 —— 常态见上表。`);
  if (!anyFrozenBad && isolateBad === 0) {
    console.log('');
    // ⚠️ 这里**只报观测到的**,不写结论。曾经有一版在单帧上直接印
    //    "不是太淡,是没画出来" —— 那句话把一个**时刻**的读数说成了整个系统的
    //    性质,而它其实是错的(换一版再跑就有了)。要判"是不是没铺进取景",
    //    得看 `fx_coverage.mjs` 的投影覆盖率,不是看这里的像素数。
    console.log(withBirds === 0 || withSmoke === 0
      ? `❌ ${withBirds === 0 ? '鸟' : '烟'}在 ${INSTANTS} 个时刻里一次都没出现 —— ` +
        `下一步用 fx_coverage.mjs 量投影覆盖率,别在这里下结论`
      : `差值存在。注意"几个时刻看得到"是**时间上的比例**,与像素数不是一回事。`);
  }
} finally {
  await close();
}
