/**
 * 乐句生成 —— 固定种子 → 完全可复现的原创曲。
 *
 * 纪律
 * ----
 *   · **不读时钟**:不用 Date.now() / performance.now(),也不用 Math.random。
 *     唯一的随机源是 `mulberry32(seed)`。换台机器、换个时间、换次刷新,
 *     得到的乐句表必须逐字节相同 —— 否则"可复现"就是一句空话。
 *   · **只存整数**:表里存的是 音级 / 八度 / 力度 / 时值tick,频率一律不留。
 *     频率要经 Math.pow 与 130.81 相乘,而**浮点结果不保证跨引擎逐位一致**;
 *     把频率写进表里,指纹就会随浏览器版本漂移,"可复现"的断言立刻失效。
 *     频率在调度那一刻由 scale.ts 现算。
 *   · 种子取自 `data/spots.json` 的 seed 字段(经 `data/seeds.ts` 派生),
 *     整部作品的随机性都从这一个数出发。**本文件不写种子的字面量** ——
 *     理由见 seeds.ts。
 *
 * 曲子长什么样
 * ------------
 *   引 → 起 → 承 → 转 → 合,五段,共 36 小节。56 BPM、4/4,一小节约 4.29 秒,
 *   全曲约 154 秒,循环播放不断。
 *
 *     tick 是基本时值单位:4 tick = 1 拍(四分音符),所以 1 tick = 十六分。
 *
 *   动机是一个两小节的五声音型(32 tick),各段对它的处理不同:
 *     引  散音低八度起句,只露动机的头两个音
 *     起  古琴完整陈述,古筝在句尾应和
 *     承  古筝铺琶音,古琴在其上走长音
 *     转  整句**旋宫**上移五度(见 scale.ts 的 transposeUp),古筝加密
 *     合  回宫、放慢、低八度散音收尾
 */

import { mulberry32 } from './rng';
import { COMPOSITION_SEED } from '../data/seeds';
import { transposeUp, type Degree } from './scale';

// --------------------------------------------------------------------------
// 常量
// --------------------------------------------------------------------------

export const BPM = 56;
/** 每拍 tick 数。4 → 1 tick = 十六分音符。 */
export const TICKS_PER_BEAT = 4;
export const BEATS_PER_BAR = 4;
export const TICKS_PER_BAR = TICKS_PER_BEAT * BEATS_PER_BAR;

export type Instrument = 'qin' | 'zheng';

export interface NoteEvent {
  /** 起点,单位 tick */
  tick: number;
  instrument: Instrument;
  degree: Degree;
  /** 相对基准宫(C3)的八度偏移 */
  octave: number;
  /** 0..127 */
  velocity: number;
  /** 时值,单位 tick。拨弦乐器没有 noteOff,它只用于记谱、诊断与"抢声部保护"。 */
  hold: number;
}

export interface Section {
  name: string;
  startTick: number;
  bars: number;
}

export interface Composition {
  seed: number;
  bpm: number;
  ticksPerBeat: number;
  beatsPerBar: number;
  totalTicks: number;
  sections: Section[];
  /** 按 tick 升序。调度器按下标推进,乱序会导致漏音/抢拍。 */
  notes: NoteEvent[];
}

// --------------------------------------------------------------------------
// 节奏细胞
// --------------------------------------------------------------------------

/**
 * 动机的节奏型,单位 tick,每个都必须正好等于一个小句(32 tick = 2 小节)。
 *
 * ⚠️ 和必须是 32 —— 下面加载期会断言。写错一个数,动机就会跨进下一句,
 *    而且是"听起来有点怪"那种错,不会报错。
 */
export const RHYTHM_CELLS: readonly (readonly number[])[] = [
  [8, 8, 8, 8],
  [12, 4, 8, 8],
  [4, 4, 8, 16],
  [8, 4, 4, 16],
  [4, 8, 4, 16],
  [16, 4, 4, 8],
  [4, 4, 4, 4, 16],
  [12, 4, 4, 12],
];

const PHRASE_TICKS = TICKS_PER_BAR * 2;

for (const cell of RHYTHM_CELLS) {
  const sum = cell.reduce((a, b) => a + b, 0);
  if (sum !== PHRASE_TICKS) {
    throw new Error(`节奏细胞 [${cell.join(',')}] 合计 ${sum} tick,应为 ${PHRASE_TICKS}`);
  }
}

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

function pick<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length) % arr.length]!;
}

