#!/usr/bin/env node
/**
 * 上下文丢失的出口验证 —— 阶段 4 的最后一项。
 *
 * 这一条为什么非测不可
 * --------------------
 * WebGL 上下文会被外部原因拿掉(驱动重置、休眠唤醒、GPU 进程崩溃)。
 * 丢掉的后果特别坏:**画面永久停在最后一帧,页面不报错,控制台干净**。
 * 所以它没法靠"看一眼截图"发现 —— 一张静止的截图和"程序卡死"长得一模一样。
 * 唯一的办法是主动把上下文打掉,然后**读守卫的状态**。
 *
 * 判据分四段,缺一段都不算过
 * --------------------------
 *   A 前置     页面就绪、真 GPU、基线画面非空白
 *   B 丢失     守卫标志 / store 同步 / **最后一次 setAnimationLoop 传的是 null**
 *   C 恢复     逐项重建**真的跑完** / resetTimer 生效 / dispose 调用数为 0 / 画面回来了
 *   D 超时     等不到恢复时遮罩给出「刷新页面」这条唯一的出路
 *
 * ⚠️ 三条断言为什么长这样(都是"别把手段当目的"的具体化)
 *
 * ① B 段不停留在 `loopRunning === false`。
 *    "循环停了"会因为**别的原因**成立 —— `measureStageCost()` 与
 *    `measureFrameCost()` 都会先 stop 再 start。拿它当"上下文丢了"的证据,
 *    是拿一个含义更宽的仪表去量一件更窄的事。所以这里改成直接监听
 *    `renderer.setAnimationLoop` 的调用记录,断言**丢失之后最后一次调用
 *    的实参是 null** —— 那正是计划里写的"`setAnimationLoop(null)`"。
 *
 * ② C 段不停留在"重建钩子被调了"。
 *    钩子被调 ≠ PMREM 真的重烘了。所以读 `skyTime.environmentRevision`,
 *    而那个计数器**只在 `update()` 真正走完重建分支时才 +1**
 *    (见 `world/skyTime.ts` 里的说明)—— 调一下 setter 骗不过它。
 *
 * ③ C 段的首帧 dt 必须是**量出来的数**,不是"循环又跑起来了"。
 *    首帧 dt 是整个丢失时长的这件事会被 `MAX_DT` 钳到 50ms —— 画面不跳,
 *    只是动画白白慢半拍,肉眼看不出来。所以 `dt == 50` 恰好是
 *    "resetTimer 没生效"的指纹,断言必须是 `< 50` 这个能失败的判据。
 *
 * ④ "画面回来了"这一条必须配**负对照**,而且措辞不许超出仪表的能力。
 *    首次跑出来的 Δrgb=(0,0,0) 看着像逐像素复原,实际不是 ——
 *    我另写了一次性脚本(`tools/perf/once/sample_sensitivity.mjs`)量它的
 *    灵敏度:不碰上下文、隔 3 秒采两次,均色同样 Δ=(0,0,0),
 *    而同期人物走了 1.0~1.3m。整帧均色对动态内容**不敏感**。
 *    所以判据写成"整体色调一致",并配上 B 段的负对照
 *    (丢失期间绘图缓冲实测 0×0)—— 两条合起来,"画面回来了"才是
 *    一句能被证伪的话,而不是一句听起来很好的话。
 *
 * 用法:
 *   node tests/context_loss.mjs
 *   node tests/context_loss.mjs --url http://127.0.0.1:4173/ --json screenshots/perf/context_loss.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { launch, sleep } from '../tools/perf/lib/cdp.mjs';

// --------------------------------------------------------------------------
// 参数
// --------------------------------------------------------------------------

const args = {
  url: 'http://127.0.0.1:4173/',
  json: 'screenshots/perf/context_loss.json',
  width: 1600,
  height: 900,
  shotDir: 'screenshots/web',
};

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--url') args.url = process.argv[++i];
  else if (a === '--json') args.json = process.argv[++i];
  else if (a === '--shot-dir') args.shotDir = process.argv[++i];
}

const ROOT = resolve(process.cwd());

/**
 * 守卫的超时阈值(毫秒)。必须与 `installContextGuard` 的默认值一致 ——
 * D 段就是靠它来定"等多久才算超时"。
 *
 * ⚠️ 这个数是从产品代码里**抄来的**,不是量出来的。所以下面除了断言
 *    "超时被报出来",还打印**实测等了多久**,两者对不上就是这里抄错了。
 */
const GUARD_TIMEOUT_MS = 8000;

