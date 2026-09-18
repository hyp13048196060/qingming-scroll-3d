/**
 * Karplus-Strong 拨弦 —— 手写环形缓冲的环路。
 *
 * ⚠️ 为什么不能用 DelayNode 搭反馈环
 * ---------------------------------
 * Web Audio 的图是**按渲染量子(128 采样)块处理**的。为了让"输出回接到
 * 输入"这种环有确定的解,实现会在环路里强制插入一个渲染量子的延迟 ——
 * 也就是说 feedback 路径至少多 128 个采样。
 *
 * 我们的环路长度就是**弦长**:宫 C3 = 130.81Hz 在 48kHz 下是 367 个采样。
 * 环里多塞 128 个采样,等于把弦缩短了 35%,音高了约 6 个半音 —— 音准
 * 彻底废掉,而且**听起来还是"拨弦声"**,不会报错。这种错最难查:
 * 谱面上写的和耳朵听到的差了一个纯四度,却一切"正常"。
 *
 * 所以这里自己开 Float32Array 当环形缓冲,读指针按小数延迟插值,一个
 * 采样一个采样地转。环路总延迟(延迟线 + 环路滤波器的相位延迟)等于弦长,
 * 一个采样不多 —— 相位延迟那一项见 pluck() 里的 phaseDelay。
 *
 * 环路长什么样
 * ------------
 *     读 w-d(小数 d = 采样率/频率)
 *        ↓
 *     2 抽头平均低通 + 按 brightness 混回原始样本
 *        ↓
 *     × 每采样衰减 g
 *        ↓
 *     写回 w, w++
 *
 * 参数语义(两个数字都不是随手给的)
 * --------------------------------
 *   decay       **每经过一个环路(一个周期)**的振幅增益,不是每采样。
 *               若按每采样理解:0.999^367 = 0.69,一个周期就掉 31%,
 *               T60 只有 0.14 秒 —— 那不是琴,是"咔"。
 *               按每周期理解:τ = 1/(f·|ln decay|),0.999 → 7.6 秒(古琴),
 *               0.997 → 2.5 秒(古筝)。两个数这才像弦。
 *   brightness  环路滤波器在**奈奎斯特处**的增益。0 = 纯 2 抽头平均(最暗),
 *               1 = 不滤波(最亮)。写成这个形式是为了可解释:
 *               "混回多少原始样本"与"高频保留多少"是同一个数。
 *
 * 这个文件是**纯 JS,不进 TypeScript 编译**,因为 AudioWorklet 只接受
 * 浏览器能直接求值的模块。它由 AudioEngine 以 ?url 引入(快路径),
 * 并以 ?raw 内联成 Blob 兜底(部署路径 404 时用)。
 */

/** 声部数。古琴能响 7 秒,琶音又是密织体,少了会不断抢声部。 */
const MAX_VOICES = 32;
/** 环路频率下限 —— 只用来定环形缓冲容量。本作品最低音是宫 -1 = 65.4Hz。 */
const MIN_LOOP_FREQ = 40;
/** 一个渲染量子能起多少音。正常远达不到,只是防病态输入撑爆数组。 */
const MAX_STARTS_PER_BLOCK = 64;
/** 低于此电平的声部直接判死(-100dB,听不见,但白占声部还会喂出 denormal)。 */
const QUIET_LEVEL = 1e-5;
/** 事件已经过期这么久就丢掉,而不是"立刻补响"。 */
const STALE_SECONDS = 0.08;

class Voice {
  constructor(capacity) {
    this.cap = capacity;
    this.buf = new Float32Array(capacity);
    this.active = false;
    this.w = 0;
    this.delay = 1;
    this.prev = 0;
    this.brightness = 0.5;
    this.g = 0.999;
    this.gain = 1;
    this.gL = Math.SQRT1_2;
    this.gR = Math.SQRT1_2;
    /** 本块(128 采样)的输出峰值 —— 抢声部按它排序 */
    this.level = 0;
    /** 已经响了几个块 —— 刚起音的声部不能因为第一块恰好很轻就被判死 */
    this.age = 0;
    this.protectUntil = 0;
    this.stolenBlock = -1;
  }

