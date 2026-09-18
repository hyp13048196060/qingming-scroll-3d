/**
 * Blender 物体名 → 网页标识 `qm_id` 的对照表。
 *
 * 为什么需要一张对照表
 * --------------------
 * 同一个物体在两套命名里各有一个名字,而且**两边都要用**:
 *
 *   · Blender 侧叫 `虹桥_桥面`(中文,人在 Blender 里看的是这个)
 *   · 网页侧叫 `bridge_deck`(`qm_id`,浏览器里查的是这个)
 *
 * `blender/out/stats.json` 只有**前者**,`qm_*` 标签只记了名字(`tagKeys`)
 * 没记值。于是任何"拿 stats 的名字去和网页里的标识比"的脚本都会**静默
 * 不匹配** —— 不报错,只是判据永远为假。
 * (`tools/perf/verify_spots.mjs` 第一版就这么错了:虹桥被判成"射线从构件
 *  空当穿过",真实原因是拿 `虹桥` 去比 `bridge_deck`,前缀不匹配。)
 *
 * 唯一同时含有这两个名字的地方是导出的 GLB 的**节点 extras** —— 节点名是
 * Blender 物体名,extras 里是 `qm_id`。所以对照表从 GLB 建,这是权威来源:
 * 它就是浏览器实际拿到的那份数据。
 *
 * ⚠️ 不要在别处再手写一份名称对照。手写的那份会和导出的那份慢慢分家,
 *    而分家后症状是"某个物体在网页上找不到",且找不到的原因看不出来。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { summarizeGlb } from './glb.mjs';

/** 四个 GLB 分块,与 `public/models/manifest.json` 里列的一致。 */
export const GLB_FILES = [
  'scene_core.glb',
  'scene_props.glb',
  'boats.glb',
  'scene_characters.glb',
];

/**
 * 扫描 `public/models/` 下的全部分块,返回
 *   { byName: Map<blenderName, qm_id>, byId: Map<qm_id, blenderName>, stats }
 */
export async function loadQmIds(root) {
  const byName = new Map();
  const byId = new Map();
  const stats = [];

  for (const f of GLB_FILES) {
    const p = resolve(root, 'public/models', f);
    let buf;
    try {
      buf = await readFile(p);
    } catch (err) {
      throw new Error(
        `读不到分块 ${f}(${err.code})。—— 先构建模型:` +
          `node blender/run_all.py --stage 2 或从仓库取 public/models/。`,
      );
    }
    const s = summarizeGlb(buf, { path: p, name: f });
    let tagged = 0;
    let dup = 0;
    for (const it of s.items) {
      const id = it.extras && it.extras.qm_id;
      if (!id || !it.name) continue;
      tagged++;
      if (byName.has(it.name)) dup++;
      byName.set(it.name, id);
      // 一个 qm_id 对应多个物体是**正常的**(比如同一种道具的多个实例),
      // 所以 byId 只记第一个,并如实说明它不是唯一映射。
      if (!byId.has(id)) byId.set(id, it.name);
    }
    stats.push({ file: f, items: s.items.length, tagged, dup });
  }

  return { byName, byId, stats };
}

/**
 * 取某个 Blender 物体名对应的 qm_id。取不到**抛错**,不返回原名。
 *
 * 返回原名会让"没找到"和"找到了、名字恰好一样"两种情况长得一样 ——
 * 而前者需要修数据,后者是正常情况。
 */
export function qmIdOf(map, blenderName) {
  const id = map.byName.get(blenderName);
  if (!id) {
    throw new Error(
      `物体「${blenderName}」在导出的 GLB 里没有 qm_id。` +
        `要么名字写错了,要么这个物体没被 tag() 打过标签。`,
    );
  }
  return id;
}
