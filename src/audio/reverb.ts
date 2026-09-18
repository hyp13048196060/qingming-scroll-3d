/**
 * 混响 —— 程序化生成的指数衰减噪声 IR,喂给 ConvolverNode。
 *
 * 为什么不用现成的 IR 文件
 * ------------------------
 * 硬性要求是"零素材、可本地运行、可复现"。一个 .wav 既进不了 git 的
 * 干净历史(几 MB 的二进制),也无法解释它是怎么来的。程序化生成可以
 * 把"这个空间有多大、多亮、多湿"写成参数,还能被测试断言。
 *
 * 三条把"噪声"变成"房间"的处理
 * ----------------------------
 *   1. **指数衰减包络** —— 平的白噪声听起来是"嘶"的一声,不是混响。
 *   2. **高频随时间变暗**(`dampingSeconds`)—— 真实空间里空气与织物对
 *      高频吸收远快于低频。少了这一步,尾巴是刺的"金属沙",在长音上尤其
 *      假;这一步是本文件里最影响听感的一条。
 *   3. **早期反射** —— 前 90ms 里的几条离散反射。只有噪声尾巴的话,声音
 *      会像"贴"在耳边而不是在一个空间里;离散反射给的是空间尺寸感。
 *
 * 左右声道各用**独立**的噪声流(不是同一份延迟),否则混响会塌回单声道,
 * 而单声道混响听起来"糊"。
 */

import { mulberry32 } from './rng';
import { REVERB_SEED } from '../data/seeds';

export interface IrOptions {
  /** 尾巴长度(秒) */
  seconds: number;
  /** 高频变暗的时间常数(秒)。越小,尾巴越快变暗。 */
  dampingSeconds: number;
  /** 直达声之后的静默(秒) */
  preDelay: number;
  /** 早期反射的强度(0..1) */
  earlyLevel: number;
  /**
   * 归一化目标:IR 的 **L2 范数**(√Σh²)。
   *
   * ⚠️ 这个量只能是 L2,不能是 RMS。噪声 IR 有十几万个采样,直接卷积等于
   *    把输入乘上 √Σh² —— 若按 RMS=0.05 归一,卷积出来的湿声会比干声
   *    **响 20 倍**,一开混响就是一声轰鸣。L2 = 1 时,白噪声输入的输出
   *    RMS 恰好等于输入 RMS,湿/干的比例就可以纯粹由 wet 增益来说话。
   */
  targetL2: number;
  seed: number;
}

export const IR_DEFAULTS: IrOptions = {
  // 2.6 秒 ≈ 一个偏大的厅堂。再长会把琶音糊成一片;再短,古琴的长音就
  // 变成"干"的,失了本作品想要的水边雾气感。
  seconds: 2.6,
  dampingSeconds: 0.85,
  preDelay: 0.018,
  earlyLevel: 0.42,
  targetL2: 1,
  seed: REVERB_SEED,
};

export interface ImpulseStats {
  seconds: number;
  sampleRate: number;
  channels: number;
  peak: number;
  rms: number;
  /** L2 范数 √Σh² —— 归一化目标就是它 */
  l2: number;
  /** 量化后的指纹(见下),用于"同一颗种子生成的 IR 每次都一样"的断言 */
  checksum: string;
  /** 每 250ms 一格的 RMS(dB),用来证明尾巴确实在指数衰减而不是平的 */
  decay: { t: number; db: number }[];
}

/**
 * 生成 IR。
 *
 * ⚠️ 调用方必须把 ConvolverNode.normalize 置 false。
 *    ConvolverNode 默认 normalize = true,它会按自己的一套功率公式**重新
 *    缩放** IR —— 那样这里的 targetRms 就白做了,湿声电平还会随 IR 长度
 *    漂移(改一处秒数,混响突然变响或变轻)。
 */
