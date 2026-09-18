#!/usr/bin/env node
/**
 * 生成 `docs/09-资产统计.md`。
 *
 * 为什么这份文档必须是脚本生成的
 * ------------------------------
 * 计划里写明"对象数/材质数/贴图数写入 docs/09,由 stats_report.mjs 生成,
 * **不手写**"。理由不是省事,是:手写的数字**看上去和真数字一模一样**,
 * 而它不会随构建更新。三个星期后有人改了建模脚本,文档里的数还是旧的,
 * 而且没有任何地方会提示它过期了 —— 这类文档比没有文档更坏,
 * 因为它让人以为自己查过了。
 *
 * 三方对账是这份报告的主要价值
 * ----------------------------
 * 同一个场景有三个独立的"说法":
 *   ① `blender/out/stats.json` —— 我数 Blender 场景里有什么
 *   ② `public/models/manifest.json` —— 导出器说它写了什么
 *   ③ `public/models/*.glb` —— 文件里实际有什么(由 tools/lib/glb.mjs 解包)
 * 三个数各自看都很正常,**差异只在两两之间才显形**。所以本报告不把它们
 * 分章陈列,而是并排放在同一张表里,差一就标一。
 *
 * 用法:
 *   node tools/stats_report.mjs            # 生成 docs/09-资产统计.md
 *   node tools/stats_report.mjs --check    # 只对账,不写文件;不一致则退出码 1
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { determinismKey, summarizeGlbFile } from './lib/glb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'blender', 'out');
const MODELS = join(ROOT, 'public', 'models');
const DOC = join(ROOT, 'docs', '09-资产统计.md');
const CHECK = process.argv.includes('--check');

// —— 阶段 2 的出口条件。写在这里而不是写在文字里,是为了让"判定"也是算出来的 ——
const BUDGET = {
  tris: 1_200_000,
  bytes: 22 * 1024 * 1024,
};

const n = (x) => x.toLocaleString('en-US');
const mb = (b) => (b / 1048576).toFixed(2);
const kb = (b) => (b / 1024).toFixed(0);

function readJson(path, { required = true } = {}) {
  if (!existsSync(path)) {
    if (required) throw new Error(`缺少 ${path}`);
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

// --------------------------------------------------------------------------
// 采集
// --------------------------------------------------------------------------

const stats = readJson(join(OUT, 'stats.json'));
let manifest = readJson(join(MODELS, 'manifest.json'), { required: false });
const validate = readJson(join(OUT, 'validate.json'), { required: false });
const repro = readJson(join(OUT, 'repro.json'), { required: false });

// 清单是上一次构建的产物:如果它的结构比本脚本旧(缺 `exported` / `scene` 分组),
// 那说明**清单没跟着重建**。这时候不能拿 undefined 去比 —— 那会把每个数都
// 报成"对不上",一屏假警报,把真差异淹掉。退成"清单侧未知",并在正文里说清。
if (manifest && !manifest.exported) {
  console.error('⚠ public/models/manifest.json 是旧结构(无 exported/scene 分组)。');
  console.error('  清单侧的数字本次一律按"未知"处理 —— 请重建后再看对账结果。');
  manifest = null;
}

const files = readdirSync(MODELS).filter((f) => f.endsWith('.glb')).sort();
const glbs = files.map((f) => summarizeGlbFile(join(MODELS, f)));

// --------------------------------------------------------------------------
// 对账
//
// 三方差一就是问题。这里把"哪一项、三边各是多少"记下来,报告里带 ★ 标出。
// --------------------------------------------------------------------------

const mismatches = [];
function check(label, a, b, c) {
  const vals = [a, b, c];
  const known = vals.filter((v) => v !== null && v !== undefined);
  if (new Set(known.map(String)).size > 1) {
    mismatches.push({ label, scene: a, manifest: b, glb: c });
  }
}

const glbTris = glbs.reduce((s, g) => s + g.triangles, 0);
const glbBytes = glbs.reduce((s, g) => s + g.container.totalBytes, 0);
const glbMeshNodes = glbs.reduce((s, g) => s + g.counts.meshNodes, 0);

const sceneMeshes = Object.values(stats.chunks).reduce((s, c) => s + c.meshes, 0);
const sceneObjects = Object.values(stats.chunks).reduce((s, c) => s + c.objects, 0);

// 导出侧(manifest)的三角面 = 各分块之和。场景侧的对应量是
// `trisReconcile.chunks` —— 也就是"落在分块里的那些物体的三角面"。
check('三角面', stats.trisReconcile.chunks, manifest ? manifest.totalTris : null, glbTris);
check('字节', null, manifest ? manifest.totalBytes : null, glbBytes);

// ⚠️ **对"网格数"这一项,三方比的必须是网格,不是物体。**
//
//    第一版这里比的是"物体数":`scene_characters` 报 16 个物体,
//    而 GLB 里只有 9 个网格节点,于是凭空冒出 7 件"丢失"。那 7 件
//    是骨架 —— 它们导出成骨节层级节点,本来就不该出现在网格计数里。
//    **这是设计,不是缺陷。**
//
//    报告不认这条规则,就会把设计报成缺陷 —— 与"把缺陷报成正常"
//    是同一个错的两面,而且更坏:满屏误报会把仅有的几行真问题淹掉。
//    修法不是放宽判据(那会连真丢件一起放过去),而是**换一个
//    三方都成立的口径**:物体对物体、网格对网格。
check('物体数(场景分块 / 清单导出 / —)', sceneObjects,
  manifest ? manifest.exported.objects : null, null);
check('网格节点数', sceneMeshes, manifest ? manifest.exported.meshes : null, glbMeshNodes);

// 材质**不做三方求和**。同一份 wood_old 被四块各写一遍,加起来是 37,
// 而场景里只有 31 种 —— 求和结果没有对应物。场景侧只能两方比,
// 分块侧另比(见下面的分块表)。
check('材质数(场景侧)', stats.totals.materials,
  manifest ? manifest.scene.materials : null, null);

// 分块级别的对账:哪一块多少三角面,场景说、清单说、文件说
const chunkRows = Object.keys(stats.chunks).map((key) => {
  const s = stats.chunks[key];
  const m = manifest ? manifest.files.find((f) => f.name === `${key}.glb`) : null;
  const g = glbs.find((x) => x.name === `${key}.glb`);
  const row = {
    key,
    collections: s.collections,
    missing: s.collections.filter((c) => !s.collectionsFound.includes(c)),
    sceneObjects: s.objects,
    sceneMeshes: s.meshes,
    sceneTris: s.tris,
    manifestObjects: m ? m.objects : null,
    manifestMeshes: m ? m.meshes : null,
    manifestTris: m ? m.tris : null,
    manifestBytes: m ? m.bytes : null,
    manifestMaterials: m ? m.materials : null,
    glbMeshNodes: g ? g.counts.meshNodes : null,
    glbObjects: g ? g.counts.nodes : null,
    glbTris: g ? g.triangles : null,
    glbBytes: g ? g.container.totalBytes : null,
    glbMaterials: g ? g.counts.materials : null,
    glbTextures: g ? g.counts.textures : null,
    glbImages: g ? g.counts.images : null,
    glbExtensions: g ? g.extensionsUsed : [],
  };
  // 三方对账,每组按**同一个口径**比。物体对物体、网格对网格、面对面对。
  // 场景分块里的物体应当**恰好**是导出时选中的那一批(meshes 已把
  // 骨架与网格分开),所以这里是等号,不是"少的才算"。
  const agree3 = (label, ...vals) => {
    const known = vals.filter((v) => v !== null && v !== undefined);
    if (new Set(known.map(String)).size > 1) {
      row.mismatch = true;
      mismatches.push({ label: `${key}: ${label}`, scene: vals[0], manifest: vals[1], glb: vals[2] });
    }
  };
  agree3('物体数', row.sceneObjects, row.manifestObjects, null);
  agree3('网格节点数', row.sceneMeshes, row.manifestMeshes, row.glbMeshNodes);
  agree3('三角面', row.sceneTris, row.manifestTris, row.glbTris);
  agree3('材质数(清单 vs 文件)', null, row.manifestMaterials, row.glbMaterials);
  return row;
});

// --------------------------------------------------------------------------
// 正文
// --------------------------------------------------------------------------

const L = [];
const p = (s = '') => L.push(s);
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

p('# 资产统计');
p();
p('> **本文件由 `npm run stats`(即 `tools/stats_report.mjs`)生成,请勿手改。**');
p('> 手改的数字不会随构建更新,而且看上去与真数字一模一样 —— 那比没有文档更坏。');
p('>');
p(`> 生成时间 ${now} UTC ｜ 种子 \`${stats.seed}\` ｜ 单位 ${stats.unit} ｜ Blender ${stats.meta.blender}`);
p('>');
p('> 三个数据来源并排对账,**差一即标 ★**:');
p('> ① `blender/out/stats.json` —— Blender 场景内实测');
p('> ② `public/models/manifest.json` —— 导出器自述');
p('> ③ `public/models/*.glb` —— 文件实际内容(由 `tools/lib/glb.mjs` 解包)');
p();

p('## 1 总量与阶段出口预算');
p();
p('| 指标 | 实测 | 阶段 2 出口条件 | 判定 |');
p('|---|---:|---:|:--:|');
const trisOk = glbTris <= BUDGET.tris;
const bytesOk = glbBytes <= BUDGET.bytes;
p(`| 四个 GLB 三角面合计 | ${n(glbTris)} | ≤ ${n(BUDGET.tris)} | ${trisOk ? '✓' : '✗'} |`);
p(`| 四个 GLB 体积合计 | ${mb(glbBytes)} MB | ≤ ${mb(BUDGET.bytes)} MB | ${bytesOk ? '✓' : '✗'} |`);
p(`| 场景物体数(导出时 Blender 里,含预览件) | ${n(stats.totals.objectsData)} | — | |`);
p(`| ↳ 其中导出到 GLB 的 | ${n(sceneObjects)} | — | |`);
p(`| ↳ 其中仅预览、按设计不导出 | ${n(stats.previewOnly.objects.length)} | — | |`);
p(`| 场景网格数 / 骨架数 | ${n(stats.totals.meshes)} / ${n(stats.totals.armatures)} | — | |`);
p(`| 材质数(场景里几种) | ${n(stats.totals.materials)} | — | |`);
p(`| 贴图数(场景里几张) | ${n(stats.totals.images)} | — | |`);
p(`| 集合数 | ${n(stats.totals.collections)} | — | |`);
p();
p('⚠️ **"多少个物体"有两个都正确的答案,取哪个取决于问的是什么。**');
p(`场景侧 **${n(stats.totals.objectsData)}**,导出侧 **${n(sceneObjects)}**,`
  + `差的 ${n(stats.totals.objectsData - sceneObjects)} 件是预览标位 \`${stats.previewOnly.objects.join('`、`')}\`。`);
p('`manifest.json` 把两组分开写成 `scene` 与 `exported`,就是为了不让人把'
  + '这两个数并排一放、然后断定其中一个是错的 —— 它们都对,只是分母不同。');
p('同理,**材质与贴图不做跨块求和**:同一份材质会被四块各写一遍,'
  + '加起来得到的数没有对应物。各块的实际条数见第 2 节。');
p();
p(`⚠️ 场景侧三角面 ${n(stats.totals.tris)} **不等于**导出侧 ${n(glbTris)} —— `
  + `差值 ${n(stats.trisReconcile.total - stats.trisReconcile.chunks)} 来自`
  + `**按设计不导出**的预览件(${stats.previewOnly.objects.join('、') || '无'},`
  + `共 ${n(stats.previewOnly.tris)} 三角面)。`);
p(`对账:全部 ${n(stats.trisReconcile.total)} = 分块 ${n(stats.trisReconcile.chunks)}`
  + ` + 预览件 ${n(stats.trisReconcile.previewOnly)}`
  + ` + 无归属 ${n(stats.trisReconcile.unaccounted)} ${stats.trisReconcile.ok ? '✓' : '✗ **对不上**'}`);
p();

p('## 2 分块');
p();
p('三列同名列,分母不同,读数前先看这里 —— **场景** = 该集合里的物体;'
  + '**清单** = 导出器自述选中的;**文件** = GLB 里数出来的。三者相等才叫对得上。');
p();
p('| 文件 | 集合 | 物体数(场景/清单) | 网格节点数(场景/清单/文件) | '
  + '三角面(场景/清单/文件) | 材质(清单/文件) | 贴图 | 体积 |');
p('|---|---|---|---|---|---:|---:|---:|');
for (const r of chunkRows) {
  const flag = r.missing.length ? ` ⚠ **集合不存在:${r.missing.join('、')}**` : '';
  // "差一即标 ★" 是开头那句承诺。**必须真的标出来** ——
  // 头里写了规则而表里从不出现星号,读的人会反过来理解:
  // 一片没有星号的表,看起来像"查过了,没问题"。
  const star = r.mismatch || r.missing.length ? '★ ' : '';
  p(`| ${star}\`${r.key}.glb\` | ${r.collections.join('、')}${flag} `
    + `| ${n(r.sceneObjects)} / ${n(r.manifestObjects)} `
    + `| ${n(r.sceneMeshes)} / ${n(r.manifestMeshes)} / ${n(r.glbMeshNodes)} `
    + `| ${n(r.sceneTris)} / ${n(r.manifestTris)} / ${n(r.glbTris)} `
    + `| ${n(r.manifestMaterials)} / ${n(r.glbMaterials)} `
    + `| ${n(r.glbTextures)} | ${mb(r.glbBytes ?? 0)} MB |`);
}
p();
p('⚠️ `scene_characters.glb` 一行最容易读错:物体数 16,网格节点数 9。'
  + '那 16 = 9 个蒙皮网格 + 7 具骨架,骨架导出成骨节层级节点(该文件共 '
  + `${n(chunkRows.find((r) => r.key === 'scene_characters')?.glbObjects ?? 0)} 个节点),`
  + '不计入网格。**这是设计,不是丢件。**');
p();
p(`**★ 标记:${mismatches.length ? `${mismatches.length} 处对不上` : '无'}** —— `
  + '星号只标"同一口径下三方不等",不标"数大数小"。');
if (mismatches.length) {
  p();
  p('| 位置 | 场景 | 清单 | 文件 |');
  p('|---|---:|---:|---:|');
  for (const m of mismatches) {
    p(`| ${m.label} | ${m.scene ?? '—'} | ${m.manifest ?? '—'} | ${m.glb ?? '—'} |`);
  }
}
p();
p();
for (const r of chunkRows) {
  if (r.glbExtensions.length) {
    p(`- \`${r.key}.glb\` 用到的扩展:${r.glbExtensions.map((e) => `\`${e}\``).join('、')}`);
  }
}
p();

p('## 3 按类别 / 区域 / 层级');
p();
function kvTable(title, obj, extra = null) {
  p(`**${title}**`);
  p();
  const keys = Object.keys(obj);
  if (!keys.length) { p('(无)'); p(); return; }
  p('| 键 | 物体数 |' + (extra ? ' 说明 |' : ''));
  p('|---|---:|' + (extra ? '---|' : ''));
  for (const k of keys) {
    p(`| ${k} | ${n(obj[k])} |` + (extra ? ` ${extra(k)} |` : ''));
  }
  p();
}
kvTable('`qm_kind` 分类', stats.byKind);
kvTable('`qm_zone` 区域', stats.byZone);
kvTable('`qm_lod` 层级', stats.byLod);

p('## 4 网页驱动接口(交给阶段 3)');
p();
p('动作词表 —— **这里列的是 builders 实际用出来的值**,不是计划里那张设想表。');
p('阶段 3 的分发器要照着这张表写。');
p();
p('| `qm_anim` | 数量 | 样例 |');
p('|---|---:|---|');
for (const [k, v] of Object.entries(stats.animVocabulary)) {
  p(`| \`${k}\` | ${n(v.count)} | ${v.sample.map((s) => `\`${s}\``).join(' ')} |`);
}
p();
const dynamicObjs = stats.objects.filter((o) => o.dynamic === 1 || o.dynamic === true);
p(`- 带风动顶点权重(\`${'flex'}\` 属性)的物体:**${n(stats.flexObjects.length)}** 件`);
p(`- 蒙皮网格:**${n(stats.skinnedObjects.length)}** 件`);
p(`- \`qm_dynamic=1\` 的物体:**${n(dynamicObjs.length)}** 件`
  + `(占 ${((dynamicObjs.length / stats.objects.length) * 100).toFixed(0)}%)`);
p();

const ti = stats.tagIssues;
p('### 标签问题(只列**能由标签自身判定**的)');
p();
if (!ti.pivot.length && !ti.unexplainedMotion.length
    && !stats.tagLeaks.unknownKeys.length && !stats.tagLeaks.hasTagWithoutId.length) {
  p('无。');
} else {
  if (ti.pivot.length) {
    p(`**轴心问题 ${ti.pivot.length} 条**`);
    p();
    for (const x of ti.pivot) p(`- ${x}`);
    p();
  }
  if (ti.unexplainedMotion.length) {
    p(`**标了 dynamic 却没有动因 ${ti.unexplainedMotion.length} 件**`);
    p();
    for (const x of ti.unexplainedMotion) p(`- ${x}`);
    p();
  }
  if (stats.tagLeaks.unknownKeys.length) {
    p(`**未知标签键**:${stats.tagLeaks.unknownKeys.map((k) => `\`${k}\``).join('、')}`);
    p();
  }
  if (stats.tagLeaks.hasTagWithoutId.length) {
    p(`**带标签但无 \`qm_id\`**:${stats.tagLeaks.hasTagWithoutId.map((k) => `\`${k}\``).join('、')}`);
    p();
  }
}

p('## 5 骨架与蒙皮');
p();
p('| 骨架 | 骨数 | 形变骨 |');
p('|---|---:|---:|');
for (const a of stats.armatures) p(`| \`${a.name}\` | ${a.bones} | ${a.deformBones} |`);
p();

p('## 6 贴图');
p();
p('| 名称 | 尺寸 | 色彩空间 | 通道 | 写进 GLB 的字节 | 说明 |');
p('|---|---|---|---:|---|---|');
// 名称 → GLB 内字节:GLB 里的 image 名字会带扩展名,所以按"去掉后缀再比"。
// 配不上就留空,不猜。
//
// ⚠️ **不做跨块求和。** 同一张木纹图会被 scene_core 与 scene_props 各写一份,
//    加起来是它真实体积的两倍,而"两张木纹图"并不存在。所以这里记的是
//    各块的**逐份**字节,并标出被写了几份 —— 体积预算要压的是 Σ(逐份)。
const imgSizes = new Map();
for (const g of glbs) {
  for (const im of g.images) {
    const base = im.name.replace(/\.[a-z0-9]+$/i, '');
    if (!imgSizes.has(base)) imgSizes.set(base, []);
    imgSizes.get(base).push(im.byteLength || 0);
  }
}
let imgTotal = 0;
let imgUnique = 0;
for (const im of stats.images) {
  const arr = imgSizes.get(im.name);
  const note = [];
  if (!im.hasData) note.push('**无像素数据**');
  if (im.packedBytes === null) note.push('未打包(导出时编码)');
  let cell = '—';
  if (arr && arr.length) {
    const one = arr[0];
    imgTotal += arr.reduce((s, v) => s + v, 0);
    imgUnique += one;
    const allSame = arr.every((v) => v === one);
    cell = `${kb(one)} KB` + (arr.length > 1 ? ` ×${arr.length} 块${allSame ? '' : '(各块不等)'}` : '');
  }
  p(`| \`${im.name}\` | ${im.size[0]}×${im.size[1]} | ${im.colorspace} | ${im.channels} | ${cell} | ${note.join(';')} |`);
}
p();
p(`编码后合计:**${mb(imgTotal)} MB**(四块里各写一份之和,这是真正占体积的数);`
  + `去重后 ${mb(imgUnique)} MB(每张只算一次)。`);
p();
p();
const sRGB = stats.images.filter((i) => i.colorspace === 'sRGB').length;
const nonColor = stats.images.filter((i) => i.colorspace !== 'sRGB').length;
p(`色彩空间分布:sRGB ${sRGB} 张,Non-Color ${nonColor} 张。`);
p('⚠️ 法线/粗糙度写进 sRGB 槽位是"发白发灰"的头号原因,这一列就是用来查它的。');
p();

p('## 7 材质');
p();
p('| 材质 | 使用物体数 | 样例 |');
p('|---|---:|---|');
for (const m of stats.materials) {
  p(`| \`${m.name}\` | ${m.objects} | ${m.sample.map((s) => `\`${s}\``).join(' ')} |`);
}
p();
p('**GLB 侧材质参数**(导出后的实际值,与 Blender 侧可能不同):');
p();
p('| 文件 | 材质 | 双面 | alphaMode | metallic | roughness |');
p('|---|---|:--:|---|---:|---:|');
for (const g of glbs) {
  for (const m of g.materials) {
    p(`| \`${g.name}\` | \`${m.name}\` | ${m.doubleSided ? '是' : '否'} | ${m.alphaMode} | `
      + `${m.metallicFactor} | ${m.roughnessFactor} |`);
  }
}
p();

p('## 8 形制门禁');
p();
if (validate) {
  p(`| 阶段 | 通过 | 失败 | 未执行 | 本阶段应验而未验 |`);
  p('|---|---:|---:|---:|---:|');
  p(`| ${validate.stage} | ${validate.pass} | **${validate.fail}** | ${validate.skip} | ${validate.overdue} |`);
  p();
  const groups = {};
  for (const c of validate.checks) {
    groups[c.group] = groups[c.group] || { pass: 0, fail: 0, skip: 0 };
    groups[c.group][c.status]++;
  }
  p('| 分组 | 通过 | 失败 | 未执行 |');
  p('|---|---:|---:|---:|');
  for (const [g, v] of Object.entries(groups)) p(`| ${g} | ${v.pass} | ${v.fail} | ${v.skip} |`);
  p();
  p(`详见 \`blender/out/validate.json\`(${n(validate.checks.length)} 条断言的逐条明细)。`);
} else {
  p('⚠️ 未找到 `blender/out/validate.json` —— **本次构建没有经过形制校验**。');
}
p();

p('## 9 可复现性');
p();
if (repro) {
  p(`| 项 | 值 |`);
  p('|---|---|');
  p(`| 构建次数 | ${repro.runs} |`);
  p(`| 判据 | 对象数 + 每对象三角面 + 包围盒(容差 ${repro.tolerance}) |`);
  p(`| 比对对象 | 场景层 ${n(repro.sceneObjectsCompared)} 个 / 产物层 ${n(repro.glbMeshNodesCompared)} 个网格节点 |`);
  p(`| 不一致处 | **${repro.diffCount}** |`);
  p(`| 判定 | ${repro.pass ? '✓ 可复现' : '✗ 不确定'} |`);
  p(`| 逐字节相同的文件 | ${repro.hashIdentical}/${repro.files} |`);
  p();
  if (repro.diffCount) {
    p('前若干处差异:');
    p();
    for (const d of repro.diffs.slice(0, 10)) p(`- \`${d.path}\`:跑1 \`${d.a}\` / 跑2 \`${d.b}\``);
    p();
  }
  p('⚠️ 二进制哈希**如实记录但不作判据** —— glTF 导出器会写 generator 一类元信息,');
  p('哈希不同不等于场景不同。判据见 `tools/verify_reproducible.mjs` 的注释。');
  if (repro.hashIdentical === repro.files && repro.files > 0) {
    p();
    p(`本次 ${repro.files}/${repro.files} 个文件**逐字节相同**,`
      + '**这比判据要求更强**。判据不要求它 —— 记在这里是因为它是个事实,');
    p('不是因为它可以被依赖:导出器版本一升,这一条随时可能不再成立。');
  }
} else {
  p('尚未运行 `npm run repro`(即 `tools/verify_reproducible.mjs --runs 2`)。');
  p('在跑过之前,**不得**声称构建可复现 —— 复现性是测出来的,不是设计出来的。');
}
p();

p('## 10 本报告不度量什么');
p();
p('这一节是报告的**能力边界**,与数字同等重要 —— 不写清楚,读到的人会把');
p('"这里没有异常"当成"这里没有问题"。');
p();
for (const b of stats.boundaries) p(`- ${b}`);
p('- 三个来源的一致**不证明**几何正确。它们同出一源(同一套 builder 脚本),');
p('  一处建模错误会在三边同样地错,因而对账永远是绿的。几何正确性由');
p('  `validate_scale.py` 的形制断言负责,那份报告在 `blender/out/validate.json`。');
p('- 本报告不含任何性能数字。帧时/drawcall/显存见 `docs/05-性能测量报告.md`。');
p();

// --------------------------------------------------------------------------
// 写入 / 判定
// --------------------------------------------------------------------------

const B = '─'.repeat(78);
console.log(B);
console.log('资产统计对账');
console.log(B);
console.log(`  三角面   场景(分块内) ${n(stats.trisReconcile.chunks)}  `
  + `清单 ${n(manifest ? manifest.totalTris : 0)}  GLB ${n(glbTris)}`);
console.log(`  体积     GLB 合计 ${mb(glbBytes)} MB  (预算 ${mb(BUDGET.bytes)} MB) ${bytesOk ? '✓' : '✗'}`);
console.log(`  物体     场景(含预览) ${n(stats.totals.objectsData)}  `
  + `场景(分块内) ${n(sceneObjects)}  文件 ${n(manifest ? manifest.exported.objects : 0)}`);
console.log(`  网格节点 场景(分块内) ${n(sceneMeshes)}  `
  + `清单 ${n(manifest ? manifest.exported.meshes : 0)}  GLB ${n(glbMeshNodes)}`);
console.log();

if (mismatches.length) {
  console.log(`✗ ${mismatches.length} 处三方对不上:`);
  for (const m of mismatches) {
    console.log(`    ${m.label}`);
    console.log(`      场景 ${m.scene}  清单 ${m.manifest}  文件 ${m.glb}`);
  }
} else {
  console.log('✓ 三方对账一致');
}
console.log(B);

if (!CHECK) {
  writeFileSync(DOC, L.join('\n') + '\n', 'utf8');
  console.log(`文档:${join('docs', '09-资产统计.md')}  (${L.length} 行)`);
}

const bad =
  mismatches.length > 0 ||
  !trisOk ||
  !bytesOk ||
  !stats.trisReconcile.ok ||
  chunkRows.some((r) => r.missing.length);

process.exit(bad ? 1 : 0);
