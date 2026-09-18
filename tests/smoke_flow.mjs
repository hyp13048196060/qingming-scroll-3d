#!/usr/bin/env node
/**
 * 阶段 3 的八组功能验证 —— 每组「一串脚本动作 + 一条状态断言」。
 *
 * 为什么是一个总表而不是八个脚本
 * ------------------------------
 * 用户的要求是「八个功能组逐条有断言」。八个独立脚本各印各的,最后没人
 * 汇总,和"看着都跑了"没有区别。所以这里一张表、一次运行、一个结论 ——
 * 和 `tools/perf/verify_spots.mjs` 同一套做法。
 *
 * ⚠️ **未实现的组一律报「未实现」,绝不报通过。**
 *    这是本文件最重要的一条纪律。八组里现在只有一组能跑,如果剩下的
 *    默认算通过,那么"八组全绿"这句话就毫无意义 —— 而阶段 3 的出口条件
 *    正是"八组全绿"。所以退出码的判据是 `失败==0 且 未实现==0`,
 *    少一组都不算过。
 *
 * 第 3~8 组的断言为什么在别处
 * ---------------------------
 * 它们都是**跑真浏览器**才立得住的(标签要投影到屏幕坐标、舆图要按实测
 * 坐标画、404 要真的从服务器拿到、漫游要真的走十秒),已经写在
 * `tools/perf/probe_ui.mjs` 里。本文件**不复制**那些断言,只调度它、
 * 读回它写的 json,按组标签并进总表。理由很实际:同一件事有两份实现,
 * 两份迟早会各自漂移,而到结论不一致的那天,没人说得清哪份是对的。
 *
 * ⚠️ 但"委派"不等于"放行":委派过来的组如果**一条断言都没有**,
 *    本文件按**失败**计,并说明是哪一组没了 —— 那是被删掉,不是通过。
 *
 * 采样为什么在页面里做
 * --------------------
 * 第二组要量「末 0.3s 的单帧位移方差」。这是**逐帧**的量,从 CDP 每
 * 50ms 轮询一次 `cameraSnapshot()` 采不到 —— 采到的点是抽稀过的,
 * 方差会被算成一个没有意义的数。所以用 `requestAnimationFrame` 在页面
 * 内逐帧记录,再把整个序列取回来在 node 里算。
 *
 * 判据里哪些是推导、哪些是实测
 * ----------------------------
 * `src/camera/tween.ts` 的头部推导了 f'(t)=20t(1−t)³、尾部长尾 3.3e−3。
 * 那些是**选曲线的依据,不是结论**。本文件实测并打印真实数字:终点误差、
 * 末 0.3s 方差、回退量、到位后的残余摆动。推导和实测对得上才算数。
 *
 * 用法:
 *   node tests/smoke_flow.mjs
 *   node tests/smoke_flow.mjs --url http://127.0.0.1:4173/ --only 2
 *   node tests/smoke_flow.mjs --json screenshots/perf/smoke_flow.json
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { launch, sleep } from '../tools/perf/lib/cdp.mjs';

// --------------------------------------------------------------------------
// 参数
// --------------------------------------------------------------------------

const args = {
  url: 'http://127.0.0.1:4173/',
  only: null,
  json: 'screenshots/perf/smoke_flow.json',
  width: 1600,
  height: 900,
};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[++i];
    else if (argv[i] === '--json') args.json = argv[++i];
    else if (argv[i] === '--only') args.only = argv[++i].split(',').map(Number);
    else if (argv[i] === '--width') args.width = Number(argv[++i]);
    else if (argv[i] === '--height') args.height = Number(argv[++i]);
  }
}

const ROOT = resolve(import.meta.dirname, '..');
const spotsDoc = JSON.parse(
  await readFile(resolve(ROOT, 'src/data/spots.json'), 'utf8'),
);

// --------------------------------------------------------------------------
// 页面内逐帧记录器
// --------------------------------------------------------------------------

/**
 * ⚠️⚠️ 下面这一整段是**页面里执行的字符串**。里面**不能出现反引号**,
 *     也不能出现 `${` —— 反引号会提前终止本文件里包着它的模板字面量,
 *     症状是 SyntaxError 指向一段注释("Unexpected identifier"),
 *     看着像注释语法错,而注释不可能语法有错;真正的原因是注释把
 *     字符串切断了。(本文件里提到字段名一律用【方括号】。)
 *     `tools/perf/probe_pixel_web.mjs` 栽过两次,这里不栽第三次。
 *
 * 记录四件事:时间戳(相对录制起点)、相机位置、tween 是否还在进行。
 * 有【tweening】这一列,就能从**序列本身**判断什么时候到位的 ——
 * 不必在外面轮询猜时间点,那个猜法会把到位时刻抖掉一两帧,
 * 而"末 0.3s"这个窗口正好是几帧宽度。
 */
