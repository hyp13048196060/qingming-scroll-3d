#!/usr/bin/env node
/**
 * 帧时与渲染开销的唯一来源。`docs/05-性能测量报告.md` 由它产出的 json 生成,
 * **报告里的数字不允许手写** —— 从流程上杜绝"声称 60fps"。
 *
 * ## 协议
 *
 *   加载 → 热身 8s(**丢弃**) → `loop.resetStats()` → 测量 8s → 读 summary
 *
 * 热身必须丢弃:首次加载要编译 shader、上传贴图、跑一遍 PMREM,
 * 那些帧本来就慢,算进去就变成"报告的是加载速度,不是运行速度"。
 *
 * ## ⚠️ 关于帧时:这里连着错过两次,记下来免得再错第三次
 *
 * 本探针第一版拿 rAF 回调间隔当帧时,读到 high 档 p95 = 30.4ms,
 * 结论是"未达 20ms 目标,要去优化"。
 *
 * 第二版给了一个解释:在空页面上量到 rAF 间隔 p50 = **30.26ms**,
 * 与作品 high 档的 30.30ms 几乎相等,于是断定这是**量具自己的刻度上限**
 * (所谓"无头 Chrome 的 rAF 节拍约 33Hz"),作品其实很轻。
 *
 * **这个解释也是错的。** 把空页面重测 8 次,每次都是 **6.1ms**;
 * 30.26 是一次离群值(那一轮的 max 是 200ms,机器在忙)。拿一次读数
 * 当作常数去校准另一把尺子,量出来的只是那一次的运气。
 *
 * 真相在第三版,靠**把一帧拆开逐个计时**才拿到:
 *   一帧 CPU 合计 ~26ms,其中「人物」一环 **22.64ms** —— 85%。
 *   具体到一行:`CharacterPool.update` 每帧给每个走动的人打一次
 *   没有 BVH 的地面射线(`intersectObjects`),单次 0.595ms × 37 人。
 *   rAF 的 30ms 是在**如实报告**这个开销,不是节拍。
 *   把那一行节流之后,rAF 间隔立刻掉到 **6.06ms** = 空页面地板。
 *
 * 两次错误的共同形状是一样的:**量了一个部件,拿它代表整帧。**
 * 第一版量了 rAF(量具),第二版量了渲染(4ms,只占一帧的六分之一),
 * 两次都得到一个自洽、合理、而且方向相反的结论。
 *
 * 所以本探针现在同时记录四种口径,一个都不许省:
 *   `frame`     rAF 间隔        —— 真循环的节拍,受合成器影响
 *   `frameCost` 只绘制          —— measureFrameCost,不含逻辑
 *   `logicCost` 只逻辑          —— measureLogicCost(n, false)
 *   `bothCost`  逻辑 + 绘制     —— measureLogicCost(n, true),一帧的 CPU 总开销
 *   `stageCost` 逐环节          —— measureStageCost,大头落在哪一环
 *
 * 判读规则:**先看 stageCost 找出大头,再谈达标与否。**
 * 只看 frameCost 会得到一个漂亮但只覆盖六分之一帧的数字。
 *
 * ## 为什么必须同时给 p95 和 max
 *
 * 平均值会把周期性卡顿抹平。反射每 3 帧一次(中档)时,平均值看着漂亮,
 * 而每第 3 帧掉一下恰恰是体感最差的。只报平均值等于把要藏的东西藏起来。
 *
 * ## 为什么主 pass 要单独算
 *
 * `renderer.info.render` 是**主 + 阴影 + 反射**的累加值。门限里写着
 * "主 pass drawcall ≤220",拿累加值去比,量的是三件事的和 ——
 * 要么虚报超标,要么为压这个虚高的数去砍正常的几何。
 * 分解由 `src/core/passStats.ts` 在页内完成,这里只负责读。
 *
 * ## GPU 门禁
 *
 * 无头 Chrome 可能退到 SwiftShader 软件渲染。那种帧时毫无意义,
 * 且**看起来完全正常**。所以先断言真实 GPU 串含 ANGLE + NVIDIA,
 * 不过就**拒绝产出**任何 json —— 宁可不写,也不写一份会被误读的数据。
 *
 * 用法:
 *   node tools/perf/perf_probe.mjs                    # 9 组 + 反射 A/B
 *   node tools/perf/perf_probe.mjs --quick            # 只跑 high 档 2 个机位
 *   node tools/perf/perf_probe.mjs --out x.json
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');
const OUT = argv.includes('--out')
  ? argv[argv.indexOf('--out') + 1]
  : 'screenshots/perf/perf_probe.json';

const BASE = 'http://127.0.0.1:4173/';
const W = 1920, H = 1080;          // 报告写明是 1080p
const WARMUP_MS = 8000;
const MEASURE_MS = 8000;
const PASS_SAMPLES = 24;           // 读多少帧的 pass 分解(取最坏帧)

const QUALITIES = ['low', 'mid', 'high'];
const SPOTS = ['bridge', 'boat', 'teahouse', 'gate', 'market'];
// 反射 A/B:挑水面占比最大的两个机位,`reflect=1` vs `reflect=0`
const AB = [
  { quality: 'high', spot: 'bridge' },
  { quality: 'high', spot: 'boat' },
];

const url = (q, spot, reflect) =>
  `${BASE}?q=${q}&hud=0&spot=${spot}` + (reflect == null ? '' : `&reflect=${reflect}`);

const { page, close, browserVersion } = await launch({ width: W, height: H });
const collections = [];
const ab = [];
let gpuInfo = null;

/**
 * 一次完整采集。返回该组的全部读数。
 */
