/**
 * 配乐引擎 —— 程序化古琴/古筝,对外唯一入口。
 *
 * 零素材、零外部服务:乐句由固定种子的 PRNG 生成(composition.ts),
 * 波形由手写 Karplus-Strong 在 AudioWorklet 里合成(worklets/),
 * 混响由程序化生成的噪声 IR 卷积(reverb.ts)。断网可跑,换台机器同一首曲子。
 *
 * 关于时间源(必读)
 * ----------------
 * 全作品的时间源是 core/loop.ts 的 worldTime,`update(worldTime, dt)` 是
 * 本模块唯一的时间入口,**不读 Date.now() / performance.now()**。
 *
 * 但音频调度必须知道"音频时钟现在走到哪了",否则无法把音符排到正确的
 * 采样上。所以这里会读 `AudioContext.currentTime` —— 它是**音频硬件时钟**,
 * 与墙上时钟无关,而且只在两处用:
 *   1. 建立锚点:worldTime ↔ 音频时间的换算原点(一次性);
 *   2. 自愈:每帧比一次"音频钟走了多久"与"世界钟走了多久",差得太多就重新
 *      对齐(切标签页回来时 rAF 停了、音频钟没停,不对齐就会积压)。
 *
 * 换句话说:它不参与"现在几点"的判断,只回答"这一帧该把音符排在哪"。
 * 用 dt 累加出一个自己的时间也不行 —— dt 在 loop.ts 里被钳制到 50ms,
 * 累加值会与 worldTime 持续分叉,越跑越偏。
 */

import {
  buildComposition,
  compositionSeconds,
  fingerprint,
  noteSeed,
  tickSeconds,
  type Composition,
  type Instrument,
  type NoteEvent,
} from './composition';
import { createImpulseResponse } from './reverb';
import { degreeHz } from './scale';
import workletUrl from './worklets/pluck-processor.js?url';
import workletSource from './worklets/pluck-processor.js?raw';

// --------------------------------------------------------------------------
// 参数
// --------------------------------------------------------------------------

const PROCESSOR_NAME = 'pluck';

/** 第一个音离"现在"多远。必须 ≥ LOOKAHEAD,否则锚定那一刻它就已经过期。 */
const START_DELAY = 0.4;
/** 提前下发时长。主线程卡个 300ms 也不至于让音符过期。 */
const LOOKAHEAD = 0.5;
/**
 * 世界钟与音频钟差到这个量就重新对齐。
 *
 * 为什么是 0.25 而不是更小 —— 实测数据(无头 Chrome 153,48kHz):
 *   · 稳态:播放期间两边速率一致,7 秒里累计差只有几毫秒(多次实测落在
 *     -11.5 ~ +7.5 ms;128 采样一格的量化抖动就是这个量级);
 *   · 启动:AudioContext 建好后的头 0.5~1.2 秒,音频钟只走 0.86~0.90 倍速
 *     (音频线程起转慢),之后回归正常。**一次性**滞后零点几秒,之后不再累积。
 * 也就是说真实环境里这个阈值几乎不可能被稳态漂移触发;它会触发的场景就是
 * 它该触发的场景 —— 标签页被挂起、rAF 停了几秒到几十秒。阈值再往下调只会
 * 让启动滞后被误判成失步(表现为开头几秒莫名重来一次)。
 */
const RESYNC_TOLERANCE = 0.25;
/** 一次 update 最多下发多少音。防止自愈/异常时一帧倒出几百个音。 */
const MAX_SCHEDULE_PER_UPDATE = 64;
/** 工作节点状态查询间隔(秒)。 */
const STATS_INTERVAL = 0.25;
/** 开关淡入淡出时长。直接切增益会有"咔"声。 */
const FADE = 0.35;

