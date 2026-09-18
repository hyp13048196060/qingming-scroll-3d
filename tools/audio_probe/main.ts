/**
 * 探针页面 —— 把配乐引擎的每一条验收断言做成可被 CDP 调用的方法。
 *
 * 原则:**所有结论都来自测量**,不来自"代码看起来对"。
 *
 *   · "加载成功"  → 工作节点 pong 回来的 version/voices,且 worklet 真的起了音
 *   · "有声音"    → 实时图接 AnalyserNode 量峰值/有效值;离线渲染量 PCM
 *   · "音准对"    → 对渲染出的 PCM 做自相关,量出基频,再和两个律制的理论值比
 *   · "可复现"    → 同一段离线渲染两次,**逐位**比对
 *   · "混响对"    → IR 的 L2 范数与衰减曲线
 *
 * ⚠️ 这个文件里可以用 performance.now() —— 探针扮演的是 core/loop.ts 的角色
 *    (作品的唯一时间源),worldTime 必须由它推出来交给 update()。引擎自己不
 *    读时钟,这一条在引擎里遵守,而不是在这里。
 */

import { AudioEngine, renderOffline } from '../../src/audio/AudioEngine';
import type { AudioDiagnostics, WorkletSourceKind } from '../../src/audio/AudioEngine';
import { buildComposition, compositionSeconds, fingerprint } from '../../src/audio/composition';
import type { NoteEvent } from '../../src/audio/composition';
import { cents, degreeHz, tuningTable } from '../../src/audio/scale';
import type { Degree } from '../../src/audio/scale';
import { createImpulseResponse, impulseStats } from '../../src/audio/reverb';

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

const nextFrame = (): Promise<number> =>
  new Promise((resolve) => requestAnimationFrame(resolve));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Level {
  peak: number;
  rms: number;
}

/** 从分析节点取一帧波形,算峰值与有效值。 */
function readLevel(analyser: AnalyserNode, buf: Float32Array): Level {
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / buf.length) };
}

/** PCM 的峰值 / 有效值 / 非零样本占比。 */
function pcmLevel(data: Float32Array): Level & { nonzero: number } {
  let peak = 0;
  let sum = 0;
  let nonzero = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    if (a > 1e-6) nonzero++;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / data.length), nonzero: nonzero / data.length };
}

/**
 * 基频估计:归一化自相关 + 抛物线插值。
 *
 * 为什么不用 FFT 找峰:窗长 0.8 秒的频率分辨率约 1.25Hz,而本作品要区分的
 * 两种律制在商音上只差 0.33Hz —— 谱峰法根本分不开。自相关的峰位精度不受
 * 这个限制:峰位落在整数延迟上,抛物线插值可以把它细化到 ~0.05 个采样,
 * 折到宫音(367 采样/周期)上约 0.25 音分,足够分辨 3.91 音分的律制差。
 *
 * ⚠️ 只能量**稳态段**。起振段里高频谐波还没衰完,自相关的峰会偏;所以窗口
 *    取 0.15s ~ 0.95s(此时 2 抽头平均滤波器已经把高次谐波磨掉了,波形接近
 *    纯基音,自相关就是一条干净的余弦)。
 */