async function measure(target, tag) {
  await page.goto(target);
  await page.waitForReady({ timeout: 180000 });
  await sleep(WARMUP_MS);

  const gpu = await page.evaluate('(() => { const g = window.__QM__.gpu; return { renderer: g.renderer, vendor: g.vendor, isSoftware: g.isSoftware }; })()');
  if (!gpuInfo) gpuInfo = gpu;

  await page.evaluate('window.__QM__.loop.resetStats()');
  await sleep(MEASURE_MS);
  const frame = await page.evaluate('window.__QM__.loop.stats()');

  // 真实帧开销:停 rAF → 连渲 150 帧、逐帧 gl.finish → 恢复。
  // 逐帧 finish 是**串行上界**(放弃了 CPU/GPU 重叠),真实吞吐只会更好,
  // 所以这个数偏保守 —— 报告里要写明这一点,不能当成"最好情况"。
  //
  // ⚠️ 这个数**只含绘制**。早先报告把它的 p95 当成"一帧的开销",
  //    于是得出"离 60fps 有 2.4 倍余量" —— 而当时一帧 CPU 实际是 26ms。
  //    所以下面三个口径必须一起采,缺一个就会重现那个错。
  const burst = await page.evaluate('window.__QM__.measureFrameCost(150)');

  // 只逻辑:跑两遍取第二遍,第一遍会把 JIT 还没编译的分支算进来
  await page.evaluate('window.__QM__.measureLogicCost(240, false)');
  const logic = await page.evaluate('window.__QM__.measureLogicCost(240, false)');
  // 逻辑 + 绘制 = 一帧的 CPU 总开销
  const both = await page.evaluate('window.__QM__.measureLogicCost(240, true)');
  // 逐环节:大头落在哪一环。同样跑两遍取第二遍。
  await page.evaluate('window.__QM__.measureStageCost(240)');
  const stageCost = await page.evaluate('window.__QM__.measureStageCost(240)');

  // pass 分解逐帧采样。只读一帧会撞上"这一帧恰好没跑反射"(中档每 3 帧一次),
  // 于是把反射的开销读成 0。取**最坏帧**,因为门限管的是最坏情况。
  const passFrames = [];
  for (let i = 0; i < PASS_SAMPLES; i++) {
    passFrames.push(await page.evaluate('window.__QM__.passStats()'));
    await sleep(40);
  }
  const worst = (key) => passFrames.reduce((a, b) => (b[key].calls > a[key].calls ? b : a));
  const worstFrame = worst('total');
  const sum = (key, f) => passFrames.reduce((a, b) => a + b[key][f], 0) / passFrames.length;

  const rest = await page.evaluate(`(() => {
    const qm = window.__QM__;
    const s = qm.store.read();
    return {
      qualityState: s.quality,
      river: qm.riverRuntime ? qm.riverRuntime() : null,
      actors: qm.actorsSnapshot ? qm.actorsSnapshot() : null,
      // ⚠️ 必须一起读。逐环节里的「氛围粒子」是**每帧只写一个 uniform** 的
      //    环节,CPU 开销本来就 <0.005ms,于是它那一格永远显示 0.00 ——
      //    而"0.00 是因为真的很轻"和"0.00 是因为一处都没画"在这一格上
      //    完全一样。只有 puffs/birds 这两个**当前真的在画的数**能把它们分开。
      //    (同一个形状的坑:instrument-error-pattern 第 40 条。)
      fx: qm.fxRuntime ? qm.fxRuntime() : null,
    };
  })()`);

  const rec = {
    tag,
    url: target,
    quality: target.match(/q=(\w+)/)?.[1] ?? null,
    spot: target.match(/spot=(\w+)/)?.[1] ?? null,
    reflect: target.includes('reflect=') ? target.match(/reflect=(\w+)/)?.[1] : null,
    // rAF 口径:受节拍地板限制,**不可用作帧时**,只作对照
    frame: { ...frame, windowMs: MEASURE_MS,
             note: 'rAF 口径。受无头 Chrome 的 rAF 节拍地板限制,不等于帧时,勿用于比门限' },
    // 真实帧开销口径(连渲 + gl.finish,串行上界)。**只含绘制。**
    frameCost: { ...burst, note: '同步连渲吞吐,逐帧 gl.finish(串行上界),与 rAF 节拍无关;**只含绘制,不含 CPU 逻辑**' },
    // 纯 CPU 逻辑(相机阻尼 + 步态 + 风动 uniform + UI 之外的一切)
    logicCost: { ...logic, note: 'frameStep(dt, wt, false):无任何绘制的纯逻辑' },
    // 一帧的 CPU 总开销。比门限要看它,不是只看 frameCost。
    bothCost: { ...both, note: 'frameStep(dt, wt, true):逻辑 + 绘制,真循环里一帧的 CPU 总量' },
    // 逐环节,按耗时降序。定位大头用。
    stageCost,
    // 最坏帧:门限管的就是它
    passWorst: worstFrame,
    // 平均帧:用来看"典型一帧"的开销
    passAvg: {
      total: { calls: +sum('total', 'calls').toFixed(1), triangles: Math.round(sum('total', 'triangles')) },
      shadow: { calls: +sum('shadow', 'calls').toFixed(1), triangles: Math.round(sum('shadow', 'triangles')) },
      reflection: { calls: +sum('reflection', 'calls').toFixed(1), triangles: Math.round(sum('reflection', 'triangles')) },
      main: { calls: +sum('main', 'calls').toFixed(1), triangles: Math.round(sum('main', 'triangles')) },
    },
    passSampleCount: passFrames.length,
    // 一帧里阴影 pass 被调了几次。2 = 反射内部又跑了一遍(three 的默认行为)
    shadowRenders: worstFrame.shadowRenders,
    reflectionRenders: worstFrame.reflectionRenders,
    reflectionFrames: passFrames.filter((p) => p.reflectionRenders > 0).length,
    memory: worstFrame.memory,
    programs: worstFrame.programs,
    qualityState: rest.qualityState,
    river: rest.river,
    actorsCount: rest.actors ? (rest.actors.count ?? rest.actors.total ?? null) : null,
    // 这一组读数是在**多少烟、多少鸟真的在画**的条件下取的。
    fx: rest.fx,
  };
  console.log(
    `  ${tag.padEnd(22)} 帧开销 p50=${String(burst.p50).padStart(6)} p95=${String(burst.p95).padStart(6)}ms  ` +
    `主pass ${String(rec.passAvg.main.calls).padStart(6)} call / ${String(rec.passAvg.main.triangles).padStart(8)} tri  ` +
    `反射 ${String(rec.passAvg.reflection.calls).padStart(5)} call  阴影×${rec.shadowRenders}  ` +
    `| 只逻辑 ${String(logic.p50).padStart(6)}  逻辑+绘制 ${String(both.p50).padStart(6)}ms  ` +
    `| 最大一环「${stageCost[0]?.name}」${stageCost[0]?.ms}ms  ` +
    `| 烟 ${rec.fx && rec.fx.puffs != null ? rec.fx.puffs : '?'} 团 / 鸟 ` +
    `${rec.fx && rec.fx.birds != null ? rec.fx.birds : '?'} 只  ` +
    `| rAF间隔 ${frame.p50}ms`,
  );
  return rec;
}