/**
 * 总电平。⚠️ 这个数是**量出来的**,不是估的。
 *
 * 整曲离线渲染(217 个音、158 秒)实测:峰值 0.0875(-21.2 dBFS)、有效值
 * -37.3 dBFS。照 0.6 这个初值出来的曲子比正常音乐轻了约 18dB —— 单听一个音
 * 听不出问题(每个音自己听着都"还行"),只有把全曲跑完量峰值才看得出来。
 * 按 5.0 反推:0.0875 × (5.0/0.6) = 0.729,即 -2.7 dBFS 的峰值、约 -19 dBFS
 * 的有效值 —— 既不削顶,也不用把音量拧到底。
 *
 * 改这个值之前先重跑 `node tools/probe_audio.mjs` 的第 5 节,它会打印整曲峰值、
 * 有效值、分段峰值与削顶样本数。凭感觉调只会重犯上面那个错。
 */
const MASTER_GAIN = 5;
const DRY_GAIN = 0.9;
const WET_GAIN = 0.55;

/** 每件乐器的音色。decay 是**每周期**增益,brightness 是环路在奈奎斯特处的增益。 */
interface Timbre {
  decay: number;
  brightness: number;
  gain: number;
  /** 等功率声像:-1 全左,+1 全右 */
  pan: number;
}

const TIMBRES: Readonly<Record<Instrument, Timbre>> = {
  // 古琴:暗、余音极长。它的"韵"就在长音上,衰减必须比古筝长。
  qin: { decay: 0.999, brightness: 0.35, gain: 0.3, pan: -0.18 },
  // 古筝:亮、音头脆。它铺琶音,短一点才不会糊成一片。
  zheng: { decay: 0.997, brightness: 0.6, gain: 0.24, pan: 0.22 },
};

export type WorkletSourceKind = 'none' | 'module' | 'blob';

// --------------------------------------------------------------------------
// 图
// --------------------------------------------------------------------------

interface VoiceGraph {
  node: AudioWorkletNode;
  /** 电平节点。开关与总音量都在这里,**必须在限幅器之前**(理由见 buildGraph)。 */
  mix: GainNode;
  /** 链路末端 —— 探针接 AnalyserNode 就接在这里 */
  master: AudioNode;
}

function buildGraph(ctx: BaseAudioContext): VoiceGraph {
  const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
    // 没有输入:音源全在处理器内部。声明 0 输入可以省掉一次图连接的检查。
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  const conv = ctx.createConvolver();
  // ⚠️ 必须关掉自动归一化。默认 normalize=true 会用 ConvolverNode 自己那套
  //    功率公式重新缩放 IR —— 我们的 targetL2 就白做了,湿声电平还会随 IR
  //    长度漂移(改一处秒数,混响忽然变响或变轻,查起来毫无线索)。
  conv.normalize = false;
  conv.buffer = createImpulseResponse(ctx);

  const dry = ctx.createGain();
  dry.gain.value = DRY_GAIN;
  const wet = ctx.createGain();
  wet.gain.value = WET_GAIN;
  const bus = ctx.createGain();

  // 电平节点:总音量 + 开关。初值 0,由 setEnabled 拉起 —— 上电那一下直接
  // 满电平会"砰"一声。
  const mix = ctx.createGain();
  mix.gain.value = 0;

  // 限幅器兜底:多音叠置时的瞬时峰值很容易过 0,而削顶的失真在拨弦音色上
  // 极其刺耳(比过载的吉他难听得多)。
  //
  // ⚠️ 位置:**必须在电平节点之后、destination 之前**。
  //    反过来(限幅器在前、总音量在后)看着也能出声,但限幅器就在也保护不了
  //    输出 —— 它把峰值压到 0.9,后面再乘 5,输出照样冲过 1.0,削顶照样发生,
  //    而且"有保护"的错觉会让后来人不再检查。
  //    阈值取 -1dBFS 而不是 -4:整曲实测峰值 -2.7dBFS,阈值压得太低会让限幅器
  //    在**每一个**乐句的重音上都工作一遍 —— 拨弦音色被压出抽吸感,很难听。
  //    它在这里是"兜底",不是"效果器"。
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;

  node.connect(dry);
  dry.connect(bus);
  node.connect(conv);
  conv.connect(wet);
  wet.connect(bus);
  bus.connect(mix);
  mix.connect(limiter);
  limiter.connect(ctx.destination);

  return { node, mix, master: limiter };
}