const RECORDER_SRC = `
window.__QMREC__ = (function () {
  var qm = window.__QM__;
  if (!qm || !qm.director) return null;
  var cam = qm.camera;
  var dir = qm.director;
  var samples = [];
  var running = true;
  var t0 = performance.now();
  function tick() {
    if (!running) return;
    samples.push([
      Math.round((performance.now() - t0) * 1000) / 1000,
      cam.position.x, cam.position.y, cam.position.z,
      dir.tweening ? 1 : 0
    ]);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return {
    stop: function () { running = false; return samples; },
    count: function () { return samples.length; }
  };
})();
`;

/** 录制时长上限:补间最长 1.8s,再留 1.2s 观察到位后的残余摆动。 */
const SETTLE_SEC = 1.2;

// --------------------------------------------------------------------------
// 分析:把一串逐帧样本算成可断言的数
// --------------------------------------------------------------------------

const dist3 = (a, b) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function variance(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length;
}

/**
 * 样本 = [t, x, y, z, tweening]。
 * @param dest 该景点的目标机位(实测终点要跟它比)
 */
function analyse(samples, dest) {
  const pos = (i) => [samples[i][1], samples[i][2], samples[i][3]];

  // —— 补间的起点与到位点,由 tweening 列本身给出 ——
  let iStart = -1;
  let iArrive = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i][4] === 1 && iStart < 0) iStart = i;
    if (iStart >= 0 && samples[i][4] === 0) {
      iArrive = i;
      break;
    }
  }

  if (iStart < 0 || iArrive < 0) {
    return {
      ok: false,
      reason:
        iStart < 0
          ? '整个录制过程里 tween 从未开始(tweening 一直是 0)'
          : '录到结束 tween 也没到位,请把 SETTLE_SEC 调大',
      frames: samples.length,
      iStart,
      iArrive,
    };
  }

  const tStart = samples[iStart][0];
  const tArrive = samples[iArrive][0];
  const final = pos(iArrive);
  const n = samples.length;

  // —— ① 终点误差 ——
  const errFinal = dist3(final, dest);

  // —— ② 末 0.3s 的逐帧位移及其方差 ——
  // 窗口按**时间**取,不按帧数取:帧率抖动时按帧取会时而 12 帧时而 25 帧,
  // 量的就不是同一段时间了。
  const tailFrom = tArrive - 300;
  const tailIdx = [];
  for (let i = iStart + 1; i <= iArrive; i++) {
    if (samples[i][0] >= tailFrom) tailIdx.push(i);
  }
  const tailSteps = tailIdx.map((i) => dist3(pos(i), pos(i - 1)));
  const tailVar = variance(tailSteps);
  const tailMax = tailSteps.length ? Math.max(...tailSteps) : 0;

  // —— ③ 全程单调性:到终点的距离不许回涨 ——
  // 这是"无回弹"最直接的说法。缓动曲线过冲的话,距离会先减到 0 以下
  // (越过终点)再涨回来,这里立刻能看见。
  let worstRegression = 0;
  let regressions = 0;
  let prevD = dist3(pos(iStart), dest);
  for (let i = iStart + 1; i <= iArrive; i++) {
    const d = dist3(pos(i), dest);
    const delta = d - prevD;
    if (delta > worstRegression) worstRegression = delta;
    if (delta > 1e-4) regressions++;
    prevD = d;
  }

  // —— ④ 到位之后的残余摆动 ——
  // ⚠️ 这一条不在计划书的验收表里,但它才是**弹跳真正会发生的地方**:
  //    tween 一结束 `controls.enabled` 就恢复、`controls.update()` 被调,
  //    阻尼里存着的残量在这一刻才被放出来。只量补间末 0.3s 是量不到的 ——
  //    那时候阻尼还停着。所以补一条:到位后 1.2s 内,离终点最远漂了多少。
  let settleMax = 0;
  let settleSamples = 0;
  for (let i = iArrive; i < n; i++) {
    const d = dist3(pos(i), final);
    if (d > settleMax) settleMax = d;
    settleSamples++;
  }

  return {
    ok: true,
    frames: n,
    tweenFrames: iArrive - iStart,
    start: pos(iStart),
    final,
    dest,
    // ⚠️ 这里的 t 已经是**毫秒**(performance.now() 的差),不要再乘 1000。
    //    第一版乘了,于是打印出「时长 1799035ms」—— 一个 1.8s 的补间被
    //    写成 1799 秒。**数算对了,标签说谎了**:窗宽按 t 取的 300 就是
    //    300ms,完全正确,只有输出的单位名写错。这类错不报错,只是让人
    //    读到一屏荒谬的数,然后开始怀疑数据本身。
    tweenMs: Math.round(tArrive - tStart),
    fps: Math.round(((iArrive - iStart) / (tArrive - tStart)) * 1000),
    errFinal,
    tailFrames: tailIdx.length,
    tailSpanMs: Math.round(tArrive - samples[tailIdx[0]][0]),
    tailVar,
    tailMax,
    worstRegression,
    regressions,
    settleMax,
    settleSamples,
    settleMs: Math.round((samples[n - 1][0] - tArrive)),
  };
}