  /**
   * 起音。
   * @param at 本次起音的音频时间(秒)—— 用于"抢声部保护"窗口
   * @returns 是否真的起了音
   */
  pluck(ev, at, sampleRate) {
    let freq = ev.freq;
    if (!(freq > 0) || !Number.isFinite(freq)) return false;

    this.brightness = Math.min(1, Math.max(0, ev.brightness));
    this.gain = Math.max(0, ev.gain);

    // 环路长度 = 弦长 - 滤波器的相位延迟。
    //
    // ⚠️ 这一项不能省。2 抽头平均滤波器在低频处的相位延迟是 0.5·(1-brightness)
    //    个采样(推导:滤波器的传递函数是 (0.5+0.5b) + 0.5(1-b)z⁻¹,群延迟 =
    //    0.5(1-b))。它对**环路**来说是纯延迟,直接加在弦长上。
    //    不补的话:宫(b=0.35)低 1.5 音分、羽低 2.6 音分,**而且高音低得更多**
    //    —— 音程被系统性压窄。本作的全部立论就在音分级的音程差上(三分损益的
    //    徵是 701.96、平均律是 700,差 1.96 音分),补不补这一项,恰好决定了
    //    "谱面写着三分损益、响出来却是平均律"这件事会不会发生。
    //    实测:补之前五个音分别低 1.51/1.69/1.84/2.26/2.57 音分,补之后见
    //    tools/probe_audio.mjs 第 6 节的"与三分损益"一列。
    const phaseDelay = 0.5 * (1 - this.brightness);

    // 环路长度必须落在 [2, cap-2]:太短(超过奈奎斯特)KS 的模型就不成立,
    // 太长会越界写坏内存。夹住并让调用方计数,宁可音不准也不能写坏。
    const dMax = this.cap - 2;
    let d = sampleRate / freq - phaseDelay;
    if (d < 2) d = 2;
    if (d > dMax) d = dMax;
    this.delay = d;

    // 等功率声像。线性 pan 会让中间位置听起来比两侧轻 3dB。
    const th = (Math.min(1, Math.max(-1, ev.pan)) + 1) * 0.25 * Math.PI;
    this.gL = Math.cos(th);
    this.gR = Math.sin(th);

    // decay 是**每周期**增益 → 换算成每采样。周期长度随音高变,所以这个
    // 换算不能省:少了它,高音的衰减速度会是低音的好几倍(同一个参数)。
    this.g = Math.pow(ev.decay, 1 / d);

    // —— 激励 ——
    //
    // 一段低通白噪声:指甲/拨片擦过弦的宽带冲击。三个细节:
    //  1. 必须低通。纯白噪声在高频上能量太足,听起来是"沙"不是"弦"。
    //     低通系数同样由 brightness 控制,两个音色的差别才贯穿起振与延音。
    //  2. 长度约一个周期。太短只剩"咔"一声(没有弦的周期性),太长低音
    //     会"打嗝"(激励还没走完一圈,环路已经开始反馈)。
    //  3. 只用**整数种子**的 xorshift,不用 Math.random —— 激励也要可复现,
    //     否则"离线渲染两次得到同一段 PCM"这条断言就立不住。
    const n = Math.ceil(d);
    const a = 0.25 + 0.6 * this.brightness;
    let s = (ev.seed | 0) || 0x2545f491;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const white = ((s >>> 0) / 4294967296) * 2 - 1;
      lp += a * (white - lp);
      // 激励段自身也带一点收束,不然开头几个周期是"方"的
      this.buf[i] = lp * (1 - 0.35 * (i / n));
    }
    // ⚠️ 环路初值必须接上激励的尾巴。不接(留 0)等于在激励里插了一个阶跃,
    //    第一个周期会多一次宽带冲击,听感是"咔"—— 很轻,但所有音都有。
    this.prev = this.buf[n - 1];
    this.w = n >= this.cap ? 0 : n;