function estimateF0(
  data: Float32Array,
  sr: number,
  loHz: number,
  hiHz: number,
  t0: number,
  t1: number,
): { hz: number; lag: number; corr: number; peakToRms: number } {
  const i0 = Math.round(t0 * sr);
  const i1 = Math.min(data.length, Math.round(t1 * sr));
  const n = i1 - i0;
  const lagMin = Math.max(2, Math.floor(sr / hiHz));
  const lagMax = Math.min(Math.floor(sr / loHz), Math.floor(n / 2));

  let e0 = 0;
  for (let i = 0; i < n - lagMax; i++) e0 += data[i0 + i]! * data[i0 + i]!;

  const vals = new Float64Array(lagMax + 2);
  let bestLag = -1;
  let bestVal = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let num = 0;
    let e1 = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) {
      const x = data[i0 + i]!;
      const y = data[i0 + i + lag]!;
      num += x * y;
      e1 += y * y;
    }
    const r = num / Math.sqrt(Math.max(1e-30, e0 * e1));
    vals[lag] = r;
    if (r > bestVal) {
      bestVal = r;
      bestLag = lag;
    }
  }

  // 抛物线插值:峰位两侧各取一点拟合顶点。
  let refined = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = vals[bestLag - 1]!;
    const y1 = vals[bestLag]!;
    const y2 = vals[bestLag + 1]!;
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) refined = bestLag + (0.5 * (y0 - y2)) / denom;
  }

  // 自相关峰的锐利程度 —— 越接近 1 说明信号越"准周期",否则这次测量不可信
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i0 + i]! * data[i0 + i]!;
  const rms = Math.sqrt(sum / n);

  return {
    hz: sr / refined,
    lag: Math.round(refined * 1000) / 1000,
    corr: Math.round(bestVal * 1e4) / 1e4,
    peakToRms: rms > 0 ? Math.round((bestVal / rms) * 1e4) / 1e4 : 0,
  };
}

/** 每格 RMS(dBFS)的包络 —— 用来看"整段是否一直有动静",而不是只有一个音。 */
function envelope(data: Float32Array, sr: number, stepS: number): number[] {
  const step = Math.max(1, Math.round(stepS * sr));
  const out: number[] = [];
  for (let s = 0; s < data.length; s += step) {
    const e = Math.min(data.length, s + step);
    let sum = 0;
    for (let i = s; i < e; i++) sum += data[i]! * data[i]!;
    const rms = Math.sqrt(sum / Math.max(1, e - s));
    out.push(Math.round(20 * Math.log10(Math.max(1e-9, rms)) * 10) / 10);
  }
  return out;
}