function intBetween(rnd: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

/**
 * 抽一个音级。权重按"五声的调心"给:宫、徵是骨架,羽、商次之,角最少 ——
 * 均匀抽取会让旋律失去调性,听起来像音阶练习。
 */
function weightedDegree(rnd: () => number): Degree {
  const table: readonly [Degree, number][] = [
    ['gong', 4],
    ['zhi', 4],
    ['shang', 2],
    ['yu', 2],
    ['jue', 1],
  ];
  const total = table.reduce((a, [, w]) => a + w, 0);
  let x = rnd() * total;
  for (const [d, w] of table) {
    x -= w;
    if (x <= 0) return d;
  }
  return 'gong';
}

function emit(
  out: NoteEvent[],
  tick: number,
  instrument: Instrument,
  degree: Degree,
  octave: number,
  velocity: number,
  hold: number,
): void {
  out.push({
    tick,
    instrument,
    degree,
    octave,
    velocity: Math.max(1, Math.min(127, Math.round(velocity))),
    hold: Math.max(1, Math.round(hold)),
  });
}

// --------------------------------------------------------------------------
// 动机
// --------------------------------------------------------------------------

interface MotifNote {
  degree: Degree;
  octave: number;
  hold: number;
}

interface Motif {
  notes: MotifNote[];
}

function buildMotif(rnd: () => number): Motif {
  const cell = pick(rnd, RHYTHM_CELLS);
  const notes: MotifNote[] = [];
  for (let i = 0; i < cell.length; i++) {
    // 起句落宫 —— 五声的调心。第一音不落宫的话,整句会"站不住"。
    const degree = i === 0 ? 'gong' : weightedDegree(rnd);
    // 八度:偶尔翻上去,但不跳大跳。古琴的走手音以相邻音为主。
    const octave = i > 0 && rnd() < 0.22 ? 1 : 0;
    notes.push({ degree, octave, hold: cell[i]! });
  }
  return { notes };
}

// --------------------------------------------------------------------------
// 织体
// --------------------------------------------------------------------------

interface PhraseOpts {
  instrument: Instrument;
  octaveShift?: number;
  /** 旋宫步数(沿相生链上移) */
  steps?: number;
  /** 时值倍数:2 = 放慢一倍 */
  stretch?: number;
  velocity?: number;
  /** 只取前 n 个音 */
  take?: number;
  /** 倒装(从末音往回),用于"合"段的应句 */
  reverse?: boolean;
}

/** 把动机按 opts 铺到 at 处,返回结束 tick。 */
function phrase(out: NoteEvent[], motif: Motif, at: number, opts: PhraseOpts): number {
  const {
    instrument,
    octaveShift = 0,
    steps = 0,
    stretch = 1,
    velocity = 72,
    take,
    reverse = false,
  } = opts;

  const seq = reverse ? [...motif.notes].reverse() : motif.notes;
  const used = take === undefined ? seq : seq.slice(0, take);

  let t = at;
  for (const m of used) {
    const p = steps > 0 ? transposeUp(m.degree, m.octave, steps) : m;
    emit(out, t, instrument, p.degree, p.octave + octaveShift, velocity, m.hold * stretch);
    t += m.hold * stretch;
  }
  return t;
}

/**
 * 琶音 —— 古筝的"勾托抹托"。
 *
 * 骨架音取自这一段的和音(通常两三个音),按 tickStep 逐音上行折返。
 * 首音与小节线重音加大力度:没有重音的话,一串等时值的音听起来像打字机。
 */
function arpeggio(
  out: NoteEvent[],
  at: number,
  ticks: number,
  chord: readonly { degree: Degree; octave: number }[],
  tickStep: number,
  velocity: number,
): void {
  const steps = Math.floor(ticks / tickStep);
  for (let i = 0; i < steps; i++) {
    const c = chord[i % chord.length]!;
    // 每绕完一圈骨架音就升八度,绕到顶再落回来 —— 竖琴式的上行折返。
    const lap = Math.floor(i / chord.length);
    const octave = c.octave + (lap % 2 === 0 ? 0 : 1);
    const onBeat = (at + i * tickStep) % TICKS_PER_BEAT === 0;
    emit(out, at + i * tickStep, 'zheng', c.degree, octave, velocity + (onBeat ? 14 : 0), tickStep * 3);
  }
}

/** 散音(空弦)—— 古琴最低的那根弦,一响就是整段的底。 */
function openString(
  out: NoteEvent[],
  at: number,
  degree: Degree,
  octave: number,
  hold: number,
  velocity: number,
): void {
  emit(out, at, 'qin', degree, octave, velocity, hold);
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

/** 乐句表结构。各段小节数是作曲上的决定,不是参数 —— 写死在这里,便于后来人改。 */
const SECTION_BARS: readonly { name: string; bars: number }[] = [
  { name: '引', bars: 4 },
  { name: '起', bars: 8 },
  { name: '承', bars: 8 },
  { name: '转', bars: 8 },
  { name: '合', bars: 8 },
];

export function buildComposition(seed: number = COMPOSITION_SEED): Composition {
  const rnd = mulberry32(seed);
  const out: NoteEvent[] = [];

  let cursor = 0;
  const sections: Section[] = SECTION_BARS.map((s) => {
    const sec: Section = { name: s.name, startTick: cursor, bars: s.bars };
    cursor += s.bars * TICKS_PER_BAR;
    return sec;
  });
  const totalTicks = cursor;

  const motif = buildMotif(rnd);
  const [intro, start, develop, modulate, coda] = sections as [
    Section,
    Section,
    Section,
    Section,
    Section,
  ];

  // —— 引:散音起句,只露动机的头两个音 ——
  openString(out, intro.startTick, 'gong', -1, 32, 54);
  openString(out, intro.startTick + 32, 'zhi', -1, 32, 46);
  phrase(out, motif, intro.startTick + 8, { instrument: 'qin', velocity: 58, take: 2, stretch: 2 });
  phrase(out, motif, intro.startTick + 40, {
    instrument: 'qin',
    velocity: 52,
    take: 2,
    stretch: 2,
    reverse: true,
  });

  // —— 起:古琴陈述两遍,古筝在句尾应和 ——
  {
    const p = start.startTick;
    phrase(out, motif, p, { instrument: 'qin', velocity: 78 });
    phrase(out, motif, p + PHRASE_TICKS, {
      instrument: 'qin',
      velocity: 74,
      octaveShift: 1,
      take: 3,
    });
    // 古筝应句:动机的尾巴翻高八度,给下一句留个钩子
    phrase(out, motif, p + PHRASE_TICKS + 16, {
      instrument: 'zheng',
      velocity: 62,
      octaveShift: 1,
      take: 2,
      reverse: true,
    });
    phrase(out, motif, p + 2 * PHRASE_TICKS, { instrument: 'qin', velocity: 76 });
    phrase(out, motif, p + 3 * PHRASE_TICKS, {
      instrument: 'qin',
      velocity: 70,
      octaveShift: -1,
      reverse: true,
    });
  }

  // —— 承:古筝铺琶音,古琴走长音 ——
  {
    const p = develop.startTick;
    for (let bar = 0; bar < develop.bars; bar += 2) {
      const at = p + bar * TICKS_PER_BAR;
      openString(out, at, bar % 4 === 0 ? 'gong' : 'zhi', -1, 24, 50);
      arpeggio(
        out,
        at,
        TICKS_PER_BAR * 2,
        bar % 4 === 0
          ? [
              { degree: 'gong', octave: 0 },
              { degree: 'zhi', octave: 0 },
            ]
          : [
              { degree: 'shang', octave: 0 },
              { degree: 'yu', octave: 0 },
            ],
        2,
        54,
      );
      // 古琴在其上走一个长音(宫或徵),时值跨满两小节
      emit(out, at + 8, 'qin', bar % 4 === 0 ? 'zhi' : 'gong', 0, 66, 24);
    }
    phrase(out, motif, p + develop.bars * TICKS_PER_BAR - PHRASE_TICKS, {
      instrument: 'qin',
      velocity: 72,
      octaveShift: 1,
    });
  }

  // —— 转:整句旋宫上移五度,古筝加密 ——
  {
    const p = modulate.startTick;
    phrase(out, motif, p, { instrument: 'qin', velocity: 80, steps: 1 });
    phrase(out, motif, p + PHRASE_TICKS, {
      instrument: 'qin',
      velocity: 76,
      steps: 1,
      octaveShift: 1,
      take: 3,
    });
    for (let bar = 0; bar < modulate.bars; bar += 2) {
      const at = p + bar * TICKS_PER_BAR + 32;
      if (at + TICKS_PER_BAR * 2 > p + modulate.bars * TICKS_PER_BAR) break;
      arpeggio(
        out,
        at,
        TICKS_PER_BAR * 2,
        [
          // 上五度那一段的骨架音:徵、宫(旋宫后的"宫"就是原来的徵)
          { degree: 'zhi', octave: 0 },
          { degree: 'gong', octave: 1 },
          { degree: 'shang', octave: 1 },
        ],
        1,
        58,
      );
    }
    phrase(out, motif, p + modulate.bars * TICKS_PER_BAR - PHRASE_TICKS, {
      instrument: 'qin',
      velocity: 78,
      steps: 1,
      reverse: true,
    });
  }

  // —— 合:回宫、放慢、低八度收尾 ——
  {
    const p = coda.startTick;
    openString(out, p, 'gong', -1, 32, 52);
    phrase(out, motif, p + 8, { instrument: 'qin', velocity: 70, stretch: 2 });
    phrase(out, motif, p + 8 + PHRASE_TICKS * 2, {
      instrument: 'qin',
      velocity: 62,
      stretch: 2,
      octaveShift: -1,
      reverse: true,
    });
    // 收尾:宫的低八度散音,时值越过循环点 —— 上一遍的余音与新一遍的引子
    // 叠在一起,循环点就听不出来了(拨弦乐器没有 noteOff,余音本来就会淌过去)。
    openString(out, p + coda.bars * TICKS_PER_BAR - 32, 'gong', -1, 48, 58);
    emit(out, p + coda.bars * TICKS_PER_BAR - 16, 'zheng', 'gong', 1, 44, 32);
  }

  // —— 微定时(人味)——
  //
  // 古琴是散板乐器,全压在小节线上会变成 MIDI 味。但抖动必须是**确定性的
  // 整数 tick** —— 用浮点秒或 Math.random 都会让"可复现"落空。
  // 只抖古琴:古筝的琶音是节奏骨架,抖了就散。
  for (const n of out) {
    if (n.instrument !== 'qin') continue;
    if (rnd() < 0.22 && n.tick >= TICKS_PER_BEAT) n.tick += rnd() < 0.5 ? -1 : 1;
  }

  // 画完再排一次序:各段分头生成,插入次序不等于时间次序。调度器按"下一个
  // 下标"推进,表一旦乱序就会漏音或抢拍 —— 而且只在某些段落后才暴露。
  out.sort((a, b) => a.tick - b.tick || a.octave - b.octave);

  for (let i = 1; i < out.length; i++) {
    if (out[i]!.tick < out[i - 1]!.tick) {
      throw new Error('乐句表排序失败 —— 调度器会漏音,必须修生成逻辑');
    }
  }

  return {
    seed,
    bpm: BPM,
    ticksPerBeat: TICKS_PER_BEAT,
    beatsPerBar: BEATS_PER_BAR,
    totalTicks,
    sections,
    notes: out,
  };
}

// --------------------------------------------------------------------------
// 时间换算与指纹
// --------------------------------------------------------------------------

export function tickSeconds(comp: Composition, tick: number): number {
  return (tick / comp.ticksPerBeat) * (60 / comp.bpm);
}

export function compositionSeconds(comp: Composition): number {
  return tickSeconds(comp, comp.totalTicks);
}

const INSTRUMENT_ID: Readonly<Record<Instrument, number>> = { qin: 0, zheng: 1 };

const DEGREE_ID: Readonly<Record<Degree, number>> = {
  gong: 0,
  shang: 1,
  jue: 2,
  zhi: 3,
  yu: 4,
};

/**
 * 乐句表指纹(FNV-1a, 8 位十六进制)。
 *
 * 只喂**整数** —— 见文件头。它是"同一颗种子在哪儿都长出同一棵树"的出口
 * 证据:两次构建、两台机器,这个字符串必须一模一样。
 */
export function fingerprint(comp: Composition): string {
  let h = 0x811c9dc5;
  const feed = (n: number): void => {
    for (let i = 0; i < 4; i++) {
      h ^= (n >>> (i * 8)) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
  };

  feed(comp.seed);
  feed(comp.bpm);
  feed(comp.ticksPerBeat);
  feed(comp.totalTicks);
  feed(comp.notes.length);
  for (const n of comp.notes) {
    feed(n.tick);
    feed(INSTRUMENT_ID[n.instrument]);
    feed(DEGREE_ID[n.degree]);
    feed(n.octave + 16);
    feed(n.velocity);
    feed(n.hold);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 单音种子 —— worklet 用它决定激励噪声。整数,所以激励也可复现。
 *
 * 不直接用 note 的下标:同一个音在循环里第几次出现会得到不同的种子,
 * "同一首曲子的第 3 个音"在两遍里听到的噪声应当是同一条。
 */
export function noteSeed(n: NoteEvent): number {
  let h = 0x811c9dc5;
  const feed = (v: number): void => {
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  feed(n.tick);
  feed(n.tick >>> 8);
  feed(INSTRUMENT_ID[n.instrument]);
  feed(DEGREE_ID[n.degree]);
  feed(n.octave + 16);
  feed(n.velocity);
  return (h >>> 0) & 0x7fffffff || 1;
}