interface WorkletLoadResult {
  kind: WorkletSourceKind;
  error: string | null;
}

/**
 * 加载 worklet 模块,带内联 Blob 回退。
 *
 * ⚠️ 回退不是"以防万一":生产构建下 worklet 资源 404 是这类项目最常见的
 *    故障 —— 部署到子路径时 base 写错、静态服务器没把 .js 当 JS 发、
 *    反向代理只放行了 index.html。真出现时表现为"页面一切正常,就是没声音",
 *    而没声音最难查。
 *
 * ⚠️ 模块加载失败的原因**不能吞**:回退成功也要把原因记下来(:workletError),
 *    否则运维看到的永远是"能出声",没人知道线上一直在走兜底路径。
 */
async function loadPluckModule(ctx: BaseAudioContext): Promise<WorkletLoadResult> {
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    return { kind: 'module', error: null };
  } catch (moduleErr) {
    const first = describeError(moduleErr);
    const blobUrl = URL.createObjectURL(
      new Blob([workletSource], { type: 'application/javascript' }),
    );
    try {
      await ctx.audioWorklet.addModule(blobUrl);
      return {
        kind: 'blob',
        error: `worklet 模块加载失败(${first}),已用内联 Blob 回退`,
      };
    } catch (blobErr) {
      // 两条路都断了 —— 抛出具体原因,不做"静音降级"
      throw new Error(
        `[audio] worklet 加载失败。模块路径:${describeError(moduleErr)};` +
          `内联回退:${describeError(blobErr)}`,
      );
    } finally {
      // addModule 的 Promise 落定时模块已经取回并求值,可以安全释放
      URL.revokeObjectURL(blobUrl);
    }
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --------------------------------------------------------------------------
// 引擎
// --------------------------------------------------------------------------

export interface AudioDiagnostics {
  contextState: AudioContextState | 'uninitialized';
  sampleRate: number;
  /** 'module' = 走了 ?url 的快路径;'blob' = 走了内联回退 */
  workletSource: WorkletSourceKind;
  workletUrl: string;
  /** 非 null 表示曾经失败过(哪怕已经回退成功) */
  workletError: string | null;
  /** 工作节点握手回来的信息 —— 证明加载到的确实是 pluck 处理器 */
  workletInfo: { sampleRate: number; voices: number; version: number } | null;
  enabled: boolean;
  /** 已下发的音符数 */
  scheduled: number;
  /** 时钟重新对齐次数(切标签页回来会 +1) */
  resyncs: number;
  /** 由 dt 累加的记账时间(秒),不参与调度 */
  elapsed: number;
  worklet: {
    active: number;
    started: number;
    /** 被动丢音(事件来晚了)—— 正常应为 0 */
    dropped: number;
    /** 主动清队丢掉的音(时钟重同步时)—— 非 0 是正常的 */
    flushed: number;
    stolen: number;
    peak: number;
    /**
     * 工作节点的时钟(currentTime)与本线程 ctx.currentTime 的差,单位秒。
     *
     * ⚠️ 这两个钟**本该**是同一个钟:音符的 at 由 ctx.currentTime 推出,工作
     *    节点又拿自己的 currentTime 判断"该响了"。两个读数都指"已经渲染到哪
     *    儿了",所以差值应当不到一个渲染量子(48kHz 下 2.67ms),实测 0.000。
     *    它不等于"输出延迟"(那是喇叭/缓冲的事,不在这里)。
     *
     *    为什么要暴露它:这个差值一旦到了秒级,音符的 at(主线程算的)与工作
     *    节点眼里的"现在"就错开了一大截 —— 表现为"排下去的音莫名晚了好几秒
     *    才响",而 dropped=0、resyncs=0,光看那两个数会判成"调度没问题"。
     *    无头 Chrome 的一次实测里出现过这种几秒的错位(8 次里 1 次),加上这个
     *    读数之后没能复现;真机未验证。差值为正 = 工作节点比主线程的钟更靠前。
     */
    clockSkew: number;
    /**
     * 渲染循环的体检:被调用的总块数与相邻两块之间的最大间隔(秒)。
     *
     * ⚠️ 正常 maxGap = 128/sampleRate(48kHz 下 2.67ms)。若这个数到了秒级,
     *    说明渲染循环真的停过 —— 此时音符会"排着不发",而 dropped 和 resyncs
     *    都是 0(事件没迟到,只是没人处理),光看那两个数会误判成"调度器坏了"。
     *    实测(无头 Chrome 153):4328 块 / maxGap 0.0027s,连续无停。
     */
    blocks: number;
    maxGap: number;
  };
  composition: {
    seed: number;
    notes: number;
    totalTicks: number;
    seconds: number;
    fingerprint: string;
  };
}

export class AudioEngine {
  #ctx: AudioContext | null = null;
  #node: AudioWorkletNode | null = null;
  #mix: GainNode | null = null;
  #master: AudioNode | null = null;

  #initPromise: Promise<void> | null = null;
  #enabled = true;
  #disposed = false;

  #workletKind: WorkletSourceKind = 'none';
  #workletError: string | null = null;
  #workletInfo: AudioDiagnostics['workletInfo'] = null;

  readonly #composition: Composition;
  readonly #fingerprint: string;

  // —— 调度状态 ——
  #anchored = false;
  #anchorWorld = 0;
  #anchorCtx = 0;
  /** 当前这一遍的第 0 tick 对应的音频时间 */
  #pieceAudioOrigin = 0;
  #nextIndex = 0;
  #resyncs = 0;
  #scheduled = 0;
  #elapsed = 0;
  #statsClock = 0;
  #workletStats = {
    active: 0,
    started: 0,
    dropped: 0,
    flushed: 0,
    stolen: 0,
    peak: 0,
    clockSkew: 0,
    blocks: 0,
    maxGap: 0,
  };

  constructor() {
    // 构造只做纯计算:乐句表是确定性的,不需要 AudioContext。
    // ⚠️ 绝不能在这里 new AudioContext() —— 没有用户手势的上下文会被浏览器
    //    建出来就是 suspended,之后即便在点击回调里 resume,首帧也已经
    //    "建过一次"了,状态机更容易出岔子。惰性创建是硬要求。
    this.#composition = buildComposition();
    if (this.#composition.notes.length === 0) {
      throw new Error('[audio] 乐句表是空的 —— 调度器会空转,先修 buildComposition');
    }
    this.#fingerprint = fingerprint(this.#composition);
  }

  /** 乐句表(只读)。UI 要显示"第几段"之类的信息时读它。 */
  get composition(): Readonly<Composition> {
    return this.#composition;
  }

  /** 混音输出。探针与可视化接这里,不要接 destination。 */
  get output(): AudioNode | null {
    return this.#master;
  }

  get context(): AudioContext | null {
    return this.#ctx;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** AudioContext.state;尚未 init 时是 'uninitialized'。 */
  get state(): AudioContextState | 'uninitialized' {
    return this.#ctx ? this.#ctx.state : 'uninitialized';
  }

  /**
   * 惰性创建 AudioContext 并加载 worklet。
   *
   * ⚠️ **必须在用户手势里调用**(点击/按键回调)。浏览器会拒绝在非手势
   *    上下文里启动音频,那台机器上就永远没声音,而代码一行错都没有。
   *
   * 失败时会抛错并把原因带出来(不静默失败),且**可以重试**:内部会把
   * 半成品状态清干净,再调一次 init() 会重新来过。
   */
  async init(): Promise<void> {
    if (this.#disposed) throw new Error('[audio] 已 dispose,不能再 init');
    if (this.#initPromise) return this.#initPromise;
    if (typeof AudioContext === 'undefined') {
      throw new Error('[audio] 运行环境没有 AudioContext,无法播放配乐');
    }

    this.#initPromise = (async () => {
      try {
        await this.#doInit();
      } catch (err) {
        this.#initPromise = null;
        await this.#teardown();
        throw err;
      }
    })();
    return this.#initPromise;
  }

  async #doInit(): Promise<void> {
    // latencyHint 用 playback:配乐不需要低延迟,稳定优先(interactive 会让
    // 缓冲区变小,多音叠置时更容易出现 pops)。
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.#ctx = ctx;

    // 在用户手势里创建后仍可能是 suspended(Safari/iOS 尤其),必须显式
    // resume —— 否则 state 永远不是 'running',而"没声音"会被误判成加载失败。
    if (ctx.state !== 'running') await ctx.resume();

    const load = await loadPluckModule(ctx);
    this.#workletKind = load.kind;
    this.#workletError = load.error;
    if (load.error) console.warn('[audio]', load.error);

    const graph = buildGraph(ctx);
    this.#node = graph.node;
    this.#mix = graph.mix;
    this.#master = graph.master;
    this.#node.port.onmessage = (e) => this.#onWorkletMessage(e.data);

    this.#applyGain(ctx, 0);
    // 握手:确认注册名 'pluck' 背后确实是我们的处理器(而不是同名别人)
    this.#node.port.postMessage({ t: 'ping' });
  }

  /**
   * 开关配乐。
   *
   * 关闭时会 flush 工作节点的事件队列:不清的话,重新打开的那一瞬间会把
   * 这段时间积压的音符**全部同时**响出来,是一声噪音而不是音乐。
   * 重新打开时曲子从头开始(而不是接着放)—— 一个可预期的行为,免得用户
   * 听到半句悬空的旋律。
   */
  setEnabled(on: boolean): void {
    if (this.#enabled === on) return;
    this.#enabled = on;
    const ctx = this.#ctx;
    if (!ctx) return;
    this.#applyGain(ctx, FADE);
    if (!on) {
      this.#node?.port.postMessage({ t: 'flush' });
      this.#anchored = false;
    } else {
      // 下一帧 update() 重新锚定并从第 0 个音开始
      this.#anchored = false;
    }
  }

  /**
   * 用 worldTime 推进配乐。每帧调用。
   *
   * dt 只用于记账 —— 调度完全由 worldTime 推出来(见文件头)。
   */
  update(worldTime: number, dt: number): void {
    this.#elapsed += dt;

    const ctx = this.#ctx;
    if (!ctx || !this.#enabled || this.#disposed) return;
    // 挂起时不下发:此时排下去的时间全是"过去",恢复后会一起爆出来。
    // 恢复后的漂移由下面的自愈分支收拾。
    if (ctx.state !== 'running') return;
    if (!this.#node) return;

    if (!this.#anchored) this.#reanchor(ctx.currentTime, worldTime);

    const ctxNow = ctx.currentTime;
    // 两边各自从锚点算起走了多久。相减就是漂移;锚定那一刻它恰好是 0,
    // 所以 START_DELAY 这个"提前量"不会把自己误判成失步。
    const drift = ctxNow - this.#anchorCtx - (worldTime - this.#anchorWorld);
    if (Math.abs(drift) > RESYNC_TOLERANCE) {
      // 切标签页时 rAF 停了、音频钟还在走。不重新对齐就会把这段空白期
      // 的音符一次性倒出来,而且之后永远对不上。
      this.#resyncs++;
      this.#reanchor(ctxNow, worldTime);
    }

    const horizon = ctxNow + LOOKAHEAD;
    const comp = this.#composition;
    const notes = comp.notes;
    let guard = 0;
    while (guard++ < MAX_SCHEDULE_PER_UPDATE) {
      if (this.#nextIndex >= notes.length) {
        // 循环:这一遍结束就接下一遍。收尾的长音还在响,听不出来接缝。
        this.#nextIndex = 0;
        this.#pieceAudioOrigin += compositionSeconds(comp);
        continue;
      }
      const ev = notes[this.#nextIndex]!;
      const at = this.#pieceAudioOrigin + tickSeconds(comp, ev.tick);
      if (at > horizon) break;
      this.#dispatch(ev, at);
      this.#nextIndex++;
    }

    this.#statsClock += dt;
    if (this.#statsClock >= STATS_INTERVAL) {
      this.#statsClock = 0;
      this.#node.port.postMessage({ t: 'query' });
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#enabled = false;
    void this.#teardown();
  }

  get diagnostics(): AudioDiagnostics {
    const comp = this.#composition;
    return {
      contextState: this.state,
      sampleRate: this.#ctx?.sampleRate ?? 0,
      workletSource: this.#workletKind,
      workletUrl,
      workletError: this.#workletError,
      workletInfo: this.#workletInfo,
      enabled: this.#enabled,
      scheduled: this.#scheduled,
      resyncs: this.#resyncs,
      elapsed: Math.round(this.#elapsed * 1000) / 1000,
      worklet: { ...this.#workletStats },
      composition: {
        seed: comp.seed,
        notes: comp.notes.length,
        totalTicks: comp.totalTicks,
        seconds: Math.round(compositionSeconds(comp) * 100) / 100,
        fingerprint: this.#fingerprint,
      },
    };
  }

  // ------------------------------------------------------------------------

  #reanchor(ctxNow: number, worldTime: number): void {
    this.#anchored = true;
    this.#anchorCtx = ctxNow;
    this.#anchorWorld = worldTime;
    this.#pieceAudioOrigin = ctxNow + START_DELAY;
    this.#nextIndex = 0;
    this.#node?.port.postMessage({ t: 'flush' });
  }

  #dispatch(ev: NoteEvent, at: number): void {
    const node = this.#node;
    if (!node) return;
    const timbre = TIMBRES[ev.instrument];
    node.port.postMessage({
      t: 'pluck',
      at,
      freq: degreeHz(ev.degree, ev.octave),
      decay: timbre.decay,
      brightness: timbre.brightness,
      // 力度曲线:线性力度听感上"轻的太重" —— 人耳对响度是对数的
      gain: (ev.velocity / 127) ** 1.4 * timbre.gain,
      pan: timbre.pan,
      hold: tickSeconds(this.#composition, ev.hold),
      // 整数种子 → 激励噪声也可复现(见 worklets/pluck-processor.js)
      seed: noteSeed(ev),
    });
    this.#scheduled++;
  }

  #applyGain(ctx: BaseAudioContext, ramp: number): void {
    const mix = this.#mix;
    if (!mix) return;
    const target = this.#enabled ? MASTER_GAIN : 0;
    const g = mix.gain;
    const now = ctx.currentTime;
    g.cancelScheduledValues(now);
    if (ramp <= 0) {
      g.value = target;
      return;
    }
    // 从当前值起步 —— 直接 setValueAtTime(target) 会跳变(咔)
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(target, now + ramp);
  }

  #onWorkletMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as { t?: string } & Record<string, unknown>;
    if (msg.t === 'stats') {
      this.#workletStats = {
        active: Number(msg.active ?? 0),
        started: Number(msg.started ?? 0),
        dropped: Number(msg.dropped ?? 0),
        flushed: Number(msg.flushed ?? 0),
        stolen: Number(msg.stolen ?? 0),
        peak: Number(msg.peak ?? 0),
        // 工作节点回话里的 currentTime 是它**发消息那一刻**的钟,这边的
        // ctx.currentTime 是**收到那一刻**的钟。差里含一次消息往返(几毫秒),
        // 对"几十毫秒还是几秒"这个判断无影响,不去做无谓的补偿。
        clockSkew: this.#ctx ? Number(msg.currentTime ?? 0) - this.#ctx.currentTime : 0,
        blocks: Number(msg.blocks ?? 0),
        maxGap: Number(msg.maxGap ?? 0),
      };
    } else if (msg.t === 'pong') {
      this.#workletInfo = {
        sampleRate: Number(msg.sampleRate ?? 0),
        voices: Number(msg.voices ?? 0),
        version: Number(msg.version ?? 0),
      };
    }
  }

  async #teardown(): Promise<void> {
    const node = this.#node;
    const ctx = this.#ctx;
    this.#node = null;
    this.#mix = null;
    this.#master = null;
    this.#ctx = null;
    this.#anchored = false;
    if (node) {
      node.port.onmessage = null;
      try {
        node.disconnect();
      } catch {
        /* 已断开 */
      }
    }
    if (ctx && ctx.state !== 'closed') {
      try {
        await ctx.close();
      } catch {
        /* 已经关了 */
      }
    }
  }
}

// --------------------------------------------------------------------------
// 离线渲染
// --------------------------------------------------------------------------

export interface OfflineRenderOptions {
  seconds: number;
  sampleRate?: number;
  /** 要渲染的音符。默认取整首曲子的开头一段。 */
  notes?: readonly NoteEvent[];
  /** notes 用的乐句表(默认就是本作品那一份) */
  composition?: Composition;
  /** 第一个音离 t=0 的间隔,默认 0.05s */
  leadIn?: number;
}

export interface OfflineRenderResult {
  buffer: AudioBuffer;
  load: WorkletLoadResult;
  notes: number;
}

/**
 * 离线渲染 —— 用**与实时完全相同**的图与同一份 worklet 源码,把一段配乐
 * 渲染成 PCM。
 *
 * 为什么要有它
 * ------------
 * "有没有声音"必须能被证明,而不是"没报错就等于出声了"。实时图依赖音频
 * 设备与用户手势,在无头环境/静音设备上量到的可能是 0;离线渲染不依赖
 * 任何设备,而且**逐位可复现**(激励噪声也来自整数种子)。
 *
 * 它同时是一条真正的端到端检查:worklet 加载 → 起音 → 环路 → 混响 → 限幅,
 * 少一环都出不来非零 PCM。
 */
export async function renderOffline(opts: OfflineRenderOptions): Promise<OfflineRenderResult> {
  const sampleRate = opts.sampleRate ?? 48000;
  const comp = opts.composition ?? buildComposition();
  const leadIn = opts.leadIn ?? 0.05;
  // 默认渲染"窗口内全部音符"。⚠️ 别按半个窗口取 —— 那样 12 秒的渲染只会落下
  // 开头两三个音,后面十秒是这三个音的余音在衰,量到的包络是单调下降的,
  // 看起来"音乐在衰减",其实只是取错了音符集合。
  const notes =
    opts.notes ??
    comp.notes.filter((n) => leadIn + tickSeconds(comp, n.tick) < opts.seconds);

  const ctx = new OfflineAudioContext(2, Math.ceil(opts.seconds * sampleRate), sampleRate);
  const load = await loadPluckModule(ctx);
  const graph = buildGraph(ctx);
  // 离线没有"用户手势"这回事,直接把电平拉满
  graph.mix.gain.value = MASTER_GAIN;

  for (const ev of notes) {
    const timbre = TIMBRES[ev.instrument];
    graph.node.port.postMessage({
      t: 'pluck',
      at: leadIn + tickSeconds(comp, ev.tick),
      freq: degreeHz(ev.degree, ev.octave),
      decay: timbre.decay,
      brightness: timbre.brightness,
      gain: (ev.velocity / 127) ** 1.4 * timbre.gain,
      pan: timbre.pan,
      hold: tickSeconds(comp, ev.hold),
      seed: noteSeed(ev),
    });
  }

  return { buffer: await ctx.startRendering(), load, notes: notes.length };
}
