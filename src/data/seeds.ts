/**
 * 全作品的随机种子 —— **唯一的派生出口**。
 *
 * ## 为什么要有这个文件
 *
 * 种子原先散在四处,各写一份字面量:
 *
 *   · `ParticleFx.ts`   自己写了一份底数,再加 4093
 *   · `composition.ts`  自己写了一份底数
 *   · `rng.ts`          自己写了一份底数,再加 977
 *   · `spots.json` / `actors.json` 由 Blender 一次构建产出,也各带一个 seed
 *
 * 而 `spots.ts` 的注释里长期写着"没有任何断言会比较它们是否一致,不一致时
 * 不会报错"。四份字面量的真实风险**不是"谁手滑写错了"**,是:
 *
 *   Blender 换了种子重新构建 → json 里的 seed 跟着变了 → TS 里那三份**没变**。
 *   于是网页上模型是新的,音乐和粒子还是旧种子。
 *
 * 这件事**在画面上看不出来**:种子只决定"哪一间铺子冒烟、鸟从哪个方向来"。
 * 没有断言的话,它能一直悄悄错着 —— 这正是本项目反复吃亏的那一类缺陷
 * (见 memory「仪器错误模式」:没有量具的差异等于不存在)。
 *
 * 所以这里做的**不是补一条断言,而是把派生关系本身变成唯一写法**:
 * 底数只有一个来源(`data/spots.json` 的 `seed`),其余三个全部由它算出来。
 * 想再要第四个种子,必须先经过这个文件。
 *
 * ## 派生值为什么要互相错开
 *
 * 同一条随机流喂两处会让两者**相关**:混响尾巴会和旋律同步摆动(听感上像
 * 有个跑调的第二声部在跟着走),烟团的相位会和鸟的相位锁在一起。
 * 偏移量 977 / 4093 就是为这件事存在的,不是随手挑的数。
 *
 * ## 边界
 *
 * 这里管的是 **JS 侧**的随机性。Blender 侧的 `SEED` 在 `blender/config.py`,
 * 它产出 `stats.json` → `spots.json` / `actors.json`,是这条链的**上游**;
 * 本文件只读上游的结果,不反向写回。
 *
 * ⚠️ `src/` 下的 TS 里**不允许出现种子的字面量** —— 连注释里也不行,本文件
 *    自己也不例外(所以上面那三行只写了偏移量,没写底数)。
 *    理由:改了种子之后,一句把数值写死的注释会**变成假话**,而假注释比死代码
 *    更坏(同 `tests/source_guards.mjs` 守卫二的判词)。种子只许出现在两处:
 *    `src/data/*.json`(数据)与 `blender/config.py`(源头)。
 *    这条规则由守卫三执行,见 `tests/source_guards.mjs`。
 */

import { SPOT_SEED } from './spots';
import actorsRaw from './actors.json';

/**
 * 底数。取自 `data/spots.json` 的 `seed` —— 也就是**产出这批模型的那一次
 * Blender 构建**所用的种子。模型换了,整部作品的随机性跟着换。
 */
export const BASE_SEED: number = SPOT_SEED;

// ── 两份 json 必须同源 ────────────────────────────────────────────────────
//
// `spots.json`(由 tools/make_spots.mjs 从 blender/out/stats.json 生成)与
// `actors.json`(由 blender/build/08_assembly.py 直接写出)是**两次写出**的,
// 但都应出自同一次 Blender 构建、同一个 `config.SEED`。只重新生成其中一份
// 就会错开 —— 而错开之后网页毫无异样,只是"景点坐标来自 A 次构建、人物摆位
// 来自 B 次构建",位置对不上时无从判断该信哪一份。
//
// ⚠️ 字段**缺失**也报错,不当成通过。这里本可以只写 `actorsSeed !== BASE_SEED`,
//    缺字段时 `undefined !== BASE_SEED` 恰好也为真 —— 但那样报出来的
//    会是"两份 seed 不一致",而真实原因是"actors.json 根本没写 seed"。
//    读数错了和量具坏了是两回事,不能共用一个报错(见 memory 第 40 条)。
{
  const actorsSeed: unknown = (actorsRaw as { seed?: unknown }).seed;
  if (typeof actorsSeed !== 'number') {
    throw new Error(
      `actors.json 里读不到 seed 字段(实为 ${JSON.stringify(actorsSeed)}),` +
        `无法校验它与 spots.json 是否同源。重新生成:blender/run_all.py 的阶段 08。`,
    );
  }
  if (actorsSeed !== BASE_SEED) {
    throw new Error(
      `两份数据的种子不同源:spots.json = ${BASE_SEED},actors.json = ${actorsSeed}。` +
        `说明它们不是同一次 Blender 构建的产物 —— 只重新生成了其中一份。` +
        `重新跑 blender/run_all.py 让两者一致。`,
    );
  }
}

/**
 * 乐句种子。与底数**相同**是有意的:曲子是这件作品的主线,让它第一个用底数,
 * 后面两个再各自错开。
 */
export const COMPOSITION_SEED = BASE_SEED;

/**
 * 混响 IR 的种子。与乐句种子**必须不同** —— 同一串随机数如果既铺乐句又铺 IR,
 * 混响尾巴的"纹理"会和旋律产生可听的关联,在长音上尤其明显。
 */
export const REVERB_SEED = BASE_SEED + 977;

/** 粒子(炊烟 / 飞鸟)的种子。同样与上面两条错开。 */
export const FX_SEED = BASE_SEED + 4093;