function note(
  degree: Degree,
  octave: number,
  tick: number,
  velocity = 108,
  hold = 16,
): NoteEvent {
  return { tick, instrument: 'qin', degree, octave, velocity, hold };
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;

/** 同名十二平均律音的频率 —— 只用来做"量出来的到底更像哪一边"的对照。 */
function equalHz(degree: Degree, octave: number): number {
  const row = tuningTable().find((t) => t.id === degree);
  return degreeHz('gong', octave) * 2 ** ((row ? row.equalCents : 0) / 1200);
}

// --------------------------------------------------------------------------
// 探测:静态信息(不需要音频上下文)
// --------------------------------------------------------------------------

function probeMeta() {
  const a = buildComposition();
  const b = buildComposition();
  return {
    seed: a.seed,
    bpm: a.bpm,
    notes: a.notes.length,
    sections: a.sections.map((s) => ({ name: s.name, bars: s.bars, startTick: s.startTick })),
    totalTicks: a.totalTicks,
    seconds: r3(compositionSeconds(a)),
    fingerprint: fingerprint(a),
    // 同进程内建两次也要一模一样 —— 确定性最低限度的一条
    fingerprintStable: fingerprint(a) === fingerprint(b),
    tuning: tuningTable().map((t) => ({
      name: t.name,
      id: t.id,
      ratio: r5(t.ratio),
      cents: r3(t.cents),
      equalCents: t.equalCents,
      deviationFromEqual: r3(t.deviation),
    })),
  };
}

// --------------------------------------------------------------------------
// 探测:混响 IR
// --------------------------------------------------------------------------

function probeIr() {
  // IR 只需要一个上下文来提供 sampleRate,不需要真的渲染
  const ctx = new OfflineAudioContext(2, 128, 48000);
  const t0 = performance.now();
  const buf = createImpulseResponse(ctx);
  const ms = performance.now() - t0;
  const stats = impulseStats(buf);
  const again = impulseStats(createImpulseResponse(ctx));
  return {
    buildMs: r3(ms),
    seconds: stats.seconds,
    sampleRate: stats.sampleRate,
    channels: stats.channels,
    peak: stats.peak,
    rms: stats.rms,
    l2: stats.l2,
    checksum: stats.checksum,
    reproducible: stats.checksum === again.checksum,
    decayDb: stats.decay.map((d) => d.db),
  };
}

// --------------------------------------------------------------------------
// 探测:实时路径
// --------------------------------------------------------------------------

interface LiveResult {
  error?: string;
  lazy?: { state: string; context: null | object; output: null | object };
  stateAfterInit?: string | null;
  sampleRate?: number;
  baseLatency?: number;
  diagnostics?: AudioDiagnostics;
  /** 播放段刚结束时的诊断 —— 用来判断"这一段里工作节点起了几个音" */
  diagPlaying?: AudioDiagnostics;
  /**
   * 音频钟速率(音频钟秒数 / 浏览器钟秒数),在 init 之后的 1.2s 空窗里量。
   * ⚠️ 这个窗口**包含启动滞后**(音频线程起转慢),所以它 <1 是正常的,
   *    要的是 `clock.rate`(播放期间稳态速率,应当 ≈1)。
   */
  clockRate?: number;
  clock?: { audioElapsed: number; wallElapsed: number; deltaMs: number; rate: number };
  playing?: Level & { frames: number; tailPeak: number; tailRms: number };
  muted?: Level & { frames: number; tailPeak: number; tailRms: number };
  resumed?: Level & { frames: number; tailPeak: number; tailRms: number };
  resync?: { before: number; after: number };
  /**
   * 播放期间的时间线(每 0.25s 一行)。
   *
   * ⚠️ 为什么要留这个 —— "这段里起了几个音"这种断言**只看端点值会误判**:
   *    started 少了,可能是(甲)音符根本没下发、(乙)下发了但工作节点没起、
   *    (丙)中途重同步把曲子重头来过(于是又响了一遍第 1 个音)。
   *    三种情况端点值几乎一样,而修法完全不同。把 scheduled / resyncs /
   *    started 一起按时间摊开,一眼就能归因。
   */
  timeline?: Array<{
    t: number;
    audio: number;
    scheduled: number;
    resyncs: number;
    started: number;
    active: number;
    skew: number;
    /** 渲染循环到这一刻为止,相邻两块的最大间隔(秒)。正常 2.67ms。 */
    maxGap: number;
  }>;
}

async function probeLive(opts: { seconds?: number } = {}): Promise<LiveResult> {
  const seconds = opts.seconds ?? 2.0;
  const out: LiveResult = {};
  let engine: AudioEngine | null = null;
  try {
    engine = new AudioEngine();

    // —— 惰性:构造之后不能有 AudioContext ——
    out.lazy = {
      state: engine.state,
      context: engine.context,
      output: engine.output,
    };

    await engine.init();
    const ctx = engine.context!;
    out.stateAfterInit = engine.state;
    out.sampleRate = ctx.sampleRate;
    out.baseLatency = ctx.baseLatency;

    // —— 音频钟速率 ——
    //
    // 单独量一次,而且是在**没接任何东西**的空窗里量:后面"世界钟 vs 音频钟"
    // 的差要能归因。真机上两个钟同源,速率应当 ≈1.0;无头 Chrome 的音频输出
    // 是模拟的,速率会明显偏离 1 —— 那是环境特性,不是引擎缺陷。不先量这一下,
    // 后面看到 -170ms 的漂移就只能靠猜。
    {
      const a0 = ctx.currentTime;
      const w0 = performance.now() / 1000;
      await sleep(1200);
      out.clockRate = r5((ctx.currentTime - a0) / (performance.now() / 1000 - w0));
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    engine.output!.connect(analyser);
    const scratch = new Float32Array(analyser.fftSize);

    const clockWall = performance.now() / 1000;
    const clockAudio = ctx.currentTime;
    const worldOrigin = performance.now() / 1000;
    let lastWall = worldOrigin;
    const timeline: NonNullable<LiveResult['timeline']> = [];
    let lastSample = worldOrigin;

    /**
     * 驱动一段时间的 update(),同时把分析节点的读数聚起来。
     *
     * tailFrom:只统计这一段**后半程**的读数(用于"淡出之后还在响吗"这种测量,
     * 前半程还处在淡出过程中,算进去会得到偏大的结论)。
     */
    async function drive(sec: number, tailFrom = 0.5) {
      const end = performance.now() + sec * 1000;
      const tailStart = performance.now() + sec * 1000 * tailFrom;
      const s = { frames: 0, peak: 0, rms: 0, tailPeak: 0, tailRms: 0 };
      while (performance.now() < end) {
        await nextFrame();
        const wall = performance.now() / 1000;
        const dt = Math.min(0.05, Math.max(0, wall - lastWall));
        lastWall = wall;
        // 探针在此扮演 core/loop.ts:worldTime 由浏览器钟推出,交给引擎
        engine!.update(wall - worldOrigin, dt);
        // 时间线采样(见 LiveResult.timeline 的注释:端点值无法归因)
        if (wall - lastSample >= 0.25) {
          lastSample = wall;
          const dg = engine!.diagnostics;
          timeline.push({
            t: r3(wall - worldOrigin),
            audio: r3(ctx.currentTime),
            scheduled: dg.scheduled,
            resyncs: dg.resyncs,
            started: dg.worklet.started,
            active: dg.worklet.active,
            skew: r3(dg.worklet.clockSkew),
            maxGap: r3(dg.worklet.maxGap),
          });
        }
        const lv = readLevel(analyser, scratch);
        s.frames++;
        if (lv.peak > s.peak) s.peak = lv.peak;
        if (lv.rms > s.rms) s.rms = lv.rms;
        if (performance.now() >= tailStart) {
          if (lv.peak > s.tailPeak) s.tailPeak = lv.peak;
          if (lv.rms > s.tailRms) s.tailRms = lv.rms;
        }
      }
      return s;
    }

    out.playing = await drive(seconds);
    // 等最后一条 query 的 stats 消息回来。query 是每 0.25s 发一次的,
    // 300ms 足够走一个来回(worklet → 主线程)。
    await sleep(400);
    out.diagPlaying = engine.diagnostics;

    const audioElapsed = ctx.currentTime - clockAudio;
    const wallElapsed = performance.now() / 1000 - clockWall;
    out.clock = {
      audioElapsed: r3(audioElapsed),
      wallElapsed: r3(wallElapsed),
      deltaMs: r3((audioElapsed - wallElapsed) * 1000),
      rate: r5(audioElapsed / wallElapsed),
    };

    // —— 关掉之后必须真的没声音 ——
    engine.setEnabled(false);
    out.muted = await drive(0.9, 0.55);

    // —— 再打开必须恢复 ——
    engine.setEnabled(true);
    out.resumed = await drive(2.2, 0.45);

    // —— 时钟自愈:人为制造 30 秒漂移,resyncs 必须 +1 ——
    const before = engine.diagnostics.resyncs;
    const world = performance.now() / 1000 - worldOrigin;
    engine.update(world + 30, 0.05);
    await sleep(120);
    out.resync = { before, after: engine.diagnostics.resyncs };

    out.timeline = timeline;
    out.diagnostics = engine.diagnostics;
    engine.dispose();
    engine = null;
    return out;
  } catch (err) {
    out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    try {
      engine?.dispose();
    } catch {
      /* 已经关掉了 */
    }
    return out;
  }
}

// --------------------------------------------------------------------------
// 探测:离线渲染
// --------------------------------------------------------------------------

interface OfflineResult {
  error?: string;
  seconds?: number;
  wallMs?: number;
  realtimeFactor?: number;
  sampleRate?: number;
  channels?: number;
  notes?: number;
  load?: { kind: WorkletSourceKind; error: string | null };
  peak?: number;
  rms?: number;
  nonzeroRatio?: number;
  envelopeDb?: number[];
  silentBuckets?: number;
  repro?: { bitExact: boolean; maxDiff: number; checksumA: string; checksumB: string };
}

function bufferChecksum(data: Float32Array): string {
  // 逐位(Float32 的 bit pattern)—— 要比"两次渲染是否一模一样",就得比位,
  // 不能比数值:1e-9 的差在数值上相等,在位上不等。
  const bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < bits.length; i++) {
    h ^= bits[i]! & 0xffff;
    h = Math.imul(h, 0x01000193);
    h ^= (bits[i]! >>> 16) & 0xffff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function probeOffline(opts: { seconds?: number } = {}): Promise<OfflineResult> {
  const seconds = opts.seconds ?? 12;
  const out: OfflineResult = { seconds };
  try {
    const t0 = performance.now();
    const { buffer, load, notes } = await renderOffline({ seconds });
    out.wallMs = r3(performance.now() - t0);
    out.realtimeFactor = r3(seconds / (out.wallMs / 1000));
    out.sampleRate = buffer.sampleRate;
    out.channels = buffer.numberOfChannels;
    out.notes = notes;
    out.load = load;

    const ch = buffer.getChannelData(0);
    const lv = pcmLevel(ch);
    out.peak = r5(lv.peak);
    out.rms = r5(lv.rms);
    out.nonzeroRatio = r5(lv.nonzero);

    const env = envelope(ch, buffer.sampleRate, 0.5);
    out.envelopeDb = env;
    out.silentBuckets = env.filter((db) => db < -60).length;

    // —— 可复现:同一段渲染两次,逐位比 ——
    const single = note('gong', 0, 0);
    const a = await renderOffline({ seconds: 1.5, notes: [single] });
    const b = await renderOffline({ seconds: 1.5, notes: [single] });
    const da = a.buffer.getChannelData(0);
    const db = b.buffer.getChannelData(0);
    let maxDiff = 0;
    for (let i = 0; i < da.length; i++) {
      const d = Math.abs(da[i]! - db[i]!);
      if (d > maxDiff) maxDiff = d;
    }
    out.repro = {
      bitExact: maxDiff === 0,
      maxDiff,
      checksumA: bufferChecksum(da),
      checksumB: bufferChecksum(db),
    };
    return out;
  } catch (err) {
    out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return out;
  }
}

// --------------------------------------------------------------------------
// 探测:整曲电平
// --------------------------------------------------------------------------

interface SectionLevel {
  name: string;
  fromS: number;
  toS: number;
  peak: number;
  rmsDb: number;
}

interface FullResult {
  error?: string;
  seconds?: number;
  wallMs?: number;
  realtimeFactor?: number;
  notes?: number;
  peak?: number;
  peakDb?: number;
  rms?: number;
  rmsDb?: number;
  /** 有声音的时间占比(>-60dBFS 的 0.5s 格) */
  activeRatio?: number;
  sections?: SectionLevel[];
  /** 峰值出现在哪一段 */
  loudestSection?: string;
  /** 超过 -1dBFS 的样本数 —— 削顶计数。限幅器在,应该是 0。 */
  clipped?: number;
}

/**
 * 把**整首曲子**渲染一遍,量电平。
 *
 * 为什么必须量整曲:增益是照着"最多同时几个音"定的,而只有整曲跑完才知道
 * 最密的那一段到底叠了多少个音、峰值到哪。凭"一个音听起来差不多"调增益,
 * 到了转段(古筝加密)就会糊或者削顶。
 */
async function probeFullPiece(): Promise<FullResult> {
  const out: FullResult = {};
  try {
    const comp = buildComposition();
    const total = compositionSeconds(comp);
    const seconds = Math.ceil(total) + 3; // 留一段尾巴,让最后的余音衰完
    const t0 = performance.now();
    const { buffer, notes } = await renderOffline({ seconds, composition: comp });
    out.wallMs = r3(performance.now() - t0);
    out.realtimeFactor = r3(seconds / (out.wallMs / 1000));
    out.seconds = r3(seconds);
    out.notes = notes;

    const ch = buffer.getChannelData(0);
    const lv = pcmLevel(ch);
    out.peak = r5(lv.peak);
    out.peakDb = r3(20 * Math.log10(Math.max(1e-9, lv.peak)));
    out.rms = r5(lv.rms);
    out.rmsDb = r3(20 * Math.log10(Math.max(1e-9, lv.rms)));

    let clipped = 0;
    for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]!) > 0.99) clipped++;
    out.clipped = clipped;

    const env = envelope(ch, buffer.sampleRate, 0.5);
    out.activeRatio = r5(env.filter((v) => v > -60).length / env.length);

    const barsPerSection = comp.ticksPerBeat * comp.beatsPerBar;
    out.sections = comp.sections.map((s) => {
      const from = Math.floor((tickOf(comp, s.startTick)) * buffer.sampleRate);
      const to = Math.min(ch.length, Math.floor(tickOf(comp, s.startTick + s.bars * barsPerSection) * buffer.sampleRate));
      let p = 0;
      let sum = 0;
      let n = 0;
      for (let i = from; i < to; i++) {
        const a = Math.abs(ch[i]!);
        if (a > p) p = a;
        sum += ch[i]! * ch[i]!;
        n++;
      }
      return {
        name: s.name,
        fromS: r3(from / buffer.sampleRate),
        toS: r3(to / buffer.sampleRate),
        peak: r5(p),
        rmsDb: r3(20 * Math.log10(Math.max(1e-9, Math.sqrt(sum / Math.max(1, n))))),
      };
    });
    let loudest = out.sections[0]!;
    for (const s of out.sections) if (s.peak > loudest.peak) loudest = s;
    out.loudestSection = loudest.name;
    return out;
  } catch (err) {
    out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return out;
  }
}