console.log(`视口 ${W}×${H}  热身 ${WARMUP_MS}ms 测量 ${MEASURE_MS}ms 浏览器 ${browserVersion}\n`);

/**
 * rAF 自己的节拍地板 —— 在**空页面**上量,页面上没有本作品的任何代码。
 *
 * ⚠️ **必须重复测,并且报出全部读数,不能只报中位。**
 *    只测一次得到过 30.26ms,被写进报告当成"无头 Chrome 的 rAF 节拍
 *    约 33Hz"这个常数;重测 8 次全是 6.1ms。那一次的 max 是 200ms ——
 *    机器在忙。地板是**会漂的**,报出 8 次的离散度就是让人看见这件事。
 */
async function measureRafFloor() {
  await page.goto('about:blank');
  const one = `(async () => {
    const ts = [];
    await new Promise((res) => { let n = 0;
      const f = (t) => { ts.push(t); if (++n < 200) requestAnimationFrame(f); else res(); };
      requestAnimationFrame(f); });
    const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
    d.sort((a, b) => a - b);
    const r2 = (v) => Math.round(v * 100) / 100;
    return { samples: d.length, p50: r2(d[Math.floor(d.length * 0.5)]),
             p95: r2(d[Math.floor(d.length * 0.95)]), max: r2(d[d.length - 1]) };
  })()`;
  const runs = [];
  for (let i = 0; i < 8; i++) runs.push(await page.evaluate(one));
  const p50s = runs.map((r) => r.p50).sort((a, b) => a - b);
  return {
    runs: p50s,
    samples: runs[0]?.samples ?? 0,
    p50: p50s[Math.floor(p50s.length / 2)],
    min: p50s[0],
    max: p50s[p50s.length - 1],
    worstMax: Math.max(...runs.map((r) => r.max)),
    note: '空页面 rAF 间隔,重复 8 次。地板会漂,故报全部读数与离散度,不报单一常数',
  };
}