// --------------------------------------------------------------------------
// 阈值(与计划书阶段 3 的表一致;超出计划书的部分在注释里说明来源)
// --------------------------------------------------------------------------

const LIMIT = {
  errFinal: 0.05, // 计划书:结束位置误差 <0.05m
  tailVar: 1e-4, // 计划书:末 0.3s 位移方差 <1e-4(无弹跳)
  regression: 1e-4, // 本文件:小于此值算浮点噪声,不算回退
  settle: 0.01, // 本文件:到位后残余摆动 <1cm(计划书未定,取 1cm 作可视阈值)
  minTweenFrames: 20, // 本文件:补间至少要跨 20 帧,否则"末 0.3s"没有意义
};

// --------------------------------------------------------------------------
// 第二组:五景点平滑切换
// --------------------------------------------------------------------------

/** 每次切换前先站到这个机位,让五次的起点一致、可互相比较。 */
const START_POSE = { position: [26, 14, 30], target: [0, 4, 0] };

async function group2(page) {
  const checks = [];
  const records = [];

  for (const spot of spotsDoc.spots) {
    // 站回统一起点。place() 是瞬移,不进补间。
    await page.evaluate(
      `window.__QM__.director.place([${START_POSE.position.join(',')}],` +
        `[${START_POSE.target.join(',')}]);`,
    );
    await sleep(120);

    await page.evaluate(RECORDER_SRC);
    const started = await page.evaluate('Boolean(window.__QMREC__)');
    if (!started) throw new Error('页面里装不上逐帧记录器(__QM__.director 不在?)');

    const reported = await page.evaluate(`window.__QM__.goSpot(${JSON.stringify(spot.id)})`);

    // 等 tween 结束 —— 这里只是**等待**,不参与判定。
    // 判定用的是记录序列里的 tweening 列,那个才是逐帧准确的。
    let waited = 0;
    for (;;) {
      const busy = await page.evaluate('window.__QM__.director.tweening');
      if (!busy) break;
      if ((waited += 100) > 15000) throw new Error(`景点 ${spot.id} 的补间超过 15s 还没结束`);
      await sleep(100);
    }
    await sleep(SETTLE_SEC * 1000);

    const samples = await page.evaluate('window.__QMREC__.stop()');
    const r = analyse(samples, spot.view);

    if (!r.ok) {
      checks.push({
        name: `${spot.name} 切换`,
        ok: false,
        detail: r.reason,
      });
      continue;
    }

    // 一条景点一条断言 —— 三个判据合起来才是"平滑切换"的完整含义,
    // 拆成三条会让人以为可以只满足其中一条。
    const parts = [];
    let pass = true;

    const c1 = r.errFinal < LIMIT.errFinal;
    pass &&= c1;
    parts.push(`终点误差 ${r.errFinal.toFixed(4)}m${c1 ? '' : ` ≥ ${LIMIT.errFinal}`}`);

    const c2 = r.tailVar < LIMIT.tailVar;
    pass &&= c2;
    parts.push(`末 0.3s 方差 ${r.tailVar.toExponential(2)}${c2 ? '' : ` ≥ ${LIMIT.tailVar}`}`);

    const c3 = r.regressions === 0 && r.worstRegression <= LIMIT.regression;
    pass &&= c3;
    parts.push(
      `回退 ${r.regressions} 帧/最大 ${r.worstRegression.toExponential(2)}m`,
    );

    const c4 = r.settleMax < LIMIT.settle;
    pass &&= c4;
    parts.push(`到位后摆动 ${(r.settleMax * 1000).toFixed(2)}mm${c4 ? '' : ' ≥ 10mm'}`);

    const c5 = r.tweenFrames >= LIMIT.minTweenFrames;
    pass &&= c5;
    parts.push(`${r.tweenFrames} 帧 / ${r.tweenMs}ms${c5 ? '' : ' 帧数不足'}`);

    checks.push({ name: `${spot.name} 切换`, ok: pass, detail: parts.join('；'), raw: r });
    records.push({ id: spot.id, reportedDistance: reported, ...r });
  }

  return { checks, records };
}