function tickOf(comp: ReturnType<typeof buildComposition>, tick: number): number {
  return (tick / comp.ticksPerBeat) * (60 / comp.bpm);
}

// --------------------------------------------------------------------------
// 探测:音准(量出来的,不是算出来的)
// --------------------------------------------------------------------------

interface PitchRow {
  degree: Degree;
  name: string;
  targetHz: number;
  measuredHz: number;
  centsFromJust: number;
  centsFromEqual: number;
  corr: number;
}

async function probePitch() {
  const out: { rows?: PitchRow[]; error?: string; windowS?: [number, number] } = {};
  try {
    const rows: PitchRow[] = [];
    const degrees: Degree[] = ['gong', 'shang', 'jue', 'zhi', 'yu'];
    for (const d of degrees) {
      // 单音渲染:宫组、八度 0。古琴音色(暗、余音长),稳态段干净。
      const { buffer } = await renderOffline({ seconds: 1.5, notes: [note(d, 0, 0)] });
      const ch = buffer.getChannelData(0);
      const m = estimateF0(ch, buffer.sampleRate, 100, 300, 0.15, 0.95);
      const just = degreeHz(d, 0);
      const equal = equalHz(d, 0);
      rows.push({
        degree: d,
        name: tuningTable().find((t) => t.id === d)!.name,
        targetHz: r5(just),
        measuredHz: r3(m.hz),
        centsFromJust: r3(cents(m.hz / just)),
        centsFromEqual: r3(cents(m.hz / equal)),
        corr: m.corr,
      });
    }
    out.rows = rows;
    out.windowS = [0.15, 0.95];
    return out;
  } catch (err) {
    out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return out;
  }
}

// --------------------------------------------------------------------------
// 注册
// --------------------------------------------------------------------------

const probe = {
  meta: probeMeta,
  ir: probeIr,
  live: probeLive,
  offline: probeOffline,
  full: probeFullPiece,
  pitch: probePitch,
};

declare global {
  interface Window {
    __QM_AUDIO_PROBE__: typeof probe;
    __QM_READY__: boolean;
  }
}

window.__QM_AUDIO_PROBE__ = probe;
window.__QM_READY__ = true;