let rafFloor = null;
try {
  rafFloor = await measureRafFloor();
  console.log(`rAF 节拍地板(空页面,重复 8 次):${rafFloor.runs.join(', ')} ms`);
  console.log(`  → 中位 ${rafFloor.p50}ms,离散 ${rafFloor.min}~${rafFloor.max}ms(单次最坏 max ${rafFloor.worstMax}ms)`);
  console.log('  → 地板**会漂**,不是一个可以引用的常数。作品的 rAF 间隔若明显高于它,那是开销,不是节拍。\n');
} catch (e) {
  console.warn(`  (rAF 地板测量失败: ${e.message})`);
}

try {
  const quals = QUICK ? ['high'] : QUALITIES;
  const spots = QUICK ? ['bridge', 'boat'] : SPOTS;
  for (const q of quals) {
    for (const spot of spots) {
      collections.push(await measure(url(q, spot), `${q}/${spot}`));
    }
  }

  console.log('\n反射 A/B(?reflect=1 vs ?reflect=0):');
  for (const { quality, spot } of AB) {
    const on = await measure(url(quality, spot, 1), `${quality}/${spot}/reflect=1`);
    const off = await measure(url(quality, spot, 0), `${quality}/${spot}/reflect=0`);
    ab.push({ quality, spot, on, off });
  }
} finally {
  await close();
}