// --------------------------------------------------------------------------
// 委派:别的脚本跑的组,结果并进来
// --------------------------------------------------------------------------

/**
 * 每个被委派的脚本各跑一次,把断言按**组标签**归位。
 *
 * ⚠️ `tagToGroup` 为空、而有 `wholeGroup` 的,表示该脚本不分组建断言 ——
 *    它的全部断言算作那一组。`verify_camera.mjs` 就是这种:它写的
 *    json 结构(`results[].pass`)与探针的(`checks[].ok`)也不一样,
 *    所以归一化放在各自的 `normalize` 里,而不是在汇总处写一堆 if。
 */
const DELEGATES = [
  {
    key: 'verify_camera',
    script: 'tools/perf/verify_camera.mjs',
    json: 'screenshots/web/stage1_camera.json',
    extraArgs: [],
    jsonArg: false,
    wholeGroup: 1,
    tagToGroup: {},
    normalize: (raw) =>
      (raw.results ?? []).map((r) => ({ name: r.name, ok: Boolean(r.pass), detail: r.detail ?? '' })),
  },
  {
    key: 'probe_ui',
    script: 'tools/perf/probe_ui.mjs',
    json: 'screenshots/perf/probe_ui.json',
    extraArgs: ['--out', 'screenshots/web'],
    jsonArg: true,
    wholeGroup: null,
    tagToGroup: { '③': 3, '④': 4, '⑤': 5, '⑥': 6, '⑦': 7, '⑧': 8 },
    // 不属于八组、但属于阶段 3 出口的检查(桌面无溢出、无控制台异常)
    extraTags: ['布局', '控制台'],
    normalize: (raw) =>
      (raw.checks ?? []).map((c) => ({
        group: c.group,
        name: c.name,
        ok: Boolean(c.ok),
        detail: c.detail ?? '',
      })),
  },
  {
    // 窄屏那一半的出口证据。**整组都不归八组**,一条 tagToGroup 都没有 ——
    // 所以必须写 `always`,否则下面的 relevant 判定会算出"没有需要的组"而**跳过它**,
    // 报告上却不会少任何一行(它本来就不进八组的计数)。跳过 = 静默通过。
    key: 'probe_mobile',
    script: 'tools/perf/probe_mobile.mjs',
    json: 'screenshots/perf/probe_mobile.json',
    extraArgs: ['--out', 'screenshots/mobile'],
    jsonArg: true,
    wholeGroup: null,
    tagToGroup: {},
    extraTags: ['响应式'],
    always: true,
    normalize: (raw) =>
      (raw.checks ?? []).map((c) => ({
        group: c.group,
        name: c.name,
        ok: Boolean(c.ok),
        detail: c.detail ?? '',
      })),
  },
  {
    // 配乐引擎的**引擎级**验收。⑥ 组里那几条是"页面上点了有声音",
    // 这里量的是页面量不到的东西:离线渲染的 PCM 基频、IR 的 L2 范数、
    // 两次渲染是否逐位相同、worklet 走 ?url 还是内联 Blob 回退。
    //
    // ⚠️ 自带页面(`passUrl: false`):它构建并起 tools/audio_probe/ 那个探针页。
    //    早先的理由是"主入口还没接引擎,dist/ 里不会有 worklet 资源"——
    //    那个理由**已经过期了**(引擎现已接入,dist/assets/ 下确实有
    //    pluck-processor-*.js)。现在留着它的理由是页面量不到的那些量,
    //    不是为了绕开资源缺失。
    key: 'probe_audio',
    script: 'tools/probe_audio.mjs',
    json: 'screenshots/perf/probe_audio.json',
    extraArgs: [],
    jsonArg: true,
    passUrl: false,
    wholeGroup: null,
    tagToGroup: {},
    extraTags: ['音频'],
    always: true,
    normalize: (raw) =>
      (raw.checks ?? []).map((c) => ({
        group: c.group ?? '音频',
        name: c.name,
        ok: Boolean(c.ok),
        detail: c.detail ?? '',
      })),
  },
];

