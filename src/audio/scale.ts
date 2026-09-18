/**
 * 三分损益律 —— 本作品的音高系统。
 *
 * 为什么不用十二平均律
 * --------------------
 * 配器是古琴与古筝,两件乐器的空弦音程都来自三分损益。三分损益的每个音
 * 都是 3^k/2^m,而平均律的每个音都是 2^(n/12) —— 两者**名字一样、数值不同**:
 *
 *     音名   三分损益    本律音分    平均律音分   差
 *     宫     1/1            0.00        0.00     0
 *     商     9/8          203.91      200.00    +3.91
 *     角     81/64        407.82      400.00    +7.82
 *     徵     3/2          701.96      700.00    +1.96
 *     羽     27/16        905.87      900.00    +5.87
 *
 * 3~8 音分在单音上听不出来,但在**长音的和音**上会变成拍频:徵与宫差 1.96
 * 音分,按宫 = 130.81Hz 算,拍频 ≈ 0.15Hz —— 一个持续两秒的散音上能听见
 * "嗡"的一下。古琴曲里最动人的恰好就是这种长音,所以这里不能用"反正五声
 * 差不多"的平均律近似。
 *
 * ⚠️ 比值一律**算出来**,不手抄
 * ----------------------------
 * 三分损益的生成规则只有一句话:损一(×3/2)与益一(×3/4)交替。
 *
 *     宫 --损一--> 徵 --益一--> 商 --损一--> 羽 --益一--> 角
 *     1           3/2         9/8         27/16        81/64
 *
 * 下面 `generateFiveTones()` 就是照这句话算的,并在模块加载时与规格手写的
 * 比值逐个比对,对不上**直接抛错**。手抄五个分数,错一个(比如把 81/64 写成
 * 81/32)在谱面上完全看不出来,只能靠耳朵 —— 而耳朵要等到整首曲子做出来
 * 才会发现。宁可让它在 import 的那一刻炸掉。
 */

// --------------------------------------------------------------------------
// 音级
// --------------------------------------------------------------------------

export type Degree = 'gong' | 'shang' | 'jue' | 'zhi' | 'yu';

export interface DegreeInfo {
  readonly id: Degree;
  /** 五声名 —— 打印谱面与诊断用 */
  readonly name: string;
  /** 与宫(1/1)的频率比 */
  readonly ratio: number;
  /**
   * 相生链上的序号,即 3^k 的 k:宫 0 → 徵 1 → 商 2 → 羽 3 → 角 4。
   *
   * ⚠️ 它**不是**音阶次序(音阶次序是宫商角徵羽)。旋宫转调靠的是相生
   *    链上的步进,把这一个字段当成音阶下标来用,转调会转到隔壁调上去。
   */
  readonly chain: number;
}

/** 基准宫 = C3 = 130.81 Hz。规格给定,不做等音换算。 */
export const GONG_HZ = 130.81;

/** 相生次序。生成与旋宫都按这个次序走。 */
const CHAIN_ORDER: readonly Degree[] = ['gong', 'zhi', 'shang', 'yu', 'jue'];

/** 规格里手写的比值 —— **只在加载期自检用**,运行时一律用生成值。 */
const SPEC_RATIOS: Readonly<Record<Degree, number>> = {
  gong: 1 / 1,
  shang: 9 / 8,
  jue: 81 / 64,
  zhi: 3 / 2,
  yu: 27 / 16,
};

/**
 * 按"损一 / 益一 交替"从宫推出五声。
 *
 * 返回 相生链上的第 i 个音 → 比值。注意返回顺序是**相生次序**,调用方
 * 负责按音阶次序摆放。
 */
function generateFiveTones(): { degree: Degree; ratio: number }[] {
  const out: { degree: Degree; ratio: number }[] = [];
  let ratio = 1;
  for (let i = 0; i < CHAIN_ORDER.length; i++) {
    out.push({ degree: CHAIN_ORDER[i]!, ratio });
    // 损一(×3/2)与益一(×3/4)交替。第一次是损一。
    ratio *= i % 2 === 0 ? 3 / 2 : 3 / 4;
  }
  return out;
}

const GENERATED = generateFiveTones();

/**
 * 五声表(按音阶次序:宫 商 角 徵 羽)。
 *
 * 比值来自 `GENERATED` —— 即算出来的,不是抄来的。
 */
export const DEGREES: readonly DegreeInfo[] = [
  { id: 'gong', name: '宫', ratio: pick('gong'), chain: 0 },
  { id: 'shang', name: '商', ratio: pick('shang'), chain: 2 },
  { id: 'jue', name: '角', ratio: pick('jue'), chain: 4 },
  { id: 'zhi', name: '徵', ratio: pick('zhi'), chain: 1 },
  { id: 'yu', name: '羽', ratio: pick('yu'), chain: 3 },
];

function pick(id: Degree): number {
  const hit = GENERATED.find((g) => g.degree === id);
  if (!hit) throw new Error(`三分损益生成表里没有音级 ${id}`);
  return hit.ratio;
}

// --------------------------------------------------------------------------
// 加载期自检 —— 对不上就炸,不留到听感阶段
// --------------------------------------------------------------------------

