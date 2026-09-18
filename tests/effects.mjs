#!/usr/bin/env node
/**
 * 炊烟与飞鸟的**外部**检查 —— 阶段 4 的收口项。
 *
 * 为什么非要有一个"外部"检查
 * --------------------------
 * `ParticleFx.ts` 里有一个 `checkEmitters()`,它断言"发烟点落在那件东西的
 * 水平范围内、且不低于它的顶面"。那两条断言是**自证**的:发烟点本来就是
 * 拿那件东西的包围盒算出来的(水平取盒中心、高度取 `max.y`),**不可能不过**。
 * 它防的是"将来有人改了 origin 的算式",防不了"烟到底画没画在屋顶上"。
 *
 * 所以这里换一把**不共享前提**的尺子:**渲染出来的像素**。
 * 模型说烟该在哪儿 → 投影到屏幕 → 去那张"开烟减关烟"的差值图里找像素。
 * 半空中没有像素,就说明烟没冒在模型上说的地方。这两条链路唯一的共同点是
 * 相机矩阵,而相机矩阵错了整个画面都错,一眼能看出来。
 *
 * 判据
 * ----
 *   A 前置    页面就绪 / 真 GPU / 基线画面非空白(否则后面的差值全是空的)
 *   B 冻结    关烟连拍两张必须逐像素相同 —— 差值可用的前提
 *   C 归因    关/烟/鸟三态,且**两族分别开关**(烟那帧不许有鸟,鸟那帧不许有烟)
 *   D 落点    ★ 核心:每个**包络大部分落在画面内**的发烟点,其包络里必须有
 *             变化像素;包络为空的要做一次**对照渲染**分清"被挡住"还是
 *             "没画";不在画面内的、包络小到读不出的、大部分在画面外的、
 *             被遮挡的,**逐条列出**,不算通过也不算失败;外加一条**阴性对照**
 *   E 关掉    全关之后画面上不再有任何变化像素 —— 证明这套开关真的能关干净
 *
 * ⚠️ 五条判据为什么长这样
 * ----------------------
 * ① **包络不是抄来的常数,是从正在画的实例数据里量出来的。**
 *    `fx_coverage.mjs` 的头部已经吃过一次这个教训:探针里抄一份
 *    `PUFF_RISE` / 风漂上限,将来 `ParticleFx.ts` 一改,探针不会报错,
 *    只会拿旧航线算出一个"明明在画面里"的结论。所以这里改为直接读
 *    那个网格上的 `aOrigin` / `aPuff` / `aDrift`(它们的含义见
 *    `smokeGeometry()`:`aPuff = [birth, life, r0, rise]`、
 *    `aDrift = [swayPhase, swayAmp, drift]`),对**每一个实例**算出
 *      · 竖直封顶 `rise = aPuff.w`(着色器里 `ease` 单调升到 1)
 *      · 横向封顶 `aDrift.z * aPuff.y`(着色器里位移是 `drift*age*life`)
 *      · 精灵自身半宽 `aPuff.z * 2.45`(着色器里半径最大 `r0*(0.55+1.9)`)
 *    再按 `aOrigin` 把实例归属到各个烟源上,取每个烟源自己的最大值。
 *    这样包络跟着代码走,**不跟着注释走**。
 *
 *    归属用的是**最近烟源 + 1e-3 米阈值**,对不上就计入 `unmatched`
 *    并让断言失败。理由是:如果实例与烟源对不上,说明这个假设已经错了,
 *    这时候悄悄算到"最近的那个"头上,量出来的包络会是一份看着正常的错数据。
 *
 * ② **包络是整段轨迹,不是"烟该在的那一点"。** 所以这条判据能抓
 *    "烟没画 / 画在别处 / 冒在半空",**抓不了**"烟斜得不够好看" ——
 *    那是观感,不是这条判据的事,别让它越权。
 *
 * ③ **不在画面内、以及包络小于 `MIN_BAND_PX` 的烟源,必须逐条打印。**
 *    虹桥机位 8 处烟源只有 1 处入画,城门机位 0 处 —— 这是"相机在看哪儿"
 *    的结果,不是缺陷。但如果不打印,报告里"8 处烟源,0 处失败"读起来
 *    就像"8 处都验过了"。**把没验的当成验过的,是这个项目里最贵的错。**
 *
 * ④ **E 段"关干净"不能只看 `runtime().puffs === 0`** —— 那是**读数**,
 *    不是画面。读数为 0 而画面上还有像素,在"instanceCount 归零了但整块
 *    mesh 没隐藏"时真的会出现。所以这里比的是**像素**。
 *
 * ⑤ **"投影点在画面内"不等于"包络在画面内",更不等于"看得见"。**
 *    这条是两次返工换来的,两次都先是**我自己判错**,才轮到场景。
 *
 *    第一次:第一版只判投影点在不在画面里。虹桥机位因此报了 2 处失败 ——
 *    可其中 `boat_ke_a_cover` 在船机位明明画出了 2100 px。同一处烟源
 *    换个机位就有烟,成因只可能在"看不看得见",不在"画没画"。
 *    当时的假设是**遮挡**(烟材质 `depthTest: true`),于是加了一次
 *    对照渲染:关掉烟的 `depthTest` 再渲一帧。
 *      · 包络里出现像素 → 烟在那儿,只是被挡 → **未验**,不是失败
 *      · 仍然没有       → 烟真的没画到那儿     → **失败**
 *    之所以用渲染对照而不是 `Raycaster`:后者要在没有 BVH 的场景上打
 *    几十次全场景射线,慢,而且它回答的是"这个点可不可见",不是
 *    "烟到底画没画"—— 而后者才是这份检查要问的。
 *
 *    第二次:**那个假设被对照渲染否掉了** —— 关掉 `depthTest` 之后
 *    仍然一个像素都没有。真正的原因是**包络被视口切掉了**:
 *
 *    ⚠️ 所以下面那条"被遮挡"分支至今**一次都没进过**(两个机位都是 0 处)。
 *       但**不要据此把它当死代码删掉**:它的价值不在报警,在于**能证伪** ——
 *       正是它给出 0,才把"遮挡"这条解释正式排除,而不是停在一个听起来
 *       合理的猜测上。一个只会点头的对照没有用,这个会摇头。
 *
 *      `shop_e1_1_roof` 的包络是 754x189,只有 2% 落在画面内;
 *      `boat_ke_a_cover` 是 746x202,只有 11% 落在画面内。
 *    我一直只在**剩下那条缝**里找像素,而烟待的地方在框外 ——
 *    "缝里没有像素"因此什么也证明不了。第三处 `shop_w1_1_roof` 的
 *    包络 100% 在画面内,它一次就找到了 587 px。
 *    所以判据改成先算**包络落在视口内的面积占比**,低于 0.6 的记"未验"。
 *
 *    ⚠️ 这两次留下的教训不是"要检查遮挡",而是:**报"失败"之前,
 *       先确认这件东西在这个机位上是**该被看见**的。**
 *       两次假失败都出自同一个疏漏 —— 默认"在取景框里 = 看得见"。
 *       这个机位一共 8 处烟源,其中 6 处属于"没验到",
 *       真正验到的只有 1 处。报告必须把这 6 处逐条列出来,
 *       否则"0 处失败"读起来就像"8 处都验过了"。
 *
 * ⚠️ 这份检查**不产出**"变化像素的平均 Δ"。原因不是懒得写:
 *    `smoke_alpha.mjs` 已经量过,"变化像素上的均值"这个统计量的**样本集
 *    本身随被测变量增长**(α 越大,越过 8bit 量化地板的像素越多),
 *    在同一个包络里测出的斜率会从 0.96 掉到 0.72。一个带着已知混淆的
 *    统计量,不该再被引进一把新的尺子里。
 *
 * 用法:
 *   node tests/effects.mjs                 # 默认跑 boat 与 bridge 两个机位
 *   node tests/effects.mjs --url http://127.0.0.1:4173/?spot=boat&q=high&hud=0
 */