/** 跑一个被委派的脚本,读回它写的 json。**永远不抛**,失败记在返回值里。 */
async function runDelegate(spec) {
  // `passUrl: false` 给自带页面的探针用(音频探针自己构建并起一个探针页,
  // 它根本不认 --url)。硬塞给它会被静默忽略 —— 但那样"这个脚本在测哪一页"
  // 就读不出来了,不如把这件事在登记表里写清楚。
  const argv = [spec.script, ...(spec.passUrl === false ? [] : ['--url', args.url]), ...spec.extraArgs];
  if (spec.jsonArg) argv.push('--json', spec.json);
  const out = { ok: false, checks: [], extras: [], exit: null, log: '', error: null };

  await new Promise((done) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (buf) => {
      out.log += buf.toString();
      if (out.log.length > 200000) out.log = out.log.slice(-200000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => {
      out.error = `起不了子进程:${e.message}`;
      done();
    });
    child.on('close', (code) => {
      out.exit = code;
      done();
    });
  });

  try {
    const raw = JSON.parse(await readFile(resolve(ROOT, spec.json), 'utf8'));
    for (const c of spec.normalize(raw)) {
      const g = spec.wholeGroup ?? spec.tagToGroup[c.group];
      // ⚠️ `group` 放在展开**之后**:探针归一化出来的 `c` **自带** `group`
      //    (值就是它印的那个中文圈码,'③')。写成 `{ group: g, ...c }` 会被 c 里的
      //    '③' 覆盖掉映射后的数字 3,后面按 `c.group === g.id` 归位就永远是 false,
      //    八组里的 3~8 会全部变成「断言缺失」。第 1 组是唯一幸免的 ——
      //    verify_camera 的 normalize 不产出 group,没有东西去覆盖 `g`。
      if (g) out.checks.push({ ...c, group: g });
      else if ((spec.extraTags ?? []).includes(c.group)) out.extras.push(c);
    }
    out.ok = true;
  } catch (e) {
    out.error =
      out.error ??
      `读不到 ${spec.json}(${e.message})—— 子脚本退出码 ${out.exit}` +
        (out.exit === 2 ? ',它自己异常终止了' : '');
  }
  return out;
}

// --------------------------------------------------------------------------
// 组登记表
// --------------------------------------------------------------------------

/**
 * ⚠️ 未实现的组必须留在这里并标 `ready: false`。
 *    删掉它们会让"八组"缩水成"一组",而报告上完全看不出来 ——
 *    这正是"报告数字自己和自己不矛盾"要防的那类事。
 *
 * `where` 写清这一组的断言**跑在哪个脚本里**,读报告的人不必猜。
 */