{
  for (const d of DEGREES) {
    const spec = SPEC_RATIOS[d.id];
    if (Math.abs(d.ratio - spec) > 1e-12) {
      throw new Error(
        `三分损益与规格不符:${d.name} 算出来 ${d.ratio},规格写的是 ${spec}。` +
          `生成规则是"损一(×3/2)与益一(×3/4)交替",先查 CHAIN_ORDER 的次序。`,
      );
    }
    const chainIdx = CHAIN_ORDER.indexOf(d.id);
    if (chainIdx !== d.chain) {
      throw new Error(`音级 ${d.name} 的 chain=${d.chain},但相生次序里它在第 ${chainIdx} 位`);
    }
  }
}

// --------------------------------------------------------------------------
// 查询
// --------------------------------------------------------------------------

export function degreeInfo(degree: Degree): DegreeInfo {
  const d = DEGREES.find((x) => x.id === degree);
  if (!d) throw new Error(`未知音级 ${degree}`);
  return d;
}

export function degreeRatio(degree: Degree): number {
  return degreeInfo(degree).ratio;
}

/**
 * 频率。octave 是相对基准宫的八度偏移(0 = C3 那一组,1 = 高八度,-1 = 低八度)。
 * 整数八度在二进制里是精确的,所以同一音级在任何八度上的比值都精确。
 */
export function degreeHz(degree: Degree, octave = 0): number {
  return GONG_HZ * degreeRatio(degree) * 2 ** octave;
}

/** 比值 → 音分。 */
export function cents(ratio: number): number {
  return 1200 * Math.log2(ratio);
}

export interface TuningRow {
  name: string;
  id: Degree;
  ratio: number;
  cents: number;
  /** 同名平均律音的音分(宫=0, 商=200, 角=400, 徵=700, 羽=900) */
  equalCents: number;
  /** 与平均律的差(音分)。这是"必须用三分损益"这句话的量化依据。 */
  deviation: number;
}

const EQUAL_CENTS: Readonly<Record<Degree, number>> = {
  gong: 0,
  shang: 200,
  jue: 400,
  zhi: 700,
  yu: 900,
};

/** 律制对照表 —— 验收脚本打印它,证明用的确实是三分损益而不是平均律。 */
export function tuningTable(): TuningRow[] {
  return DEGREES.map((d) => {
    const c = cents(d.ratio);
    return {
      id: d.id,
      name: d.name,
      ratio: d.ratio,
      cents: c,
      equalCents: EQUAL_CENTS[d.id],
      deviation: c - EQUAL_CENTS[d.id],
    };
  });
}

// --------------------------------------------------------------------------
// 旋宫转调
// --------------------------------------------------------------------------

/** 3^k(k ≥ 0)。3^33 以内 double 可精确表示,这里 k 远小于该上限。 */
function pow3(k: number): number {
  let v = 1;
  for (let i = 0; i < k; i++) v *= 3;
  return v;
}

/** 把频率倍数折进 [1, 2),返回折出来的八度。除以 2 对 double 是精确的。 */
function foldOctave(pitch: number): { ratio: number; octave: number } {
  let r = pitch;
  let octave = 0;
  while (r >= 2) {
    r /= 2;
    octave++;
  }
  while (r < 1) {
    r *= 2;
    octave--;
  }
  return { ratio: r, octave };
}

/** 角再往上一步得到的变宫:3^5 = 243,折进八度是 243/128。 */
const BIAN_GONG = 243 / 128;

export interface Pitch {
  degree: Degree;
  octave: number;
}

/**
 * 沿相生链上移 steps 步(每步 = 损一 ×3/2),这就是"旋宫"。
 *
 * ⚠️ 变宫必须**显式**处理
 * ----------------------
 * 角再往上一步是变宫(243/128),已经出了五声。传统做法是"以变宫为宫",
 * 即把它折到上方的宫。
 *
 * 不能靠"就近折算并放宽容差"来兜底:变宫离上方的宫有 90 音分,离五声里
 * 最近的音也有 90 音分 —— 容差只要开到 90 音分以上,别的错(比如把某个音
 * 写成了变徵)就会**一起**被悄悄吞掉,而它们是真的走音。所以这里分支写死,
 * 其余情况一律抛错。
 *
 * 往下走(负步)不提供:1/3 在二进制里不精确,而"下五度"用上移若干步再落
 * 八度就能表达 —— 少一条会漂的路径。
 */
export function transposeUp(degree: Degree, octave: number, steps: number): Pitch {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new Error(`transposeUp 只接受非负整数步,收到 ${steps}`);
  }
  const pitch = degreeRatio(degree) * 2 ** octave * 1.5 ** steps;
  const folded = foldOctave(pitch);

  let best: DegreeInfo | null = null;
  let bestErr = Infinity;
  for (const d of DEGREES) {
    const err = Math.abs(d.ratio - folded.ratio);
    if (err < bestErr) {
      bestErr = err;
      best = d;
    }
  }

  // 1e-12 不是"宽容",而是"精确匹配"的浮点写法:上面的乘除全是 2 的幂与
  // 3^k/2^m,结果在 double 里是精确的,唯一的不确定来自 1.5**steps 的舍入。
  if (best && bestErr < 1e-12) return { degree: best.id, octave: folded.octave };

  if (Math.abs(folded.ratio - BIAN_GONG) < 1e-12) {
    return { degree: 'gong', octave: folded.octave + 1 };
  }

  throw new Error(
    `旋宫失败:${degree} 上移 ${steps} 步得到 ${folded.ratio},既不在五声内也不是变宫。` +
      `本作品只用五声,请改动机或减少步数。`,
  );
}