// —— GPU 门禁 ——
// 必须在写文件**之前**,否则会留下一份看起来正常、实际是软件渲染的数据。
const ok = gpuInfo && !gpuInfo.isSoftware && /ANGLE/i.test(gpuInfo.renderer) && /NVIDIA/i.test(gpuInfo.renderer);
console.log(`\nGPU: ${gpuInfo?.renderer ?? '(读不到)'}`);
if (!ok) {
  console.error(
    '\n✗ GPU 门禁未通过:渲染器串不含 ANGLE + NVIDIA,或已被判定为软件渲染。\n' +
    '  帧时数据不可用,**拒绝写出 json** —— 一份会被误读的数据比没有数据更坏。',
  );
  process.exit(3);
}
console.log('✓ GPU 门禁通过');

// —— 门限判定,与计划里的表一一对应 ——
const TARGET = {
  drawcallMain: 220, drawcallMainMax: 400,
  triTotal: 1.2e6, triTotalMax: 2.5e6,
  triReflect: 5e5, triShadow: 8e5,
  programs: 60,
  p95: 20, p95Max: 33,
  // 一帧 CPU 总开销(逻辑 + 绘制)。60fps 的预算是 16.7ms。
  // 上限给 33ms —— 越过这条线就是连 30fps 都保不住的量级。
  cpu: 16.7, cpuMax: 33,
};
const checks = [];
for (const c of collections) {
  const m = c.passAvg.main;
  checks.push({
    id: c.tag,
    '主pass drawcall': [m.calls, TARGET.drawcallMain, TARGET.drawcallMainMax],
    '总三角面': [c.passAvg.total.triangles, TARGET.triTotal, TARGET.triTotalMax],
    '反射pass三角面': [c.passAvg.reflection.triangles, TARGET.triReflect, null],
    '阴影pass三角面': [c.passAvg.shadow.triangles, TARGET.triShadow, null],
    'shader program': [c.programs, TARGET.programs, null],
    // 只绘制(连渲口径)。保留它是因为它能干净地反映几何量,
    // 但它**不是**一帧的开销 —— 下一行的 cpu 才是。
    '绘制p95(ms)': [c.frameCost.p95, TARGET.p95, TARGET.p95Max],
    // 一帧的 CPU 总开销。这一行才是"够不够 60fps"的答案。
    '一帧CPUp95(ms)': [c.bothCost.p95, TARGET.cpu, TARGET.cpuMax],
  });
}
console.log('\n门限判定(目标 / 上限):');
let anyFail = false;
for (const c of checks) {
  const parts = [];
  for (const [k, [v, tgt, cap]] of Object.entries(c)) {
    if (k === 'id') continue;
    const over = v > tgt;
    const wayOver = cap != null && v > cap;
    if (over) anyFail = true;
    parts.push(`${k}=${typeof v === 'number' ? v.toLocaleString() : v}${wayOver ? '✗超上限' : over ? '⚠超目标' : '✓'}`);
  }
  console.log(`  ${c.id.padEnd(22)} ${parts.join('  ')}`);
}

const out = resolve(OUT);
await mkdir(dirname(out), { recursive: true });
await writeFile(
  out,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      browser: browserVersion,
      gpu: gpuInfo,
      viewport: { width: W, height: H, deviceScaleFactor: 1 },
      protocol: {
        warmupMs: WARMUP_MS, measureMs: MEASURE_MS,
        note: '热身数据全部丢弃;frameCost 只含绘制(连渲 150 帧 + 逐帧 gl.finish,串行上界偏保守);bothCost 是逻辑+绘制的一帧 CPU 总量,比门限以它为准;stageCost 逐环节,各环分开测,不能相加当总帧时;pass 分解取逐帧采样中的最坏帧',
      },
      /**
       * rAF 节拍地板。读报告的人靠它判断"为什么不用 loop.stats 的 p95"。
       * 若某次采集的 frame.p95 明显高于这个地板,那才是真的掉帧。
       */
      rafFloor,
      thresholds: TARGET,
      collections,
      reflectionAB: ab,
    },
    null,
    2,
  ),
);
console.log(`\n已写出 ${out}`);
console.log(anyFail ? '⚠ 有指标未达目标 —— 如实写进 docs/05,不修饰' : '✓ 全部达到目标值');