const GROUPS = [
  { id: 1, title: '环视/缩放/右键平移/键盘', ready: true, where: 'tools/perf/verify_camera.mjs' },
  { id: 2, title: '五景点平滑切换', ready: true, where: '本文件(逐帧采样)', run: group2 },
  { id: 3, title: '标签→简介→走近看看', ready: true, where: 'tools/perf/probe_ui.mjs [③]' },
  { id: 4, title: '舆图定位/横卷/复原依据', ready: true, where: 'tools/perf/probe_ui.mjs [④]' },
  { id: 5, title: '时辰/画质/动画·标签·线框', ready: true, where: 'tools/perf/probe_ui.mjs [⑤]' },
  { id: 6, title: '巡游/隐藏界面/全屏/配乐', ready: true, where: 'tools/perf/probe_ui.mjs [⑥]' },
  { id: 7, title: '真实进度 + 错误提示', ready: true, where: 'tools/perf/probe_ui.mjs [⑦]' },
  { id: 8, title: '相机稳定性', ready: true, where: 'tools/perf/probe_ui.mjs [⑧]' },
];

// --------------------------------------------------------------------------
// 跑
// --------------------------------------------------------------------------

const want = args.only ? new Set(args.only) : null;
const selected = GROUPS.filter((g) => !want || want.has(g.id));
const needGroup = (id) => selected.some((g) => g.id === id);

/**
 * 这个委派本次要不要跑。
 *
 * ⚠️ 三件事必须都认:`wholeGroup`(整脚本算一组)、`tagToGroup`(按组标签归位)、
 * 以及 `always`(零分组的出口证据)。只认前两条的话,一个 `wholeGroup: null` +
 * `tagToGroup: {}` 的委派**永远不会跑**,而它本来就不进八组的通过率 ——
 * 于是它既没跑、也没人看得出来它没跑。这就是 `always` 存在的唯一理由。
 */
const delegateRelevant = (spec) =>
  Boolean(spec.always) ||
  (spec.wholeGroup !== null
    ? needGroup(spec.wholeGroup)
    : Object.values(spec.tagToGroup).some(needGroup));

console.log('═'.repeat(96));
console.log('阶段 3 功能验证 —— 每组:一串脚本动作 + 一条状态断言');
console.log('═'.repeat(96));
const runningDelegates = DELEGATES.filter(delegateRelevant);
console.log(`  断言来源:本文件 ${selected.filter((g) => g.run).length} 组` +
  `,委派 ${runningDelegates.length} 个脚本` +
  `(${runningDelegates.map((d) => d.key).join(', ')})` +
  `,其中不计入八组、只作出口证据的:${runningDelegates.filter((d) => d.always).map((d) => d.key).join(', ') || '无'}`);

const allChecks = [];
const groupRecords = {};
let browser = null;

// —— 先把被委派的脚本各跑一次 ——
const delegated = new Map();
for (const spec of DELEGATES) {
  if (!delegateRelevant(spec)) continue;
  process.stdout.write(`\n▶ 运行 ${spec.script} …`);
  const t0 = Date.now();
  const r = await runDelegate(spec);
  console.log(` 完成(${((Date.now() - t0) / 1000).toFixed(1)}s,退出码 ${r.exit})`);
  if (r.error) console.log(`    ⚠️ ${r.error}`);
  // ⚠️ 零分组委派(`always`)的断言**只**以 extras 的身份进汇总,而 extras 的分母
  //    就是它自己产出的条数 —— 所以它一条都不产出时,`extraPass === extras.length`
  //    仍然成立,整轮照样报 ✅。子脚本崩了、json 读不到、标签改名了,都会走到这里。
  //    这类委派本来就是"出口证据",没证据就是没通过,不给它静默消失的余地。
  if (spec.always && (!r.ok || !r.extras.length)) {
    r.extras.push({
      group: spec.extraTags?.[0] ?? '?',
      name: `${spec.key} 没能产出任何出口证据`,
      ok: false,
      detail:
        (r.error ?? `退出码 ${r.exit},但 json 里没有一条带 ${JSON.stringify(spec.extraTags ?? [])} 标签的断言`) +
        ' —— 这条检查在报告上会像"通过"一样安静,所以它自己必须报出来',
    });
    console.log(`    ✗ ${spec.key} 一条出口证据都没产出(${r.error ? 'json 读不到' : `退出码 ${r.exit}`})`);
  }
  delegated.set(spec.key, r);
}

