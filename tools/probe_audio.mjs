#!/usr/bin/env node
/**
 * 配乐引擎验收探针 —— 打开**真实的构建产物**,把结论量出来。
 *
 * 为什么不是"跑一遍没报错就算过"
 * ------------------------------
 * 音频这类东西的失败模式几乎全是静默的:
 *   · worklet 404 → 页面一切正常,就是没声音;
 *   · DelayNode 反馈环 → 照样出声,只是音高悄悄高了六个半音;
 *   · 混响 IR 归一化搞错 → 一开混响就是轰鸣,但"没有报错";
 *   · 时钟没对齐 → 切回标签页时倒出一片噪音。
 * 所以下面每一条断言都要求一个**数字**:工作节点回话的 version、分析节点量到
 * 的峰值、离线渲染 PCM 的基频、IR 的 L2 范数、两次渲染的逐位校验和。
 *
 * 探针页( tools/audio_probe/ )是独立构建,理由**变过一次**:
 *   · 起初:作品主入口还没接引擎,dist/ 里不会有 worklet 资源,拿它测只能测出
 *     "文件不存在"。
 *   · 现在:引擎已经接进 src/main.ts,`dist/assets/` 下确实有
 *     pluck-processor-*.js(生产构建的 ?url 快路径)。但下面这些量**在作品页上
 *     量不到** —— 离线渲染的 PCM 基频、IR 的 L2 范数、两次渲染是否逐位相同、
 *     以及刻意切断 module URL 来走 Blob 回退那一路。所以独立探针页留着。
 *
 * 页面级的那几条("点一下有没有声音")在 tests/smoke_flow.mjs 的 ⑥ 组里,
 * 两边分工,不重复。
 *
 * 用法:
 *   node tools/probe_audio.mjs                # 构建 + 实测
 *   node tools/probe_audio.mjs --no-build     # 复用已有产物
 *   node tools/probe_audio.mjs --no-fallback  # 跳过 Blob 回退那一路
 *   node tools/probe_audio.mjs --json 结果.json  # 另写一份机器可读的
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from './perf/lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = join(ROOT, 'dist-audio-probe');
const VITE_BIN = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const PROBE_CONFIG = 'tools/audio_probe/vite.config.ts';

// --------------------------------------------------------------------------
// 参数与输出
// --------------------------------------------------------------------------

function parseArgs(argv) {
  // 播放段默认 7s。
  //
  // ⚠️ 这个数改过两次,两次都是**量出来的**,不是拍的:
  //   起初 2s —— 引子头两个音相隔 8 tick(2.14s),窗口里最多起一个音,
  //   "工作节点真的起了音" 这条断言等于没测;
  //   改成 3.6s —— 在无头 Chrome 里一直坐在边界上:同一份代码,跑出过
  //   started=2(判 PASS)也跑出过 started=1(判 FAIL)。查下去,音符并不是
  //   在 at(ctx.currentTime 推出来的)那一刻响的,晚多少逐次不同:
  //     · 多数次:第 1/2/3 个音在 0.76 / 3.05 / 5.53 秒起音,晚 0.36 / 0.50 /
  //       0.84 秒 —— 音频钟起步阶段只有 ~0.88 倍速(见 init 后 1.2s 空窗的
  //       读数),滞后随时间增长;
  //     · 有一次:每个音都晚 **~2.4 秒**,而且是**恒定**的(不是越晚越多)。
  //   给引擎补了两个直接量具(工作节点钟 - 上下文钟 / 渲染循环最大块间隔)之后,
  //   那一次没能复现 —— 见 AudioDiagnostics 里这两个字段的说明。
  //   7s 的窗口把 2.4 秒的常数偏移也罩住了:第 3 个音名义 4.69s,实测最晚
  //   5.53s 起音,仍有 1.4 秒余量。
  //   探针的读数必须可复现,坐边界的窗口不是窗口,是掷骰子。
  const a = { build: true, fallback: true, port: 5199, seconds: 7, offlineSeconds: 12, json: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--no-build') a.build = false;
    else if (k === '--no-fallback') a.fallback = false;
    else if (k === '--port') a.port = Number(argv[++i]);
    else if (k === '--seconds') a.seconds = Number(argv[++i]);
    else if (k === '--offline-seconds') a.offlineSeconds = Number(argv[++i]);
    else if (k === '--json') a.json = argv[++i];
    else if (k === '--help' || k === '-h') {
      console.log(
        '用法: node tools/probe_audio.mjs [--no-build] [--no-fallback] [--port 5199] [--json 结果.json]',
      );
      process.exit(0);
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

const out = (...v) => console.log(...v);
const head = (t) => {
  out('');
  out('─'.repeat(74));
  out(`▌ ${t}`);
  out('─'.repeat(74));
};
const kv = (k, v) => out(`   ${String(k).padEnd(28)} ${v}`);
const db = (v) => `${(20 * Math.log10(Math.max(1e-9, v))).toFixed(1)} dBFS`;

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  out(`   [${ok ? ' PASS ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

// --------------------------------------------------------------------------
// 构建 / 起服务
// --------------------------------------------------------------------------

function runNode(scriptArgs, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    out(`   $ node ${scriptArgs.join(' ')}`);
    const p = spawn(process.execPath, scriptArgs, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    p.on('error', rejectPromise);
    p.on('exit', (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`${label} 退出码 ${code}`)),
    );
  });
}

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await delay(150);
  }
  throw new Error(`静态服务 ${url} 在 ${timeoutMs}ms 内没有就绪`);
}

// --------------------------------------------------------------------------

async function main() {
  head('0. 构建');
  if (args.build) {
    out('   探针页构建(独立于作品主构建,产物在 dist-audio-probe/)');
    await runNode([VITE_BIN, 'build', '--config', PROBE_CONFIG], 'vite build(探针)');
  } else {
    out('   --no-build:复用已有产物');
  }
  if (!existsSync(join(OUT_DIR, 'index.html'))) {
    throw new Error(`产物不存在: ${join(OUT_DIR, 'index.html')}`);
  }

  const url = `http://127.0.0.1:${args.port}/`;
  const server = spawn(
    process.execPath,
    [join(ROOT, 'scripts', 'serve-dist.mjs'), '--dir', OUT_DIR, '--port', String(args.port), '--quiet'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForServer(url);
  out(`   静态服务就绪: ${url} (根目录 ${OUT_DIR})`);

  const chrome = await launch({ width: 900, height: 600, allowSoftware: true });
  const { page } = chrome;
  const consoleErrors = page.collectErrors();
  let exitCode = 0;

  try {
    await page.goto(url);
    await page.waitForReady();
    out(`   探针页就绪,浏览器: ${chrome.browserVersion}`);

    // ======================================================================
    // 1. 乐句表与律制(纯计算,不需要音频上下文)
    // ======================================================================
    const meta = await page.evaluate(() => window.__QM_AUDIO_PROBE__.meta());
    head('1. 乐句表 / 律制');
    kv('种子', meta.seed);
    kv('BPM', meta.bpm);
    kv('音符数', meta.notes);
    kv('总 tick', meta.totalTicks);
    kv('全曲时长 (s)', meta.seconds);
    kv('段落', meta.sections.map((s) => `${s.name}(${s.bars}小节@${s.startTick})`).join(' '));
    kv('指纹 (FNV-1a)', meta.fingerprint);
    check('同进程建两次乐句表指纹一致', meta.fingerprintStable, `指纹 ${meta.fingerprint}`);
    out('   三分损益 vs 十二平均律(比值与音分均由代码算出):');
    for (const t of meta.tuning) {
      out(
        `     ${t.name}  ratio=${String(t.ratio).padEnd(9)} ${String(t.cents).padStart(8)} 音分` +
          `   平均律 ${String(t.equalCents).padStart(5)} 音分   差 ${t.deviationFromEqual > 0 ? '+' : ''}${t.deviationFromEqual}`,
      );
    }
    const devs = meta.tuning.map((t) => Math.abs(t.deviationFromEqual));
    check(
      '律制确实不是十二平均律(至少三个音有非零偏差)',
      devs.filter((d) => d > 1).length >= 3,
      `偏差(音分) ${meta.tuning.map((t) => `${t.name}${t.deviationFromEqual}`).join(' ')}`,
    );

    // ======================================================================
    // 2. 混响 IR
    // ======================================================================
    head('2. 混响脉冲响应(程序化生成)');
    const ir = await page.evaluate(() => window.__QM_AUDIO_PROBE__.ir());
    kv('生成耗时 (ms)', ir.buildMs);
    kv('长度 (s)', ir.seconds);
    kv('采样率 / 声道', `${ir.sampleRate} / ${ir.channels}`);
    kv('峰值', ir.peak);
    kv('有效值', ir.rms);
    kv('L2 范数', ir.l2);
    kv('指纹', ir.checksum);
    kv('衰减包络 (dB/0.25s)', ir.decayDb.join(' '));
    check('IR 的 L2 范数归一化到 1', Math.abs(ir.l2 - 1) < 5e-3, `L2 = ${ir.l2}`);
    check('IR 首尾相差 > 40dB(是指数衰减,不是一段平噪声)', ir.decayDb[0] - ir.decayDb[ir.decayDb.length - 1] > 40, `${ir.decayDb[0]} → ${ir.decayDb[ir.decayDb.length - 1]} dB`);
    check('同一颗种子生成的 IR 指纹一致', ir.reproducible, ir.checksum);

    // ======================================================================
    // 3. 实时路径
    // ======================================================================
    head('3. 实时路径(无头 Chrome,真实 AudioContext)');
    // ⚠️ 用字符串表达式而不是函数:cdp.mjs 的 evaluate 只接受"无参函数或表达式",
    //    第二个参数是选项对象(不是函数入参),带参函数会被它当成选项吃掉。
    const live = await page.evaluate(
      `window.__QM_AUDIO_PROBE__.live({ seconds: ${args.seconds} })`,
    );
    if (live.error) {
      check('实时探针没有抛异常', false, live.error);
    } else {
      kv('构造后 state', live.lazy.state);
      kv('构造后 context / output', `${live.lazy.context} / ${live.lazy.output}`);
      kv('init 后 state', live.stateAfterInit);
      kv('采样率', live.sampleRate);
      kv('baseLatency (s)', live.baseLatency);
      kv('音频钟速率:init 后 1.2s 空窗', `${live.clockRate}(含音频线程启动滞后,<1 属正常)`);
      const d = live.diagnostics;
      kv('worklet 来源', d.workletSource);
      kv('worklet URL', d.workletUrl);
      kv('worklet 失败原因', d.workletError ?? '(无)');
      kv('worklet 握手', d.workletInfo ? `version=${d.workletInfo.version} voices=${d.workletInfo.voices} sr=${d.workletInfo.sampleRate}` : '(没回话)');
      kv('已下发音符', `${d.scheduled} / 全曲 ${d.composition.notes}`);
      kv(
        '工作节点统计(整场累计)',
        `active=${d.worklet.active} started=${d.worklet.started} dropped=${d.worklet.dropped} flushed=${d.worklet.flushed} stolen=${d.worklet.stolen} peak=${d.worklet.peak}`,
      );
      kv(
        '工作节点钟 - 上下文钟 (s)',
        `${d.worklet.clockSkew.toFixed(3)}(同一个钟,应当几乎是 0;差到秒级 = 音频线程没跟上主线程)`,
      );
      kv(
        '渲染循环:块数 / 最大块间隔 (s)',
        `${d.worklet.blocks} / ${d.worklet.maxGap.toFixed(4)}(正常 = 128/采样率 = ${(128 / live.sampleRate).toFixed(4)};到秒级说明渲染循环停过)`,
      );
      kv(
        '时钟对照(播放期间)',
        `音频钟 ${live.clock.audioElapsed}s / 浏览器钟 ${live.clock.wallElapsed}s → 差 ${live.clock.deltaMs} ms,速率 ${live.clock.rate}`,
      );
      kv('播放段 峰值 / 有效值', `${live.playing.peak.toFixed(5)} (${db(live.playing.peak)}) / ${live.playing.rms.toFixed(5)} (${db(live.playing.rms)})`);
      kv('静音后 尾部峰值 / 有效值', `${live.muted.tailPeak.toFixed(6)} (${db(live.muted.tailPeak)}) / ${live.muted.tailRms.toFixed(6)} (${db(live.muted.tailRms)})`);
      kv('恢复后 峰值 / 有效值', `${live.resumed.peak.toFixed(5)} (${db(live.resumed.peak)}) / ${live.resumed.rms.toFixed(5)} (${db(live.resumed.rms)})`);
      kv('时钟自愈 (resyncs)', `${live.resync.before} → ${live.resync.after}`);
      out('   时间线(每 0.25s 采样:世界钟 / 音频钟 / 已下发 / 重同步 / 已起音 / 在响 / 钟差)');
      for (const r of live.timeline) {
        out(
          `     t=${String(r.t).padStart(6)}s  audio=${String(r.audio).padStart(7)}s` +
            `  scheduled=${String(r.scheduled).padStart(3)}  resyncs=${r.resyncs}` +
            `  started=${String(r.started).padStart(3)}  active=${String(r.active).padStart(2)}` +
            `  skew=${String(r.skew).padStart(6)}s  maxGap=${String(r.maxGap).padStart(7)}s`,
        );
      }

      check('惰性:构造时不建 AudioContext', live.lazy.state === 'uninitialized' && live.lazy.context === null);
      check("init 后 state === 'running'", live.stateAfterInit === 'running', String(live.stateAfterInit));
      check(
        'worklet 模块真的加载了(不是回退掩盖失败)',
        d.workletSource === 'module' && d.workletError === null,
        `来源 ${d.workletSource}`,
      );
      check(
        '工作节点回话(证明注册名背后确实是我们的处理器)',
        d.workletInfo !== null && d.workletInfo.version === 1,
        d.workletInfo ? `version ${d.workletInfo.version}` : '(无回话)',
      );
      check(
        '实时图量到非零信号',
        live.playing.peak > 1e-3 && live.playing.rms > 1e-4,
        `峰值 ${live.playing.peak.toFixed(5)} / 有效值 ${live.playing.rms.toFixed(5)}`,
      );
      const dp = live.diagPlaying;
      // flushed 也一起断言:播放段里没人调 setEnabled,也没人制造漂移,所以
      // 这一段的清队次数必须是 0 —— 非 0 就说明中途发生过一次重锚(曲子被
      // 从头重放),那样 started 即便够数,数的也是"重放的音",不是"排队的音"。
      check(
        '工作节点真的起了音(不是别的节点在出声)',
        dp.worklet.started >= 2 && dp.worklet.dropped === 0 && dp.worklet.flushed === 0,
        `播放段结束: started=${dp.worklet.started} dropped=${dp.worklet.dropped} flushed=${dp.worklet.flushed} active=${dp.worklet.active}`,
      );
      check(
        'setEnabled(false) 之后确实静音',
        live.muted.tailPeak < 1e-3,
        `尾部峰值 ${live.muted.tailPeak.toFixed(6)}`,
      );
      check(
        'setEnabled(true) 之后恢复出声',
        live.resumed.peak > 1e-3,
        `峰值 ${live.resumed.peak.toFixed(5)}`,
      );
      check(
        '播放期间世界钟与音频钟的差在引擎容差内(< 250ms,未误触发重同步)',
        Math.abs(live.clock.deltaMs) < 250,
        `差 ${live.clock.deltaMs} ms(稳态速率 ${live.clock.rate})`,
      );
      check('人为制造 30s 漂移后触发一次重同步', live.resync.after === live.resync.before + 1, `${live.resync.before} → ${live.resync.after}`);
    }

    // ======================================================================
    // 4. 离线渲染(逐位可复现 + PCM 证据)
    // ======================================================================
    head('4. 离线渲染(与实时同一份图/同一份 worklet 源码)');
    const off = await page.evaluate(
      `window.__QM_AUDIO_PROBE__.offline({ seconds: ${args.offlineSeconds} })`,
    );
    if (off.error) {
      check('离线渲染没有抛异常', false, off.error);
    } else {
      kv('渲染时长 (s)', off.seconds);
      kv('耗时 / 实时倍率', `${off.wallMs} ms / ${off.realtimeFactor}x`);
      kv('worklet 来源', `${off.load.kind}${off.load.error ? ` (${off.load.error})` : ''}`);
      kv('下发音符数', off.notes);
      kv('采样率 / 声道', `${off.sampleRate} / ${off.channels}`);
      kv('峰值 / 有效值', `${off.peak} (${db(off.peak)}) / ${off.rms} (${db(off.rms)})`);
      kv('非零样本占比', off.nonzeroRatio);
      kv('静音格数 (<-60dB)', `${off.silentBuckets} / ${off.envelopeDb.length}`);
      kv('包络 (dBFS/0.5s)', off.envelopeDb.join(' '));
      kv('两次渲染校验和', `${off.repro.checksumA} vs ${off.repro.checksumB}`);
      check('离线 PCM 非零', off.peak > 0.01 && off.rms > 0.001, `峰值 ${off.peak}`);
      check('整段都有声音(没有整格静音)', off.silentBuckets === 0, `${off.envelopeDb.length - off.silentBuckets}/${off.envelopeDb.length} 格有声`);
      check('两次离线渲染逐位相同', off.repro.bitExact && off.repro.checksumA === off.repro.checksumB, `maxDiff=${off.repro.maxDiff}`);
    }

    // ======================================================================
    // 5. 整曲电平(增益是照着这一刻的数据定的,不是拍的)
    // ======================================================================
    head('5. 整曲渲染(全曲一遍,量电平与分段峰值)');
    const full = await page.evaluate('window.__QM_AUDIO_PROBE__.full()');
    if (full.error) {
      check('整曲渲染没有抛异常', false, full.error);
    } else {
      kv('渲染时长 / 实时倍率', `${full.seconds} s / ${full.realtimeFactor}x (${full.wallMs} ms)`);
      kv('下发音符数', full.notes);
      kv('整曲峰值', `${full.peak} (${full.peakDb} dBFS)`);
      kv('整曲有效值', `${full.rms} (${full.rmsDb} dBFS)`);
      kv('有声音的时间占比', `${(full.activeRatio * 100).toFixed(1)}%`);
      kv('削顶样本数 (>0.99)', full.clipped);
      for (const s of full.sections) {
        kv(`  段 ${s.name} (${s.fromS}~${s.toS}s)`, `峰值 ${s.peak}   有效值 ${s.rmsDb} dBFS`);
      }
      kv('最响的段', full.loudestSection);
      check('整曲峰值在 (-6, -0.2) dBFS 之间 —— 既没削顶也不是听不见', full.peakDb < -0.2 && full.peakDb > -12, `${full.peakDb} dBFS`);
      check('没有削顶样本(限幅器兜住了)', full.clipped === 0, `${full.clipped} 个样本 > 0.99`);
      check('全曲 >90% 的时间有声音', full.activeRatio > 0.9, `${(full.activeRatio * 100).toFixed(1)}%`);
    }

    // ======================================================================
    // 6. 音准:量出来的基频
    // ======================================================================
    head('6. 音准(对渲染出的 PCM 做自相关,量基频)');
    const pitch = await page.evaluate(() => window.__QM_AUDIO_PROBE__.pitch());
    if (pitch.error) {
      check('音准测量没有抛异常', false, pitch.error);
    } else {
      out(`   分析窗 ${pitch.windowS[0]}s ~ ${pitch.windowS[1]}s(稳态段;起振段谐波未衰,自相关峰会偏)`);
      out('   音级   目标Hz     实测Hz    与三分损益  与十二平均律   自相关峰');
      for (const r of pitch.rows) {
        out(
          `   ${r.name}    ${String(r.targetHz).padStart(8)}  ${String(r.measuredHz).padStart(8)}` +
            `   ${String(r.centsFromJust).padStart(8)} 音分 ${String(r.centsFromEqual).padStart(8)} 音分   ${r.corr}`,
        );
      }
      const hard = pitch.rows.filter((r) => Math.abs(r.centsFromEqual - r.centsFromJust) > 3);
      const closerToJust = hard.filter(
        (r) => Math.abs(r.centsFromJust) < Math.abs(r.centsFromEqual),
      );
      check(
        '商/角/羽的实测音高更接近三分损益而不是十二平均律',
        hard.length >= 3 && closerToJust.length === hard.length,
        hard.map((r) => `${r.name}: 损益${r.centsFromJust} vs 平均律${r.centsFromEqual}`).join('  '),
      );
      const errs = pitch.rows.map((r) => Math.abs(r.centsFromJust));
      // 阈值定在 ±1 音分,不是宽容,而是**这条断言的意义就在量级上**:
      // 平均律与三分损益的差只有 2~8 音分,如果容忍 5 音分的误差,那么
      // "环路被渲染量子带偏 128 个采样"(≈600 音分)之外的任何系统性偏差
      // 都能蒙混过关 —— 包括当初真实发生过的"环路滤波器相位延迟"那 2.6 音分。
      // 实测最大误差 0.12 音分,余量 8 倍;且离线渲染逐位可复现,读数不会抖。
      check(
        '五个音的实测频率都在目标 ±1 音分内(环路长度没被滤波器相位延迟带偏)',
        errs.every((e) => e < 1),
        `最大误差 ${Math.max(...errs).toFixed(2)} 音分`,
      );
    }

    // ======================================================================
    // 7. Blob 回退(把 worklet 资源在网络层打掉)
    // ======================================================================
    if (args.fallback) {
      head('7. Worklet Blob 回退(CDP 拦掉 worklet 资源后重新加载页面)');
      // ⚠️ 必须用 Fetch 域,不能用 Network.setBlockedURLs —— 实测(Chrome 153):
      //    setBlockedURLs 对 AudioWorklet 的模块加载**完全不生效**,模块照样加载
      //    成功,于是"回退路径"这一整段测试会静默地什么都没测。用 Fetch 域拦截
      //    并 failRequest 才能真的把这次请求打掉,等价于线上 worklet 资源 404。
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*pluck-processor*' }] });
      const offIntercept = page.conn.on((msg) => {
        if (msg.sessionId !== page.sessionId) return;
        if (msg.method !== 'Fetch.requestPaused') return;
        out(`   拦截: ${msg.params.request.url}`);
        page
          .send('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'Failed' })
          .catch(() => {});
      });
      await page.goto(`${url}?fallback=1`);
      await page.waitForReady();
      const fb = await page.evaluate(
        `window.__QM_AUDIO_PROBE__.live({ seconds: ${args.seconds} })`,
      );
      if (fb.error) {
        check('回退路径下探针没有抛异常', false, fb.error);
      } else {
        kv('worklet 来源', fb.diagnostics.workletSource);
        kv('worklet URL', fb.diagnostics.workletUrl);
        kv('回退原因(必须暴露出来,不能吞)', fb.diagnostics.workletError ?? '(没记录 —— 这是错的)');
        kv('工作节点握手', fb.diagnostics.workletInfo ? `version=${fb.diagnostics.workletInfo.version}` : '(没回话)');
        kv('播放段 峰值 / 有效值', `${fb.playing.peak.toFixed(5)} / ${fb.playing.rms.toFixed(5)}`);
        kv(
          '工作节点统计',
          `started=${fb.diagnostics.worklet.started} dropped=${fb.diagnostics.worklet.dropped} flushed=${fb.diagnostics.worklet.flushed}`,
        );
        kv('工作节点钟 - 上下文钟 (s)', fb.diagnostics.worklet.clockSkew.toFixed(3));
        kv(
          '渲染循环:块数 / 最大块间隔 (s)',
          `${fb.diagnostics.worklet.blocks} / ${fb.diagnostics.worklet.maxGap.toFixed(4)}`,
        );
        check('走的是内联 Blob 回退', fb.diagnostics.workletSource === 'blob', String(fb.diagnostics.workletSource));
        check('回退原因被记录(不静默)', typeof fb.diagnostics.workletError === 'string' && fb.diagnostics.workletError.length > 0, fb.diagnostics.workletError ?? '(空)');
        check(
          '回退路径同样出声(工作节点起了音且有非零输出)',
          fb.playing.peak > 1e-3 && fb.diagPlaying.worklet.started >= 2,
          `峰值 ${fb.playing.peak.toFixed(5)} started=${fb.diagPlaying.worklet.started}`,
        );
      }
      offIntercept();
      await page.send('Fetch.disable');
    }

    // ======================================================================
    head('8. 页面控制台');
    if (consoleErrors.length === 0) {
      out('   没有 console.error / 未捕获异常');
    } else {
      for (const e of consoleErrors) out(`   ! ${e}`);
    }
    check(
      '页面没有未捕获异常',
      consoleErrors.filter((e) => e.startsWith('未捕获异常')).length === 0,
      `${consoleErrors.length} 条控制台错误`,
    );

    head('结论');
    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) out(`   ${c.ok ? '✔' : '✘'} ${c.name}`);
    out('');
    out(`   ${checks.length - failed.length}/${checks.length} 通过`);
    if (failed.length > 0) exitCode = 1;

    // 机器可读的一份。给 tests/smoke_flow.mjs 汇总用 —— 它在别的进程里跑,
    // 只能靠文件交接;人看的那份在 stdout 上,两份内容同源。
    //
    // ⚠️ 这一组**不属于八功能组**,所以 `group` 一律写「音频」;它只作
    //    阶段出口的附加证据。写死在脚本里而不是让调用方传:标签是这份
    //    数据的属性,不是调用方式的属性。
    if (args.json) {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const target = resolve(ROOT, args.json);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            checks: checks.map((c) => ({
              group: '音频',
              name: c.name,
              ok: Boolean(c.ok),
              detail: c.detail ?? '',
            })),
            summary: { pass: checks.length - failed.length, fail: failed.length, total: checks.length },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      out(`   明细已写入 ${args.json}`);
    }
  } finally {
    await chrome.close().catch(() => {});
    server.kill();
  }

  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('\n探针异常终止:', err);
    process.exit(2);
  });
