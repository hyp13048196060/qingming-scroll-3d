/**
 * 景点简介与复原依据的**读取层**。
 *
 * 与 `spots.ts` 同一套做法:json 只放文本,坐标一律由别处(实测)提供;
 * 本文件只做形状校验与类型化,**不写兜底文案**。
 *
 * ⚠️ 为什么简介里没有坐标、依据里没有截图
 *    因为这两样东西一旦在文本里写死一份,就多了一个会和实测分家的副本。
 *    简介的锚点取自 `spots.json`,`basis.json` 的 `assert` 字段则是对
 *    `blender/tasks/validate_scale.py` 断言的**转述** —— 转述可能过时,
 *    所以每条都写明断言原文,便于与 validate_scale.py 对照。
 */

import hotspotsRaw from './hotspots.json';
import basisRaw from './basis.json';

// --------------------------------------------------------------------------
// 景点简介
// --------------------------------------------------------------------------

/** 可靠度等级。与 basis.json 的 `grades` 一一对应。 */
export type Grade = 'A' | 'B' | 'C';

export interface Hotspot {
  id: string;
  name: string;
  title: string;
  intro: string;
  points: string[];
  reliability: Grade;
  /** 这一条**做不到**或**不可知**的地方。每条都必须有。 */
  caveat: string;
}

interface HotspotsDoc {
  schema: number;
  hotspots: Hotspot[];
}

const hotspots = hotspotsRaw as unknown as HotspotsDoc;

const HOTSPOT_MIN = 3;

if (!Array.isArray(hotspots.hotspots) || hotspots.hotspots.length < HOTSPOT_MIN) {
  throw new Error(
    `hotspots.json 里只有 ${hotspots.hotspots?.length ?? 0} 条简介(至少 ${HOTSPOT_MIN} 条)。`,
  );
}

/**
 * 简介文本**必须有内容**。
 *
 * 空简介在界面上表现为「点了标签,弹出一个空面板」—— 看起来像卡住了。
 * 与其让用户对着空白猜,不如在启动时就报错。
 */
for (const h of hotspots.hotspots) {
  if (!h.intro?.trim()) throw new Error(`景点「${h.id}」的 intro 是空的。`);
  if (!h.caveat?.trim()) {
    throw new Error(
      `景点「${h.id}」没有写 caveat。每条简介都必须写明它**不可知**的部分 —— ` +
        `只写"复原了什么"而不写"哪里是推断的",就是在暗示复原程度比实际更高。`,
    );
  }
}

export const HOTSPOTS: readonly Hotspot[] = hotspots.hotspots;

const HOTSPOT_BY_ID = new Map(HOTSPOTS.map((h) => [h.id, h]));

/** 取某个景点的简介。取不到返回 undefined —— 调用方要能区分"没有"与"空"。 */
export function findHotspot(id: string | null | undefined): Hotspot | undefined {
  return id ? HOTSPOT_BY_ID.get(id) : undefined;
}

// --------------------------------------------------------------------------
// 复原依据
// --------------------------------------------------------------------------

export interface BasisEntry {
  id: string;
  topic: string;
  claim: string;
  basis: string;
  grade: Grade;
  /** 对应的机器断言原文(可能没有 —— 不是每条依据都能被自动验证) */
  assert?: string;
  caveat?: string;
}

export interface GradeDef {
  label: string;
  desc: string;
}

interface BasisDoc {
  schema: number;
  grades: Record<Grade, GradeDef>;
  caveat: string;
  entries: BasisEntry[];
}

const basis = basisRaw as unknown as BasisDoc;

/** 计划书阶段 3 第 4 组的验收线:依据条目 ≥12 条,每条带可靠度徽标。 */
const BASIS_MIN = 12;

if (!Array.isArray(basis.entries) || basis.entries.length < BASIS_MIN) {
  throw new Error(
    `basis.json 里只有 ${basis.entries?.length ?? 0} 条依据(验收要求 ≥${BASIS_MIN} 条)。`,
  );
}

/**
 * ⚠️ 每条依据的 grade 必须在 `grades` 里**有定义**。
 *
 *    徽标是渲染时按 grade 取 label 与配色的,若某条写了个没定义的等级
 *    (比如小写 'b',或者拼成 'A+'),取不到就只剩一个空徽标 ——
 *    界面上看着像是"这条没有可靠度标注",而实际上是拼错了。
 *    这是本项目反复出现的那类错:值看着合理,查定义才发现不存在。
 */
for (const e of basis.entries) {
  if (!basis.grades[e.grade]) {
    throw new Error(
      `依据「${e.id}」的 grade 是「${e.grade}」,但 grades 里只定义了 ` +
        `${Object.keys(basis.grades).join('、')}。`,
    );
  }
}

export const BASIS: readonly BasisEntry[] = basis.entries;
export const GRADES: Record<Grade, GradeDef> = basis.grades;
export const BASIS_CAVEAT: string = basis.caveat;

/** 按等级统计条目数,给面板显示用。 */
export function basisCounts(): Record<Grade, number> {
  const out: Record<Grade, number> = { A: 0, B: 0, C: 0 };
  for (const e of BASIS) out[e.grade]++;
  return out;
}