// 探针自己印的每一行都在这儿。直接转发太长(七十多行),但失败项必须露出来 ——
// 否则"✗"只有一个名字,定位要靠再跑一次。
for (const [key, r] of delegated) {
  const bad = [...r.checks, ...r.extras].filter((c) => !c.ok);
  if (!bad.length) continue;
  console.log(`\n  ${key} 的失败明细:`);
  for (const c of bad) console.log(`    ✗ [${c.group ?? '?'}] ${c.name} —— ${c.detail}`);
}

try {
  for (const g of selected) {
    if (!g.ready) {
      console.log(`\n[${g.id}] ${g.title}`);
      console.log(`    ⏸ 未实现 —— ${g.note}`);
      continue;
    }
    if (!g.run) {
      // 委派来的组:断言不在这里跑,但结果并进同一张表。
      console.log(`\n[${g.id}] ${g.title}`);
      console.log(`    ↪ 断言在 ${g.where}`);

      // ⚠️ 委派过来的组,如果一条断言都没有,算**失败**,不算通过。
      //    子脚本崩了、或者那段断言被删了,都会走到这条分支。
      const got = [];
      for (const r of delegated.values()) {
        for (const c of r.checks) if (c.group === g.id) got.push({ ...c, src: r });
      }
      if (!got.length) {
        const why =
          [...delegated.values()].find((r) => r.error)?.error ??
          '委派的脚本没有为这一组产出任何断言(是不是被删掉了?)';
        allChecks.push({ group: g.id, name: `${g.title} —— 断言缺失`, ok: false, detail: why });
        console.log(`    ✗ 没有断言进来 —— ${why}`);
        continue;
      }
      for (const c of got) {
        allChecks.push({ group: g.id, name: c.name, ok: c.ok, detail: c.detail });
        console.log(`    ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` —— ${c.detail}` : ''}`);
      }
      const gf = got.filter((c) => !c.ok).length;
      console.log(`    ── ${got.length - gf}/${got.length} 通过`);
      continue;
    }

    console.log(`\n[${g.id}] ${g.title}`);

    // 每组一个干净的页面,避免上一组的状态(相机位置、画质)渗进来。
    if (browser) await browser.close();
    browser = await launch({ width: args.width, height: args.height });
    const page = browser.page;
    await page.goto(args.url);
    await page.waitForReady({ timeout: 120000 });

    const t0 = Date.now();
    const { checks, records } = await g.run(page);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);

    for (const c of checks) {
      allChecks.push({ group: g.id, ...c });
      console.log(`    ${c.ok ? '✓' : '✗'} ${c.name.padEnd(10)} ${c.detail}`);
      if (c.raw && !c.ok) {
        // 失败时把关键中间量摊开,不然只有一个"✗"没法定位
        console.log(
          `        起点 (${c.raw.start.map((v) => v.toFixed(3)).join(', ')})` +
            ` → 终点 (${c.raw.final.map((v) => v.toFixed(3)).join(', ')})` +
            ` 目标 (${c.raw.dest.map((v) => v.toFixed(3)).join(', ')})`,
        );
      }
    }
    if (records) groupRecords[g.id] = records;

    const gf = checks.filter((c) => !c.ok).length;
    console.log(`    ── ${checks.length - gf}/${checks.length} 通过,用时 ${dt}s`);
  }
} finally {
  if (browser) await browser.close();
}

// --------------------------------------------------------------------------
// 汇总
// --------------------------------------------------------------------------

const pass = allChecks.filter((c) => c.ok).length;
const fail = allChecks.filter((c) => !c.ok).length;
const notImpl = GROUPS.filter((g) => !g.ready).length;

// 不属于八组、但同样在阶段 3 出口条件里的检查
const extras = [...delegated.values()].flatMap((r) => r.extras);
const extraPass = extras.filter((c) => c.ok).length;