// --------------------------------------------------------------------------
// 断言表
// --------------------------------------------------------------------------

const checks = [];

function check(stage, name, ok, detail) {
  checks.push({ stage, name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  const tag = ok ? '✓' : '✗';
  console.log(`  ${tag} [${stage}] ${name}${detail === undefined ? '' : ` —— ${detail}`}`);
  return Boolean(ok);
}

// --------------------------------------------------------------------------
// 页面内小工具
// --------------------------------------------------------------------------

/**
 * 装上三样记录器:
 *   ① `renderer.setAnimationLoop` 的调用记录 —— B 段的判据来源;
 *   ② 所有 `dispose` 的调用计数 —— C 段的"不许越过的线";
 *   ③ `skyTime.environmentRevision` 的初值。
 *
 * ⚠️ 记录器必须在**丢失之前**装好。反过来的话,丢失与恢复之间有没有
 *    调过 setAnimationLoop(null) 就只能靠猜 —— 而那正是这条断言要问的事。
 */
const INSTALL = () => {
  const r = window.__QM__.renderer;
  window.__probe = { animCalls: [], disposeCalls: [], envRevBefore: window.__QM__.skyTime.environmentRevision };

  const origLoop = r.setAnimationLoop.bind(r);
  r.setAnimationLoop = (cb) => {
    window.__probe.animCalls.push(cb === null || cb === undefined ? 'null' : typeof cb);
    return origLoop(cb);
  };

  const origRendererDispose = r.dispose.bind(r);
  r.dispose = () => {
    window.__probe.disposeCalls.push('renderer');
    return origRendererDispose();
  };

  const T = window.__QM__.THREE;
  const targets = [
    ['BufferGeometry', T.BufferGeometry],
    ['Material', T.Material],
    ['Texture', T.Texture],
    ['WebGLRenderTarget', T.WebGLRenderTarget],
    ['Object3D', T.Object3D],
  ];
  for (const [name, ctor] of targets) {
    if (!ctor || !ctor.prototype || typeof ctor.prototype.dispose !== 'function') continue;
    const orig = ctor.prototype.dispose;
    ctor.prototype.dispose = function (...a) {
      window.__probe.disposeCalls.push(name);
      return orig.apply(this, a);
    };
  }

  // SkyTime 是类实例,dispose 挂在原型上 —— 装一个同名自有属性把它挡住
  const st = window.__QM__.skyTime;
  const origSkyDispose = st.dispose.bind(st);
  st.dispose = () => {
    window.__probe.disposeCalls.push('SkyTime');
    return origSkyDispose();
  };

  return true;
};

const PROBE = () => ({
  ...window.__probe,
  envRev: window.__QM__.skyTime.environmentRevision,
});

const GPU = () => window.__QM__.gpuRuntime();
const CANVAS = () => window.__QM__.sampleCanvas();

/** 等某个条件成立。超时返回 false,不抛 —— 抛了会把"没发生"报成"脚本错了"。 */
async function waitFor(page, expr, { timeout = 12000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await page.evaluate(expr).catch(() => null);
    if (v) return true;
    await sleep(pollMs);
  }
  return false;
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

const t0 = Date.now();
console.log('═'.repeat(96));
console.log('上下文丢失验证 —— 阶段 4 出口');
console.log(`页面 ${args.url}`);
console.log('═'.repeat(96));

const { page, close: closeBrowser, browserVersion } = await launch({
  width: args.width,
  height: args.height,
});

let fatal = null;
let baseline = null;
let afterRestore = null;
let diag = {};

try {
  await page.goto(args.url);
  await page.waitForReady({ timeout: 120000 });

  // 只等一帧,让 HUD 与标签都落定。截图与采样要的是稳态。
  await sleep(1200);

  // ─────────────────────────── A 前置 ───────────────────────────
  console.log('\nA 前置');

  const gpu0 = await page.evaluate(
    `(() => ({ renderer: window.__QM__.gpu.renderer, isSoftware: window.__QM__.gpu.isSoftware }))()`,
  );
  // ⚠️ 软件渲染下这一整套毫无意义 —— SwiftShader 的上下文丢失语义与真 GPU
  //    不同,而且"恢复后画面回来了"也不能说明真机上没问题。
  //    所以先拒一次,而不是测完了再补一句"数据可能不可信"。
  check(
    'A',
    '渲染器是真 GPU(不是 SwiftShader)',
    !gpu0.isSoftware && /ANGLE|NVIDIA|AMD|Intel/i.test(gpu0.renderer),
    gpu0.renderer,
  );

  baseline = await page.evaluate(CANVAS);
  check(
    'A',
    '基线画面非空白',
    baseline.stdDev > 3 && baseline.nonUniformRatio > 0.3,
    `stdDev=${baseline.stdDev} 非背景像素占比=${baseline.nonUniformRatio} 均色=rgb(${baseline.meanColor.join(',')})`,
  );

  await page.screenshot(resolve(ROOT, args.shotDir, 'context_loss_before.png'));
  await page.evaluate(INSTALL);

  // ─────────────────────────── B 丢失 ───────────────────────────
  console.log('\nB 丢失');

  await page.evaluate('window.__QM__.renderer.forceContextLoss()');

  const lostSeen = await waitFor(page, 'window.__QM__.gpuRuntime().contextLost');
  check('B', '守卫进入丢失状态', lostSeen, `lostCount=${(await page.evaluate(GPU)).lostCount}`);

  const gLost = await page.evaluate(GPU);
  check(
    'B',
    'store 同步(gpu.contextLost=true,lostCount+1)',
    gLost.storeLost === true && gLost.storeLostCount === 1,
    `storeLost=${gLost.storeLost} lostCount=${gLost.storeLostCount}`,
  );

  const probeLost = await page.evaluate(PROBE);
  check(
    'B',
    '最后一次 setAnimationLoop 传的是 null',
    probeLost.animCalls[probeLost.animCalls.length - 1] === 'null',
    `调用序列 [${probeLost.animCalls.join(', ')}]`,
  );

  const glLost = await page.evaluate('window.__QM__.renderer.getContext().isContextLost()');
  check('B', 'gl.isContextLost() === true', glLost === true, String(glLost));

  // —— 负对照 ——
  //
  // ⚠️ 这一条是给 C 段的"画面回来了"配上能失败的可能。
  //    没有它的话,C 段那个 `stdDev > 3` 只是"看起来不像黑屏",
  //    而"丢失期间读数本来是什么"从没量过 —— 万一丢失期间 `sampleCanvas()`
  //    同样返回 64.7,那个判据就什么也没测。
  //    实测:丢失期间绘图缓冲是 **0×0**,所以 C 段的判断力是真的。
  const glSize = await page.evaluate(
    `(() => { const gl = window.__QM__.renderer.getContext();
              return { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight }; })()`,
  );
  check(
    'B',
    '丢失期间绘图缓冲为 0×0(负对照)',
    glSize.w === 0 && glSize.h === 0,
    `${glSize.w}×${glSize.h}`,
  );

  const gLost2 = await page.evaluate(GPU);
  check(
    'B',
    '遮罩显示出来且说了人话',
    gLost2.veilVisible === true && gLost2.gpuBoxVisible === true,
    `veil=${gLost2.veilVisible} gpuBox=${gLost2.gpuBoxVisible}`,
  );

  const lostText = await page.evaluate(
    `(document.querySelector('.veil__gpu')?.innerText || '').replace(/\\s+/g, ' ').trim()`,
  );
  check(
    'B',
    '丢失文案提到「图形上下文」并给出按钮',
    /图形上下文/.test(lostText) && /刷新页面/.test(lostText),
    `"${lostText.slice(0, 80)}…"`,
  );

  await page.screenshot(resolve(ROOT, args.shotDir, 'context_loss_lost.png'));

  // ─────────────────────────── C 恢复 ───────────────────────────
  console.log('\nC 恢复');

  const tRestore = Date.now();
  await page.evaluate('window.__QM__.renderer.forceContextRestore()');

  const backSeen = await waitFor(page, '!window.__QM__.gpuRuntime().contextLost');
  check('C', '守卫退出丢失状态', backSeen, `等了 ${Date.now() - tRestore}ms`);

  const gBack = await page.evaluate(GPU);
  check(
    'C',
    'store 同步(restoredCount=1、loopRunning=true)',
    gBack.storeRestoredCount === 1 && gBack.loopRunning === true,
    `restoredCount=${gBack.storeRestoredCount} loopRunning=${gBack.loopRunning} 中断=${gBack.lastOutageMs}ms`,
  );

  const hookNames = (gBack.lastRebuild || []).map((r) => r.name);
  const failedHooks = (gBack.lastRebuild || []).filter((r) => !r.ok);
  // ⚠️ 断言的是"**两项都报了结果且都成功**",不是"钩子数组非空"。
  //    空数组在"一项都没跑"和"跑了但没记"两种情况下长得一样。
  check(
    'C',
    '两项重建都跑了且都成功',
    (gBack.lastRebuild || []).length === 2 && failedHooks.length === 0,
    hookNames.length
      ? hookNames.join('、') +
          (failedHooks.length ? ` —— 失败:${failedHooks.map((f) => `${f.name}(${f.error})`).join(';')}` : '')
      : 'lastRebuild 是空的',
  );

  // 给重建钩子一帧的时间跑完(环境贴图是在下一帧的 skyTime.update 里重烘的)
  await sleep(600);

  const probeBack = await page.evaluate(PROBE);
  check(
    'C',
    '环境贴图真的重烘了(environmentRevision 增长)',
    probeBack.envRev > probeBack.envRevBefore,
    `重建前 ${probeBack.envRevBefore} → 重建后 ${probeBack.envRev}`,
  );

  // 首帧 dt:先等到循环确实又跑了几帧,再读最近一帧
  await sleep(400);
  const gDt = await page.evaluate(GPU);
  check(
    'C',
    '恢复后首帧 dt < 50ms(resetTimer 生效)',
    typeof gDt.lastFrameDtMs === 'number' && gDt.lastFrameDtMs < 50,
    `最近一帧 dt=${gDt.lastFrameDtMs}ms(丢失中断 ${gBack.lastOutageMs}ms;dt 等于 50 就是被 MAX_DT 钳住了)`,
  );

  check(
    'C',
    '丢失路径上 **没有** 调用任何 dispose',
    probeBack.disposeCalls.length === 0,
    probeBack.disposeCalls.length === 0
      ? '0 次(几何与贴图的 CPU 侧数据必须留着,恢复靠的就是重新上传它们)'
      : `被调了 ${probeBack.disposeCalls.length} 次:${probeBack.disposeCalls.join(', ')}`,
  );

  afterRestore = await page.evaluate(CANVAS);
  check(
    'C',
    '恢复后画面回来了(不是黑屏/空白)',
    afterRestore.stdDev > 3 && afterRestore.nonUniformRatio > 0.3,
    `stdDev=${afterRestore.stdDev} 非背景像素占比=${afterRestore.nonUniformRatio} 均色=rgb(${afterRestore.meanColor.join(',')})`,
  );

  // ⚠️ 逐通道比均色,并**分开报**三个通道。
  //    合成一个"总亮度"的话,环境贴图没烘上(整体发黑)与水面没重画
  //    (只有河那一块不对)会得到同一个数 —— 而这两件事的修法完全不同。
  // ⚠️ **这条断言的名字必须说到做到,不能多一个字。**
  //
  //    首次跑出来 Δrgb=(0,0,0),看着像"逐像素复原成功"。我去量了这套
  //    聚合量到底有多灵敏(`tools/perf/once/sample_sensitivity.mjs`):
  //    同一个页面**不碰上下文**,隔 1.5s / 3.0s 各采一次,均色也是
  //    rgb(142,140,135) → Δ=(0,0,0);而同一段时间里人物实际走了
  //    1.0~1.3 米。也就是说整帧均色对画面里的小尺度变化**完全不敏感** ——
  //    几十万像素把它摊平了。
  //
  //    所以 Δ=0 只能说明"整体色调没变",**不能**说明"画面一模一样"。
  //    把它写成后者,就是又一次拿量具的读数当作品的性质 ——
  //    这个项目里已经栽过很多次的那种。判据留在这里,措辞按它真能证明的写。
  const dRgb = afterRestore.meanColor.map((v, i) => Math.abs(v - baseline.meanColor[i]));
  check(
    'C',
    '恢复后整体色调与丢失前一致(不是逐像素一致,见下)',
    dRgb.every((d) => d <= 6),
    `Δrgb=(${dRgb.join(',')}) 基线=rgb(${baseline.meanColor.join(',')}) 恢复后=rgb(${afterRestore.meanColor.join(',')})` +
      ` —— ⚠️ 整帧均色对动态内容不敏感:实测隔 3 秒采两次也是 Δ=(0,0,0),` +
      `同期人物走了 1.0~1.3m。这条只证明"没发黑、没变蓝、整体色调没跑"。`,
  );

  await page.screenshot(resolve(ROOT, args.shotDir, 'context_loss_after.png'));

  // ─────────────────────────── D 超时路径 ───────────────────────────
  //
  // 这一段测的是现实中最常见的那种结局:**浏览器根本不恢复**。
  // 驱动重置、显存耗尽之后它就不再发 restored 事件了,而用户对着一动不动的
  // 画面会一直等下去 —— 界面上必须给他一条出路。
  console.log('\nD 超时路径');

  await page.evaluate('window.__QM__.renderer.forceContextLoss()');
  const lostAgain = await waitFor(page, 'window.__QM__.gpuRuntime().contextLost', { timeout: 4000 });
  check('D', '第二次丢失已被捕获', lostAgain, '');

  const tWait = Date.now();
  const timedOut = await waitFor(page, 'window.__QM__.gpuRuntime().storeTimedOut', {
    timeout: GUARD_TIMEOUT_MS + 4000,
    pollMs: 200,
  });
  const waitedMs = Date.now() - tWait;
  check(
    'D',
    `等不到恢复时报「超时」(阈值 ${GUARD_TIMEOUT_MS}ms)`,
    timedOut,
    `实测等待 ${waitedMs}ms`,
  );
  // ⚠️ 这一条是**校准**:上面那个阈值是从产品代码抄来的常数。抄错了
  //    (比如产品改成了 3 秒而这里还写 8 秒)会让 D 段变成一条谁也没在测的
  //    断言 —— 它照样会通过,因为它只等更久而已。所以额外对一次量级。
  check(
    'D',
    '实测等待时间与阈值同量级(没有抄错常数)',
    timedOut && waitedMs >= GUARD_TIMEOUT_MS * 0.5 && waitedMs <= GUARD_TIMEOUT_MS * 2 + 4000,
    `阈值 ${GUARD_TIMEOUT_MS}ms,实测 ${waitedMs}ms`,
  );

  const timedText = await page.evaluate(
    `(document.querySelector('.veil__gpu')?.innerText || '').replace(/\\s+/g, ' ').trim()`,
  );
  check(
    'D',
    '超时文案说明「没有恢复」并指向刷新',
    /没有恢复/.test(timedText) && /刷新/.test(timedText),
    `"${timedText.slice(0, 90)}…"`,
  );

  await page.screenshot(resolve(ROOT, args.shotDir, 'context_loss_timeout.png'));

  // 最后仍然恢复一次:证明超时**不是终局**,而且恢复后那个标志会被清掉 ——
  // 不清的话界面会一直停在三秒前的结论上,显示着"需要刷新"而画面其实好好的。
  await page.evaluate('window.__QM__.renderer.forceContextRestore()');
  const backAgain = await waitFor(page, '!window.__QM__.gpuRuntime().contextLost', { timeout: 12000 });
  const gFinal = await page.evaluate(GPU);
  check(
    'D',
    '超时后再恢复能成功,且超时标志被清掉',
    backAgain && gFinal.storeTimedOut === false && gFinal.storeLostCount === 2,
    `超时标志=${gFinal.storeTimedOut} lostCount=${gFinal.storeLostCount} restoredCount=${gFinal.storeRestoredCount}`,
  );

  await sleep(500);
  const finalCanvas = await page.evaluate(CANVAS);
  check(
    'D',
    '第二次恢复后画面仍然正常',
    finalCanvas.stdDev > 3 && finalCanvas.nonUniformRatio > 0.3,
    `stdDev=${finalCanvas.stdDev} 非背景像素占比=${finalCanvas.nonUniformRatio}`,
  );

  diag = {
    gpuLost: gLost,
    gpuBack: gBack,
    gpuFinal: gFinal,
    probeLost,
    probeBack,
    baseline,
    afterRestore,
    finalCanvas,
    lostText,
    timedText,
    browserVersion,
  };
} catch (err) {
  fatal = err;
  console.log(`\n❌ 运行中断:${err.message}`);
} finally {
  await closeBrowser();
}

// --------------------------------------------------------------------------
// 汇总
// --------------------------------------------------------------------------

const pass = checks.filter((c) => c.ok).length;
const fail = checks.length - pass;
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log('\n' + '─'.repeat(96));
for (const c of checks) {
  if (!c.ok) console.log(`  ✗ [${c.stage}] ${c.name} —— ${c.detail}`);
}
console.log('─'.repeat(96));
if (fatal) {
  console.log(`❌ 未跑完:${fatal.message}`);
} else if (fail === 0) {
  console.log(`✅ ${pass}/${checks.length} 条断言全部通过(${elapsed}s)`);
} else {
  console.log(`❌ ${fail}/${checks.length} 条断言未通过(${elapsed}s)`);
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
        guardTimeoutMs: GUARD_TIMEOUT_MS,
        elapsedSec: Number(elapsed),
        checks,
        summary: { pass, fail, fatal: fatal ? fatal.message : null },
        diag,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log(`明细已写入 ${args.json}`);
}

process.exit(fatal || fail > 0 ? 1 : 0);