import { writeFileSync } from 'node:fs';
import { launch, sleep } from '../tools/perf/lib/cdp.mjs';

const DEFAULT_SPOTS = ['boat', 'bridge'];
const BASE = process.env.QM_BASE || 'http://127.0.0.1:4173';

const argUrl = (() => {
  const i = process.argv.indexOf('--url');
  return i >= 0 ? process.argv[i + 1] : null;
})();

/**
 * 包络在屏幕上小于这个尺寸就**判读不了**(升烟在屏幕上总共就那么几个像素,
 * 找得到找不到都不说明问题)。这类烟源计入"未验",不算通过也不算失败。
 */
const MIN_BAND_PX = 4;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
};

const { page, close, browserVersion } = await launch({ width: 1280, height: 720 });
console.log(`浏览器 ${browserVersion}`);
let gpuChecked = false;
try {
  for (const spot of (argUrl ? [null] : DEFAULT_SPOTS)) {
    const url = argUrl || `${BASE}/?spot=${spot}&q=high&hud=0`;
    console.log(`\n──── ${argUrl ? url : `机位 ${spot}`} ────`);
    await page.goto(url);
    await page.waitForReady({ timeout: 120000 });
    // GPU 必须在**导航之后**读:第一版把这段放在 launch 之后、goto 之前,
    // 那时页面还是 about:blank,`__QM__` 根本不存在,读回一个 null,
    // 报告上长得就像"显卡没被用上"。仪器读数不对时先怀疑仪器,这一条算第 38 次。
    if (!gpuChecked) {
      gpuChecked = true;
      const gpu = await page.evaluate(`(() => {
        const g = window.__QM__ && window.__QM__.gpu;
        return g ? g.renderer : null;
      })()`);
      console.log(`GPU     ${gpu}`);
      record('A1 取到真实 GPU(ANGLE + 厂商)',
        typeof gpu === 'string' && /ANGLE/.test(gpu) && /NVIDIA|AMD|Intel/i.test(gpu),
        String(gpu));
    }
    await sleep(6000);
    await page.evaluate(`(() => { window.__QM__.loop.stop(window.__QM__.renderer); return true; })()`);
    await sleep(200);

    // 页内采样器。比较全在页内做,只把标量带回来。
    const ready = await page.evaluate(`(() => {
      const qm = window.__QM__;
      const THREE = qm.THREE;
      const gl = qm.renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      window.__EF__ = {
        w: w, h: h, S: {},
        sample: function (name) {
          qm.renderer.info.reset();
          qm.renderer.render(qm.scene, qm.camera);
          const buf = new Uint8Array(this.w * this.h * 4);
          gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          this.S[name] = buf;
          return true;
        },
        diff: function (a, b) {
          const A = this.S[a], B = this.S[b];
          let changed = 0, maxD = 0;
          // 差异像素的**包围盒**。只报一个数字的话,"296 个像素不一样"
          // 没法判断它是烟没散、是水面在动、还是某张贴图第一帧还没生成 ——
          // 而这三者的修法完全不同。盒子能把它指到画面上的一个位置。
          let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
          const sample = [];
          const deltas = {};
          for (let i = 0; i < A.length; i += 4) {
            const m = Math.max(Math.abs(A[i]-B[i]), Math.abs(A[i+1]-B[i+1]), Math.abs(A[i+2]-B[i+2]));
            if (m > 0) {
              changed++;
              const px = (i >> 2) % this.w;
              // readPixels 是**底向上**的,这里翻成顶向下,与 project 一致
              const py = this.h - 1 - Math.floor((i >> 2) / this.w);
              if (px < x0) x0 = px;
              if (px > x1) x1 = px;
              if (py < y0) y0 = py;
              if (py > y1) y1 = py;
              // 前 24 个坐标 + 差值直方图。只有包围盒的话,
              // "散在一片里的 607 个点"和"沿着某条边的 607 个点"
              // 长得一模一样,而这两者的成因毫无共同之处。
              if (sample.length < 24) sample.push([px, py, m]);
              deltas[m] = (deltas[m] || 0) + 1;
            }
            if (m > maxD) maxD = m;
          }
          return { changed: changed, maxD: maxD, box: [x0, y0, x1, y1], sample: sample,
                   deltas: deltas };
        },
        // 把某张采样帧导成 PNG dataURL —— 只在**失败**的路径上调。
        // 读数(几个像素、峰值多少)说不清"那是什么",图能。
        dump: function (name) {
          const A = this.S[name];
          if (!A) return null;
          const cv = document.createElement('canvas');
          cv.width = this.w; cv.height = this.h;
          const cx = cv.getContext('2d');
          const img = cx.createImageData(this.w, this.h);
          // readPixels 是底向上的,翻过来才是人看的方向
          for (let y = 0; y < this.h; y++) {
            const src = (this.h - 1 - y) * this.w * 4;
            img.data.set(A.subarray(src, src + this.w * 4), y * this.w * 4);
          }
          cx.putImageData(img, 0, 0);
          return cv.toDataURL('image/png');
        },
        // 窗口用**顶向下**的行号(与 project 一致)。
        changedIn: function (x0, y0, x1, y1, a, b) {
          const A = this.S[a], B = this.S[b];
          const X0 = Math.max(0, Math.floor(x0)), X1 = Math.min(this.w - 1, Math.ceil(x1));
          const Y0 = Math.max(0, Math.floor(y0)), Y1 = Math.min(this.h - 1, Math.ceil(y1));
          let n = 0, peak = 0;
          for (let y = Y0; y <= Y1; y++) {
            // readPixels 自下而上,project 自上而下 —— 只在这里换一次行序。
            const row = this.h - 1 - y;
            for (let x = X0; x <= X1; x++) {
              const i = (row * this.w + x) * 4;
              const m = Math.max(Math.abs(A[i]-B[i]), Math.abs(A[i+1]-B[i+1]), Math.abs(A[i+2]-B[i+2]));
              if (m > 0) n++;
              if (m > peak) peak = m;
            }
          }
          return { n: n, peak: peak, w: X1 - X0 + 1, h: Y1 - Y0 + 1 };
        },
        project: function (p) {
          const v = new THREE.Vector3(p[0], p[1], p[2]).project(qm.camera);
          if (v.z > 1) return null;
          return [ (v.x * 0.5 + 0.5) * this.w, (-v.y * 0.5 + 0.5) * this.h ];
        },
        pxPerMeter: function (p) {
          const a = this.project(p), b = this.project([p[0], p[1] + 1, p[2]]);
          if (!a || !b) return null;
          return Math.hypot(a[0] - b[0], a[1] - b[1]);
        },
        // 烟团实例数据 → 每个烟源的包络上界。见文件头 ① 。
        fxEnvelope: function () {
          let mesh = null;
          const names = [];
          qm.scene.traverse(function (o) {
            if (o.material && o.material.name) {
              if (names.indexOf(o.material.name) < 0) names.push(o.material.name);
              if (o.material.name === 'fx_smoke') mesh = o;
            }
          });
          // 按**材质名**找,不是对象名:'fx_smoke' 挂在材质上,对象叫 FxSmoke。
          // 按对象名找过一次,返回了 undefined,而当时没读返回值,静默失败到
          // 二十行之后才以别的形式炸出来。所以这里找不到就直接抛,并把
          // 场景里真实的材质名列出来。
          if (!mesh) throw new Error('找不到材质名为 fx_smoke 的网格。场景里的材质名:' + names.join(', '));
          const g = mesh.geometry;
          const aO = g.getAttribute('aOrigin'), aP = g.getAttribute('aPuff'), aD = g.getAttribute('aDrift');
          if (!aO || !aP || !aD) {
            throw new Error('烟的实例属性不全:aOrigin=' + !!aO + ' aPuff=' + !!aP + ' aDrift=' + !!aD);
          }
          // instanceCount 会被画质档位截断,所以这个函数必须在**烟开着**的时候调。
          const count = g.instanceCount || aO.count;
          const em = qm.fxRuntime().emitters;
          mesh.updateWorldMatrix(true, false);
          const v = new THREE.Vector3();
          const out = [];
          for (let j = 0; j < em.length; j++) {
            out.push({ from: em[j].from, at: em[j].at, n: 0, rise: 0, drift: 0, r: 0 });
          }
          let unmatched = 0, worst = 0;
          for (let i = 0; i < count; i++) {
            v.set(aO.getX(i), aO.getY(i), aO.getZ(i)).applyMatrix4(mesh.matrixWorld);
            let best = -1, bd = Infinity;
            for (let j = 0; j < em.length; j++) {
              const a = em[j].at;
              const d = Math.hypot(v.x - a[0], v.y - a[1], v.z - a[2]);
              if (d < bd) { bd = d; best = j; }
            }
            if (best < 0 || bd > 1e-3) { unmatched++; if (bd > worst) worst = bd; continue; }
            const o = out[best];
            o.n++;
            const rise = aP.getW(i), life = aP.getY(i);
            const drift = aD.getZ(i) * life;
            const r = aP.getZ(i) * 2.45;
            if (rise > o.rise) o.rise = rise;
            if (drift > o.drift) o.drift = drift;
            if (r > o.r) o.r = r;
          }
          return { emitters: out, unmatched: unmatched, worst: worst, count: count, total: em.length };
        },
      };
      return { w: w, h: h };
    })()`);
    if (!ready || !ready.w) {
      record('A2 页内采样器就位', false, '未能拿到 drawingBuffer 尺寸');
      continue;
    }

    const setFx = async (smoke, birds) => {
      await page.evaluate(`window.__QM__.setFxOverride(${smoke}, 'smoke')`);
      return page.evaluate(`(() => { const x = window.__QM__.setFxOverride(${birds}, 'birds');
        return { puffs: x.puffs, birds: x.birds }; })()`);
    };

    // A3 基线非空白:全关之后画面不能是纯色,否则后面的差值都不可信。
    await setFx(0, 0);
    await page.evaluate(`window.__EF__.sample('off')`);
    const nonUniform = await page.evaluate(`(() => {
      const A = window.__EF__.S.off;
      let min = 255, max = 0;
      for (let i = 0; i < A.length; i += 4) {
        const l = 0.299*A[i] + 0.587*A[i+1] + 0.114*A[i+2];
        if (l < min) min = l;
        if (l > max) max = l;
      }
      return { min: +min.toFixed(1), max: +max.toFixed(1) };
    })()`);
    record('A3 基线画面非空白', nonUniform.max - nonUniform.min > 20,
      `亮度 ${nonUniform.min}~${nonUniform.max}`);

    // B 冻结:同一状态连拍两张必须逐像素相同。
    await page.evaluate(`window.__EF__.sample('off2')`);
    const frozen = await page.evaluate(`window.__EF__.diff('off', 'off2')`);
    if (frozen.changed > 0) {
      // 失败时把两张帧落盘 —— 下一次复现不用再猜"那几百个像素是什么"。
      for (const nm of ['off', 'off2']) {
        const durl = await page.evaluate(`window.__EF__.dump('${nm}')`);
        if (durl) {
          writeFileSync(
            `screenshots/web/effectsB1_${nm}.png`,
            Buffer.from(durl.split(',')[1], 'base64'),
          );
        }
      }
      console.log('     (B1 失败:off / off2 两帧已写入 screenshots/web/effectsB1_*.png)');
    }
    record('B1 冻结生效(关烟两帧逐像素相同)', frozen.changed === 0,
      `差异像素 ${frozen.changed}` +
      (frozen.changed ? `,集中在窗口 ${JSON.stringify(frozen.box)}` +
        `(顶向下 x ${frozen.box[0]}~${frozen.box[2]}, y ${frozen.box[1]}~${frozen.box[3]}),` +
        ` 峰值 ${frozen.maxD}/255,前几个点 ${JSON.stringify(frozen.sample)},` +
        ` 差值直方图 ${JSON.stringify(frozen.deltas)}` : ''));

    // C 三态 + 隔离。
    const stSmoke = await setFx(1, 0);
    await page.evaluate(`window.__EF__.sample('smoke')`);
    // 包络必须在**烟开着**的时候读:instanceCount 此时才是全量。
    const env = await page.evaluate(`window.__EF__.fxEnvelope()`);
    const stBirds = await setFx(0, 1);
    await page.evaluate(`window.__EF__.sample('birds')`);
    const readings = await page.evaluate(`(() => window.__QM__.setFxOverride(null, 'both'))()`);

    record('C1 只开烟时鸟数为 0', stSmoke.birds === 0, `puffs=${stSmoke.puffs} birds=${stSmoke.birds}`);
    record('C2 只开鸟时烟数为 0', stBirds.puffs === 0, `puffs=${stBirds.puffs} birds=${stBirds.birds}`);
    record('C3 high 档两族都有量', stSmoke.puffs > 0 && stBirds.birds > 0,
      `烟 ${stSmoke.puffs} 团 / 鸟 ${stBirds.birds} 只`);

    const dSmoke = await page.evaluate(`window.__EF__.diff('off', 'smoke')`);
    const dBirds = await page.evaluate(`window.__EF__.diff('off', 'birds')`);
    record('C4 烟在画面上产生了像素', dSmoke.changed > 0,
      `${dSmoke.changed} px 峰值 ${dSmoke.maxD}`);
    record('C5 鸟在画面上产生了像素', dBirds.changed > 0,
      `${dBirds.changed} px 峰值 ${dBirds.maxD}`);

    // D 落点。
    record('D0 每个实例都归属于某个烟源', env.unmatched === 0,
      `对不上 ${env.unmatched} 个 / 共 ${env.count} 个(最大距离 ${env.worst.toExponential(2)} m)`);

    let inFrame = 0, outFrame = 0, tooSmall = 0, clipped = 0, empty = 0;
    let missed = 0, occluded = 0, badPpm = 0;
    let controlBand = null;
    for (const e of env.emitters) {
      if (e.n === 0) {
        empty++;
        console.log(`     · 这一处没有实例(被画质截断了?),未验:${e.from}`);
        continue;
      }
      const geo = await page.evaluate(`(() => {
        const E = window.__EF__;
        return {
          base: E.project(${JSON.stringify(e.at)}),
          top:  E.project([${e.at[0]}, ${e.at[1] + e.rise}, ${e.at[2]}]),
          ppm:  E.pxPerMeter(${JSON.stringify(e.at)}),
        };
      })()`);
      // ⚠️ 顺序要紧:**先判"在不在画面内",再判"比例量不量得出"**。
      //    第一版把 ppm 检查放在前面,于是"相机背后"的烟源也会走到这里,
      //    报出一条"仪器故障"—— 而它其实只是一处正常的"不在画面内"。
      //    两个不同的原因共用一个出口,报告就会指错方向。
      if (!geo.base || !geo.top) {
        outFrame++;
        console.log(`     · 不在画面内,未验:${e.from}`);
        continue;
      }
      // 到了这里说明投影点是有效的,那么比例**必须**量得出来。
      // 量不出就是仪器坏了,不是场景坏了。以前这里写的是 `geo.ppm || 0`:
      // 量不出比例时横向放宽直接归零,包络塌成一条细线,报告上看起来只是一处
      // "烟没画到"—— 一次静默降级伪装成了一次真实的场景缺陷。现在它是显式失败。
      if (geo.ppm === null || geo.ppm === undefined) {
        badPpm++;
        record(`D-ppm ${e.from}`, false, '该处投影点在画面内,却算不出 像素/米 —— 仪器故障');
        continue;
      }
      const band = (() => {
        const ppm = geo.ppm;
        // 横向放宽 = 风漂封顶 + 精灵半宽;竖直放宽 = 精灵半宽。两者都是量出来的。
        const padX = ppm * (e.drift + e.r);
        const padY = ppm * e.r;
        const xs = [geo.base[0], geo.top[0]], ys = [geo.base[1], geo.top[1]];
        const x0 = Math.min(...xs) - padX, x1 = Math.max(...xs) + padX;
        const y0 = Math.min(...ys) - padY, y1 = Math.max(...ys) + padY;
        if (x1 < 0 || y1 < 0 || x0 > ready.w || y0 > ready.h) return null;
        const ix0 = Math.max(0, x0), ix1 = Math.min(ready.w - 1, x1);
        const iy0 = Math.max(0, y0), iy1 = Math.min(ready.h - 1, y1);
        const area = Math.max(1, (x1 - x0)) * Math.max(1, (y1 - y0));
        const inter = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
        return {
          x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, ppm,
          frac: inter / area,
          clampW: Math.ceil(ix1) - Math.floor(ix0) + 1,
          clampH: Math.ceil(iy1) - Math.floor(iy0) + 1,
        };
      })();
      if (!band) {
        outFrame++;
        console.log(`     · 不在画面内,未验:${e.from}`);
        continue;
      }
      const tag = `[ppm ${band.ppm.toFixed(1)} 包络 ${band.w.toFixed(0)}x${band.h.toFixed(0)}` +
        ` 视口内 ${band.clampW}x${band.clampH} 占 ${(band.frac * 100).toFixed(0)}%]`;
      if (band.clampW < MIN_BAND_PX || band.clampH < MIN_BAND_PX) {
        tooSmall++;
        console.log(`     · 视口内的包络只有 ${band.clampW}x${band.clampH}px,读不出,未验:${e.from} ${tag}`);
        continue;
      }
      // 包络大部分在画面外时,烟完全可能落在框外 —— 这时"框内没有像素"
      // 什么也证明不了。第一版没看这一条,于是把"包络被视口切掉"当成了
      // "烟没画",在虹桥机位报出两处假失败。两处的共同签名是:
      // 视口内的那一条又窄又长,而它要覆盖的漂移量有好几米。
      if (band.frac < 0.6) {
        clipped++;
        console.log(`     · 包络只有 ${(band.frac * 100).toFixed(0)}% 在画面内,框外那部分` +
          `可能才是烟待的地方,未验:${e.from} ${tag}`);
        continue;
      }
      const hit = await page.evaluate(
        `window.__EF__.changedIn(${band.x0}, ${band.y0}, ${band.x1}, ${band.y1}, 'off', 'smoke')`);
      inFrame++;
      if (hit.n > 0) {
        console.log(`     ✅ ${e.from.padEnd(26)} 内 ${hit.n} px(峰值 ${hit.peak})` +
          `  [升 ${e.rise.toFixed(2)}m 漂 ${e.drift.toFixed(2)}m / ${e.n} 团] ${tag}`);
        if (!controlBand) controlBand = { band, from: e.from };
      } else {
        // 包络里一个变化像素都没有。有两种**截然不同**的原因,必须分开:
        //   (a) 烟画了,但被前面的东西挡住了 —— 烟材质是 depthTest:true,
        //       被挡是正常的,不该判失败;
        //   (b) 烟根本没画到这个位置 —— 这才是真缺陷。
        //
        // 第一版判据把两者混为一谈,于是虹桥机位报了 2 处失败,而其中
        // `boat_ke_a_cover` 在船机位明明画出了 2117 px。同一处烟源换机位
        // 就有、这里就没有,成因只可能是"看不看得见",不是"画没画"。
        //
        // 分法:把烟的 depthTest 关掉再渲一帧。
        //   · 这时包络里出现像素 → 烟确实在那儿,只是被挡 → (a)
        //   · 仍然没有         → 烟真的没画到那儿        → (b)
        //
        // ⚠️ 这一步**只在已经失败的烟源上做**,全过时不产生任何额外渲染。
        //    代价是它引入了一次状态改动,所以下面立刻改回来,并把改回来的
        //    那一帧留作下一处的基准 —— 恢复失败的话,后面每一处都会跟着错,
        //    而那种错看起来就像"烟全没了"。
        const probe = await page.evaluate(`(() => {
          const E = window.__EF__;
          let mesh = null;
          window.__QM__.scene.traverse(function (o) {
            if (o.material && o.material.name === 'fx_smoke') mesh = o;
          });
          if (!mesh) throw new Error('对照渲染时找不到 fx_smoke');
          const m = mesh.material;
          const keep = m.depthTest;
          // 只改这一个开关,**故意不设 needsUpdate** —— depthTest 是在绘制时
          // 读的,不需要重编着色器。顺手加上 needsUpdate 会让这一帧的着色器
          // 程序可能和上一帧不同,于是"只改了一件事"这个前提就没了,
          // 差分出来的东西也就不一定是遮挡造成的。
          m.depthTest = false;
          E.sample('smoke_nodepth');
          m.depthTest = keep;
          const r = E.changedIn(${band.x0}, ${band.y0}, ${band.x1}, ${band.y1},
                               'off', 'smoke_nodepth');
          // 自查:depthTest 必须已经改回去,否则后面每一帧都不是正常渲染。
          return { n: r.n, peak: r.peak, restored: m.depthTest === keep };
        })()`);
        if (!probe.restored) {
          throw new Error('对照渲染之后 depthTest 没恢复 —— 后面的测量全部作废');
        }
        const plumeTag = `[升 ${e.rise.toFixed(2)}m 漂 ${e.drift.toFixed(2)}m / ${e.n} 团] ${tag}`;
        if (probe.n > 0) {
          occluded++;
          console.log(`     · ${e.from.padEnd(26)} 框内 0 px,但**关掉 depthTest 后` +
            `有 ${probe.n} px** → 烟画了,被前面的东西挡住了。算**未验**,不算失败。${plumeTag}`);
        } else {
          missed++;
          console.log(`     ❌ ${e.from.padEnd(26)} 框内一个变化像素都没有,` +
            `**关掉 depthTest 之后仍然没有** → 烟确实没画到这个位置。${plumeTag}`);
        }
      }
    }
    const verified = inFrame - occluded;
    record('D1 每个被验到的发烟点都有烟像素',
      missed === 0 && badPpm === 0 && verified > 0,
      `包络可用(且大部分在画面内) ${inFrame} 处 / 其中验到 ${verified} 处 / 没找到 ${missed} 处`);
    const unverified = outFrame + tooSmall + clipped + empty + occluded;
    console.log(`     未验的分项:不在画面内 ${outFrame} / 视口内太小 ${tooSmall} / ` +
      `大部分在画面外 ${clipped} / 无实例 ${empty} / 被遮挡 ${occluded}` +
      (badPpm ? ` / **比例算不出 ${badPpm}(仪器故障,已单独报失败)**` : ''));
    if (unverified > 0) {
      console.log(`     ⚠️ 上面这 ${unverified} 处是**没验到**,不是通过 —— 逐项看原因:`);
      console.log(`        · "不在画面内" ${outFrame} 处 —— 换机位才轮到;`);
      console.log(`        · "视口内太小" ${tooSmall} 处 —— 拉近才轮到;`);
      console.log(`        · "大部分在画面外" ${clipped} 处 —— 烟可能就落在框外那部分,`);
      console.log(`          框内没有像素证明不了任何事,要换机位;`);
      console.log(`        · "无实例" ${empty} 处 —— 画质截断,开高画质才轮到;`);
      console.log(`        · "被遮挡" ${occluded} 处 —— 烟在那儿,这个机位看不见。`);
      console.log(`        **不要**因为它们没报错就当成验过了。`);
    }

    // D2 阴性对照:同一个窗口,换成两张**相同**的帧,必须一个像素都没有。
    // 这一条与 D1 配对才有意义 —— 同一个窗口在一次比较里给出 >0、
    // 在另一次里给出 0,才证明这个窗口真的在区分,而不是永远吐同一个数。
    if (controlBand) {
      const c = await page.evaluate(
        `window.__EF__.changedIn(${controlBand.band.x0}, ${controlBand.band.y0}, ` +
        `${controlBand.band.x1}, ${controlBand.band.y1}, 'off', 'off2')`);
      record('D2 阴性对照(同一窗口,两张相同的帧)', c.n === 0,
        `${controlBand.from} 的窗口在 off-vs-off2 上得到 ${c.n} px`);
    } else {
      record('D2 阴性对照', false, 'D1 没有任何一处找到像素,拿不到可对照的窗口');
    }

    // E 关干净。
    await setFx(0, 0);
    await page.evaluate(`window.__EF__.sample('off3')`);
    const cleared = await page.evaluate(`window.__EF__.diff('off', 'off3')`);
    const rt = await page.evaluate(`window.__QM__.fxRuntime()`);
    record('E1 全关后画面上没有残留像素', cleared.changed === 0,
      `差异像素 ${cleared.changed}(读数为 烟 ${rt.puffs} / 鸟 ${rt.birds})` +
      (cleared.changed ? `,窗口 ${JSON.stringify(cleared.box)} 峰值 ${cleared.maxD}/255` : ''));

    if (rt.warnings && rt.warnings.length) {
      console.log(`     ⚠️ fxRuntime().warnings 有 ${rt.warnings.length} 条:`);
      for (const w of rt.warnings) console.log(`        · ${w}`);
    }

    await page.evaluate(`window.__QM__.loop.start(window.__QM__.renderer)`);
    console.log(`     (读数复核:恢复后 烟 ${readings.puffs} / 鸟 ${readings.birds})`);
  }
} finally {
  await close();
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log('════════════════════════════════════════');
console.log(`  ${results.length - failed.length} 项通过 / ${failed.length} 项失败`);
if (failed.length) {
  for (const f of failed) console.log(`  ❌ ${f.name}  ${f.detail}`);
  console.log('');
  console.log('  注:失败要先怀疑**量具**再怀疑场景 —— 这份项目里仪器出错已发生 37 次,');
  console.log('      而仪器出错时的读数长得完全像一个真实的场景缺陷。');
  process.exitCode = 1;
} else {
  console.log('  ✅ 全部通过');
  console.log('');
  console.log('  ⚠️ 这份检查的边界,别把它读大了:');
  console.log('     · 它证明的是"烟/鸟的像素出现在模型指认的位置附近",');
  console.log('       **不证明**烟的形态、浓度、斜度好看;');
  console.log('     · D 段的包络是**整段轨迹**,所以"烟恰好冒在屋脊正中"这种话,');
  console.log('       这份报告给不出来;');
  console.log('     · 上面逐条列出的"未验"烟源是**没验**,不是通过;');
  console.log('     · 它不产出任何"平均 Δ" —— 那个统计量的样本集随被测变量增长,');
  console.log('       理由写在文件头最后一段。');
}