console.log('\n' + '═'.repeat(96));
console.log('汇总');
console.log('─'.repeat(96));
console.log(
  `  已实现的组:${GROUPS.filter((g) => g.ready).length} / ${GROUPS.length}` +
    `(第 1 组的断言在 verify_camera.mjs 里)`,
);
console.log(`  断言:通过 ${pass} / 失败 ${fail}`);
// 按标签合并成 "标签 通过/总数" —— 移动端那 16 条全叫「响应式」,
// 逐条印出来是十六个一模一样的 "✓响应式",看不出到底检了几件事、哪一类。
const extraByTag = new Map();
for (const c of extras) {
  const e = extraByTag.get(c.group) ?? { pass: 0, total: 0 };
  e.total += 1;
  if (c.ok) e.pass += 1;
  extraByTag.set(c.group, e);
}
console.log(
  `  阶段出口附加检查(不算八组之内):通过 ${extraPass} / ${extras.length}` +
    `  ${[...extraByTag].map(([t, e]) => `${t} ${e.pass}/${e.total}`).join(' · ')}`,
);
// 失败了才把名字摊开 —— 通过时列 18 行名字没人看,失败时缺一行就没法定位。
for (const c of extras) {
  if (!c.ok) console.log(`      ✗ [${c.group}] ${c.name} —— ${c.detail}`);
}
console.log(`  未实现的组:${notImpl}  ${GROUPS.filter((g) => !g.ready).map((g) => g.id).join('、')}`);

// ⚠️ 自洽性:每条断言要么算通过要么算失败。对不上说明有分支被漏掉了 ——
//    报告工具自己报出矛盾的数字,比直接报错更糟。
if (allChecks.length !== pass + fail) {
  console.error(`❌ 报告自身不一致:${allChecks.length} 条断言,只计了 ${pass + fail} 条。`);
  process.exit(2);
}

// 逐景点实测值的完整摊开 —— 报告里的数都在这儿,便于复核
if (groupRecords[2]) {
  console.log('\n第二组实测明细(补间逐帧采样):');
  console.log(
    '  景点'.padEnd(10) +
      '距离m'.padEnd(9) +
      '时长ms'.padEnd(9) +
      '帧'.padEnd(6) +
      '采样fps'.padEnd(9) +
      '终点误差m'.padEnd(12) +
      '末0.3s方差'.padEnd(14) +
      '末窗帧'.padEnd(8) +
      '到位后摆动mm',
  );
  for (const r of groupRecords[2]) {
    console.log(
      '  ' +
        String(r.id).padEnd(8) +
        r.reportedDistance.toFixed(2).padEnd(9) +
        String(r.tweenMs).padEnd(9) +
        String(r.tweenFrames).padEnd(6) +
        String(r.fps).padEnd(9) +
        r.errFinal.toFixed(4).padEnd(12) +
        r.tailVar.toExponential(2).padEnd(14) +
        String(r.tailFrames).padEnd(8) +
        (r.settleMax * 1000).toFixed(2),
    );
  }
  console.log(
    '  ⚠️ 采样率不是 60Hz:无头 Chrome 没有垂直同步,rAF 跑到约 160Hz。' +
      '所以「末 0.3s」窗口里有 49 帧,不是 18 帧 —— 帧数要按实际读,不能按 60Hz 估。',
  );
}

console.log('─'.repeat(96));
if (fail > 0) {
  console.log(`❌ ${fail} 条断言未通过`);
} else if (notImpl > 0) {
  console.log(
    `⏸ 已实现的组全部通过,但还有 ${notImpl} 组没做 —— 阶段 3 的出口是八组全绿,` +
      `现在**不能**算过。`,
  );
} else if (extras.length && extraPass !== extras.length) {
  console.log(
    `❌ 八组全绿,但阶段出口的附加检查有 ${extras.length - extraPass} 条没过` +
      `(${extras.filter((c) => !c.ok).map((c) => `${c.group}:${c.name}`).join(';')})`,
  );
} else {
  console.log(`✅ 八组全部通过${extras.length ? `,附加检查 ${extraPass}/${extras.length}` : ''}`);
}
console.log('═'.repeat(96));

if (args.json) {
  const out = resolve(ROOT, args.json);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        url: args.url,
        viewport: [args.width, args.height],
        limits: LIMIT,
        groups: GROUPS.map((g) => ({
          id: g.id,
          title: g.title,
          ready: g.ready,
          where: g.where ?? null,
        })),
        checks: allChecks.map(({ raw, ...c }) => c),
        extras,
        detail: groupRecords,
        summary: {
          pass,
          fail,
          notImplemented: notImpl,
          extrasPass: extraPass,
          extrasTotal: extras.length,
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log(`明细已写入 ${args.json}`);
}

process.exit(fail === 0 && notImpl === 0 && extraPass === extras.length ? 0 : 1);