export function createImpulseResponse(
  ctx: BaseAudioContext,
  overrides: Partial<IrOptions> = {},
): AudioBuffer {
  const o: IrOptions = { ...IR_DEFAULTS, ...overrides };
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.round(o.seconds * sr));
  const buf = ctx.createBuffer(2, len, sr);

  // -60dB 落在 IR 末尾:exp(-seconds/tau) = 1e-3
  const tau = o.seconds / 6.907755278982137;
  // 4ms 的起振斜坡。直接给一个阶跃的开头,卷积出来的第一拍会"啪"一下 ——
  // 那不是混响的起振,是阶跃响应的直流分量。
  const attack = 0.004;

  const earlyCount = 14;

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    const rnd = mulberry32(o.seed + ch * 7919);

    // —— 早期反射:taps 按时间排好,幅值随时间递减 ——
    const taps: { at: number; amp: number }[] = [];
    for (let i = 0; i < earlyCount; i++) {
      // 反射间隔按 sqrt 分布:近处的反射更密(真实房间就是这样)
      const u = (i + rnd() * 0.9) / earlyCount;
      const at = o.preDelay + Math.sqrt(u) * 0.09;
      taps.push({ at, amp: (1 - u) * (rnd() < 0.5 ? -1 : 1) * o.earlyLevel });
    }

    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = (1 - Math.exp(-t / attack)) * Math.exp(-t / tau);

      // 一阶低通的系数随时间下降 → 尾巴越来越暗
      const a = 0.06 + 0.72 * Math.exp(-t / o.dampingSeconds);
      const white = rnd() * 2 - 1;
      lp += a * (white - lp);

      data[i] = lp * env;
    }

    // 反射叠在噪声之上(它们本来就该是离散的、听得出来的几根"回声")
    for (const tap of taps) {
      const idx = Math.round(tap.at * sr);
      if (idx >= 0 && idx < len) data[idx] += tap.amp;
    }
  }

  normalize(buf, o.targetL2);
  return buf;
}

/** 把 IR 的 L2 范数归到 target(并把峰值压到 0.99 以内)。 */
function normalize(buf: AudioBuffer, targetL2: number): void {
  let sumSq = 0;
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const v = d[i]!;
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  const l2 = Math.sqrt(sumSq);
  let gain = l2 > 1e-12 ? targetL2 / l2 : 1;
  if (peak * gain > 0.99) gain = 0.99 / peak;

  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] = d[i]! * gain;
  }
}

/**
 * 量化的指纹。
 *
 * ⚠️ 量化到 1e-7 **不是为了容忍错误**,而是因为 Math.exp / Math.log 在不同
 *    引擎上可能差最后一位。逐位比较会让这个测试天天红,红了几天之后就没人
 *    再看它了 —— 那才是真的失去拦截能力。1e-7 的量化仍能抓住任何听得出来
 *    的改动(0.1% 的参数变化都会改指纹)。
 */
export function impulseStats(buf: AudioBuffer): ImpulseStats {
  const sr = buf.sampleRate;
  const ch0 = buf.getChannelData(0);

  let peak = 0;
  let sum = 0;
  let l2sq = 0;
  let n = 0;
  let h = 0x811c9dc5;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const v = d[i]!;
      sum += v * v;
      l2sq += v * v;
      n++;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      const q = Math.round(v * 1e7) | 0;
      h ^= q & 0xffff;
      h = Math.imul(h, 0x01000193);
      h ^= (q >>> 16) & 0xffff;
      h = Math.imul(h, 0x01000193);
    }
  }

  // 每 250ms 一格的 RMS,换算成 dB
  const bucket = Math.max(1, Math.round(0.25 * sr));
  const decay: { t: number; db: number }[] = [];
  for (let start = 0; start < ch0.length; start += bucket) {
    const end = Math.min(ch0.length, start + bucket);
    let s = 0;
    for (let i = start; i < end; i++) s += ch0[i]! * ch0[i]!;
    const r = Math.sqrt(s / Math.max(1, end - start));
    decay.push({
      t: Math.round((start / sr) * 100) / 100,
      db: Math.round(20 * Math.log10(Math.max(1e-9, r)) * 10) / 10,
    });
  }

  return {
    seconds: Math.round((buf.length / sr) * 1000) / 1000,
    sampleRate: sr,
    channels: buf.numberOfChannels,
    peak: Math.round(peak * 1e5) / 1e5,
    rms: Math.round(Math.sqrt(sum / Math.max(1, n)) * 1e6) / 1e6,
    l2: Math.round(Math.sqrt(l2sq) * 1e4) / 1e4,
    checksum: (h >>> 0).toString(16).padStart(8, '0'),
    decay,
  };
}
