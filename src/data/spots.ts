/**
 * 五个景点的**读取层**。
 *
 * `spots.json` 由 `tools/make_spots.mjs` 从 `blender/out/stats.json` 的
 * 实测包围盒推导生成 —— **不要手改那个 json**,改 `make_spots.mjs` 里的
 * 规则再跑一遍。手改的话,下次重新生成就没了,而且没人知道那次手改是
 * 为什么。同理,这里的坐标不写第二份:本文件只做读取与形状校验。
 *
 * ⚠️ 本文件里也**不能**再写一遍坐标当"兜底"。json 缺一个景点就该报错,
 *    而不是悄悄退回一个默认机位 —— 后者会让"景点按钮点了没反应"变成一个
 *    只有肉眼能发现的问题。
 */

import raw from './spots.json';
import type { Shot } from '../camera/CameraDirector';

export interface Spot {
  id: string;
  name: string;
  anchor: { object: string; kind: string; bboxThree: number[] };
  /** 看点(相机看向的点) */
  target: [number, number, number];
  /** 景点全景机位 */
  view: [number, number, number];
  /** 「走近看看」的近观机位 */
  near: [number, number, number];
  derived: {
    rule: string;
    fovDeg: number;
    aspect: number;
    fill: number;
    dist: number;
    azimuth: number;
    pitch: number;
    raisedToMinY: string[] | null;
  };
  why: string;
}

interface SpotsDoc {
  schema: number;
  seed: number;
  unit: string;
  coordNote: string;
  spots: Spot[];
}

const doc = raw as unknown as SpotsDoc;

/** 至少要有这么多景点,少一个就说明生成脚本或 json 出问题了。 */
const EXPECTED_MIN = 5;

if (!Array.isArray(doc.spots) || doc.spots.length < EXPECTED_MIN) {
  throw new Error(
    `spots.json 里只有 ${doc.spots?.length ?? 0} 个景点(至少要有 ${EXPECTED_MIN} 个)。` +
      `重新生成:node tools/make_spots.mjs`,
  );
}

export const SPOTS: readonly Spot[] = doc.spots;
/**
 * 这份坐标是**哪一次构建**产出的 —— 取自 `blender/out/stats.json` 的 seed,
 * 经 `tools/make_spots.mjs` 一路带过来。
 *
 * 两个用途,都不是"给人看一眼"那么弱:
 *
 *   ① **溯源**:将来出现"网页上的景点位置和模型对不上"时,能一眼看出这份
 *      json 是不是另一次构建留下的。
 *   ② **它是全作品随机种子的底数**。`data/seeds.ts` 从这里取数,再派生出
 *      乐句 / 混响 / 粒子的种子 —— 于是"模型换了,随机性跟着换"是**结构上
 *      保证**的,不靠谁记得去改那三处。
 *
 * ⚠️ 所以别看到它没有直接的调用方就删掉。它现在**有**调用方了,只是那一个
 *    调用方在 `data/seeds.ts` 里 —— 而那条依赖链正是第 ② 条。
 */
export const SPOT_SEED: number = doc.seed;

const BY_ID = new Map(SPOTS.map((s) => [s.id, s]));

/** 按 id 取景点。取不到返回 undefined —— 调用方(URL 解析)要能区分"没写"和"写错了"。 */
export function findSpot(id: string | null | undefined): Spot | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function spotById(id: string): Spot {
  const s = BY_ID.get(id);
  if (!s) {
    throw new Error(
      `没有 id 为「${id}」的景点。现有:${SPOTS.map((x) => x.id).join('、')}`,
    );
  }
  return s;
}

/** 景点的全景镜头。 */
export function viewShot(s: Spot): Shot {
  return { id: s.id, position: s.view, target: s.target };
}

/** 景点的近观镜头(「走近看看」)。 */
export function nearShot(s: Spot): Shot {
  return { id: `${s.id}:near`, position: s.near, target: s.target };
}

/** 巡游路线:五个景点的近观位姿。近观比全景有看头,巡游拿它当主线。 */
export function tourShots(): Shot[] {
  return SPOTS.map((s) => ({ ...nearShot(s), dwell: 9 }));
}