    this.level = 0;
    this.age = 0;
    // 保护窗口:这声还没到"该响的时候"就别抢它
    this.protectUntil = at + Math.min(2, (ev.hold || 0) * 0.5);
    this.active = true;
    return true;
  }

  /** 推进一个采样,返回这一采样的输出。 */
  tick() {
    const cap = this.cap;
    let r = this.w - this.delay;
    if (r < 0) r += cap;
    const i0 = Math.floor(r);
    const frac = r - i0;
    const i1 = i0 + 1 >= cap ? 0 : i0 + 1;

    const s0 = this.buf[i0];
    const delayed = s0 + frac * (this.buf[i1] - s0);

    // 2 抽头平均低通,再按 brightness 混回原始样本:
    // 奈奎斯特处增益正好等于 brightness,一个参数说清"多亮"。
    const avg = 0.5 * (delayed + this.prev);
    const filtered = avg + this.brightness * (delayed - avg);

    let v = this.g * filtered;
    // 去归一化数在 x86 上会触发微码陷阱(单核性能掉几十倍)。环路衰减到
    // 1e-20 以下的信息早就听不见了,直接归零。
    if (v > -1e-20 && v < 1e-20) v = 0;
    this.buf[this.w] = v;
    this.prev = delayed;

    this.w++;
    if (this.w >= cap) this.w = 0;

    const abs = delayed < 0 ? -delayed : delayed;
    if (abs > this.level) this.level = abs;

    return delayed;
  }
}

class PluckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // 容量按采样率算,不写死:96kHz 下同一根弦要两倍的采样数。
    const cap = Math.ceil(sampleRate / MIN_LOOP_FREQ) + 4;
    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice(cap));

    // 待起音事件,按 at 升序。用一个"插入排序"的数组,而不是每块重排:
    // 调度器推事件的时间是单调的,但一旦将来有人插了乱序的事件,数组序
    // 一旦被破坏,后到的音就会永远卡在队里发不出来 —— 不报错,只是没声。
    this.pending = [];
    this.startAt = new Int32Array(MAX_STARTS_PER_BLOCK);
    this.startEv = new Array(MAX_STARTS_PER_BLOCK);
    this.startCount = 0;

    this.started = 0;
    this.dropped = 0;
    this.stolen = 0;
    // 与 dropped 分开计:flush 是**主动**丢弃(时钟失步后清队,正常行为),
    // dropped 是**被动**丢弃(事件来晚了)。混在一个数里,线上看到一个非零值
    // 就分不清是"重同步了一次"还是"主线程一直在卡"。
    this.flushed = 0;
    this.peak = 0;
    this.blockId = 0;

    // 渲染循环本身的体检数据。
    //
    // ⚠️ 为什么要记 maxGap:process() 是本节点的**全部**生命活动 —— 它不被
    //    调用,音符就永远排着不发。正常情况它每 128 采样(48kHz 下 2.67ms)被
    //    调一次,maxGap 也在这一量级。而"排下去的音响得比预期晚好几秒、
    //    dropped/resyncs 却都是 0"这种怪事,只有把相邻两次调用之间的间隔量
    //    出来才能判:要么是渲染循环真的停过(设备没来取),要么是事件没送到。
    //    没有这个数,这两种情况的现场一模一样。
    this.blocks = 0;
    this.lastBlockAt = -1;
    this.maxGap = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (!msg) return;
    switch (msg.t) {
      case 'pluck':
        this.pushSorted(msg);
        break;
      case 'flush': {
        // 时钟失步(切标签页回来)时用。不清队的话,积压的事件会在恢复的
        // 那一瞬间**全部同时**响出来 —— 一片噪音,而不是音乐。
        this.flushed += this.pending.length;
        this.pending.length = 0;
        break;
      }
      case 'query':
        this.port.postMessage({
          t: 'stats',
          active: this.activeVoices(),
          started: this.started,
          dropped: this.dropped,
          stolen: this.stolen,
          flushed: this.flushed,
          peak: this.peak,
          sampleRate,
          voices: MAX_VOICES,
          currentTime,
          blocks: this.blocks,
          maxGap: this.maxGap,
        });
        this.peak = 0;
        break;
      case 'ping':
        // 握手:用来证明加载到的**确实是这个** processor,而不是同名的别人
        this.port.postMessage({ t: 'pong', sampleRate, voices: MAX_VOICES, version: 1 });
        break;
      default:
        break;
    }
  }

  pushSorted(ev) {
    const p = this.pending;
    let i = p.length;
    while (i > 0 && p[i - 1].at > ev.at) i--;
    if (i === p.length) p.push(ev);
    else p.splice(i, 0, ev);
  }

  activeVoices() {
    let n = 0;
    for (let i = 0; i < this.voices.length; i++) if (this.voices[i].active) n++;
    return n;
  }

  alloc(now, blockId) {
    const vs = this.voices;
    for (let i = 0; i < vs.length; i++) {
      if (!vs[i].active) return vs[i];
    }
    // 全忙:抢**最轻**的那个,而不是最老的。
    // 最老的那个往往还在响(古琴能响 7 秒),抢它会听到明显的断音;
    // 抢最轻的,被掐掉的本来就已经淹没在别的音里了。
    //
    // ⚠️ 两个加成项都是必须的:
    //   +1e9 保护期内(刚起音、还没到该响的时候)的声部排到最后;
    //   +1e6 本块已经被抢过的声部不能**再**被抢一次 —— 同一块里连起 5 个
    //        音时,所有声部的 level 都是 0(还没 tick 过),不加这一项就会
    //        5 次全都抢同一个声部,前面 4 个音凭空消失。
    let best = vs[0];
    let bestScore = Infinity;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      let score = v.level;
      if (now < v.protectUntil) score += 1e9;
      if (v.stolenBlock === blockId) score += 1e6;
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
    best.stolenBlock = blockId;
    this.stolen++;
    return best;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const L = out[0];
    const R = out.length > 1 ? out[1] : null;
    const frames = L.length;

    for (let i = 0; i < frames; i++) {
      L[i] = 0;
      if (R) R[i] = 0;
    }

    // 本渲染量子覆盖的音频时间区间。currentTime 是**本块起点**的时间,
    // 工作集里它是全局的,不能自己去读时钟(也不该:worklet 里也没有时钟)。
    const t0 = currentTime;
    const t1 = t0 + frames / sampleRate;

    // 渲染循环体检(见构造函数里的说明)
    if (this.lastBlockAt >= 0) {
      const gap = t0 - this.lastBlockAt;
      if (gap > this.maxGap) this.maxGap = gap;
    }
    this.lastBlockAt = t0;
    this.blocks++;

    // —— 取出落在本块内的事件 ——
    this.startCount = 0;
    while (this.pending.length > 0 && this.pending[0].at < t1) {
      const ev = this.pending.shift();
      const off = Math.round((ev.at - t0) * sampleRate);
      if (off < -STALE_SECONDS * sampleRate) {
        // 该响的时候它没在(时钟失步/主线程卡了半秒)。丢掉并记账 ——
        // "立刻补响"会让恢复的那一瞬间挤出一堆琶音,比丢音难听得多。
        this.dropped++;
        continue;
      }
      if (this.startCount >= MAX_STARTS_PER_BLOCK) {
        this.dropped++;
        continue;
      }
      this.startAt[this.startCount] = off < 0 ? 0 : off;
      this.startEv[this.startCount] = ev;
      this.startCount++;
    }

    // 本块电平清零 —— level 是"当前这一块有多响",抢声部按它排序
    const blockId = this.blockId++;
    for (let i = 0; i < this.voices.length; i++) {
      if (this.voices[i].active) this.voices[i].level = 0;
    }

    // —— 逐采样 ——
    let cursor = 0;
    for (let i = 0; i < frames; i++) {
      while (cursor < this.startCount && this.startAt[cursor] <= i) {
        const ev = this.startEv[cursor];
        this.startEv[cursor] = null;
        cursor++;
        const at = t0 + i / sampleRate;
        const v = this.alloc(at, blockId);
        if (!v.pluck(ev, at, sampleRate)) this.dropped++;
        else this.started++;
      }

      let l = 0;
      let r = 0;
      for (let vi = 0; vi < this.voices.length; vi++) {
        const v = this.voices[vi];
        if (!v.active) continue;
        const s = v.tick() * v.gain;
        l += s * v.gL;
        r += s * v.gR;
      }
      L[i] = l;
      if (R) R[i] = r;

      const al = l < 0 ? -l : l;
      if (al > this.peak) this.peak = al;
    }

    // 判死静音声部。age 的用处:刚起音的声部万一第一块恰好很轻(激励的
    // 头几个采样本来就可能是 0 附近),不加这个门槛会被当场判死 ——
    // 表现为"偶尔有个音不响",极难复现。
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v.active) continue;
      v.age++;
      if (v.age > 3 && v.level < QUIET_LEVEL) v.active = false;
    }

    // 永远返回 true:这个节点没有输入,一旦返回 false 就会被引擎回收。
    return true;
  }
}

registerProcessor('pluck', PluckProcessor);
