#!/usr/bin/env node
/**
 * 由**实测包围盒**推导五个景点机位 → `src/data/spots.json`。
 *
 * 为什么不手写坐标
 * ----------------
 * 手写的机位是"今天看着对"的机位。场景由种子生成,街巷、树木、船只的位置
 * 会随几何改版而变;写死的坐标不会跟着动,于是改一次几何就有一批机位对着
 * 空地。本项目已经栽过一次同类的:`blender/tasks/preview.py` 里三处机位从
 * "写死"改成"从实测包围盒反推",那次的原因是预览图对着空气渲。
 *
 * 所以这里只写**规则**,不写坐标:
 *
 *   target = 锚点物体的包围盒中心(高度按类型取,见下)
 *   dist   = k × 锚点包围盒的最大水平尺寸
 *   view   = target + 方向单位向量 × dist
 *
 * 方向也不是随便给的 —— 每个景点写的是"从哪一侧看",来历见 `WHY` 字段。
 *
 * 坐标系换算(必须写下来,否则一定会读反)
 * --------------------------------------
 *   Blender: Z 向上,单位 m,包围盒存的是 [x0,y0,z0, x1,y1,z1]
 *   three  : Y 向上
 *   导出用 `export_yup=True`,所以:
 *       x_three =  x_blender
 *       y_three =  z_blender        ← 高度搬到 y
 *       z_three = −y_blender        ← 注意有负号
 *   这条负号是最容易被漏掉的一处:`probe_pixel_web.mjs` 打出来的命中点
 *   直接就是 three 坐标,与这里的数可以直接对。
 *
 * 用法: node tools/make_spots.mjs [--dry]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadQmIds, qmIdOf } from './lib/qmids.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const STATS = resolve(ROOT, 'blender/out/stats.json');
const OUT = resolve(ROOT, 'src/data/spots.json');

const stats = JSON.parse(await readFile(STATS, 'utf8'));

/**
 * 物体名 → three 坐标的包围盒 {lo, hi} 或 {noBox: 原因}。
 *
 * ⚠️ **`stats.json` 里有 7 个物体没有包围盒**,`bbox` 是 `null`:
 *    `char_carry_rig`、`char_hold_rig`、`char_lead_rig`、`char_punt_rig`、
 *    `char_push_rig`、`char_vendor_rig`、`char_carry_rig` 这类 **ARMATURE**。
 *    骨架没有几何,自然量不出包围盒 —— 这是正常的,不是数据缺失。
 *    第一版这里直接读 `b[0]`,当场 `TypeError: Cannot read properties of
 *    null`。**这个报错是有用的**:它说明我在写"读统计量"的脚本时,
 *    脑子里假定的是"每个物体都有形状"。
 *
 *    所以这里不跳过、也不填 0:记下**为什么没有**,好在有人拿骨架当锚点时
 *    给出指名道姓的提示。填 0 会让机位悄悄落到原点,而原点在河里。
 */
const byName = new Map();
let noBoxCount = 0;
for (const o of stats.objects) {
  const b = o.bbox; // [x0,y0,z0,x1,y1,z1] (Blender, Z 向上)
  if (!b) {
    noBoxCount++;
    byName.set(o.name, {
      noBox:
        `${o.type} 没有几何包围盒` +
        (o.kind === 'character' && o.type === 'ARMATURE'
          ? '(骨架只是容器,形状在它的网格子物体上)'
          : ''),
      kind: o.kind,
    });
    continue;
  }
  byName.set(o.name, {
    lo: [b[0], b[2], -b[4]], // x0, z0, −y1
    hi: [b[3], b[5], -b[1]], // x1, z1, −y0
    kind: o.kind,
    zone: o.zone,
  });
}

/** 取一个物体的 three 包围盒;取不到就**报错**,不静默跳过。 */
function box(name) {
  const b = byName.get(name);
  if (!b) {
    throw new Error(
      `spots 的锚点物体「${name}」不在 stats.json 里 —— ` +
        `场景改版把它改名或删掉了。这里不退回默认坐标:` +
        `一个悄悄落到空地上的机位比一个报错难查得多。`,
    );
  }
  if (b.noBox) {
    throw new Error(
      `spots 的锚点物体「${name}」量不出包围盒:${b.noBox}。` +
        `锚点必须指向**有形状的网格**,否则机位无从推导。` +
        `例如人物要指 \`char_walk\`,不是 \`char_walk_rig\`。`,
    );
  }
  return b;
}

const center = (b, fy = 0.5) => [
  (b.lo[0] + b.hi[0]) / 2,
  b.lo[1] + (b.hi[1] - b.lo[1]) * fy,
  (b.lo[2] + b.hi[2]) / 2,
];

/** 方向向量:给俯角与水平方位(弧度),返回单位向量(three 的 Y-up)。 */
function dir(azimuth, pitch) {
  // azimuth 0 = +X,逆时针绕 Y; pitch 正 = 从上往下看
  const h = Math.cos(pitch);
  return [h * Math.cos(azimuth), Math.sin(pitch), -h * Math.sin(azimuth)];
}

const add = (p, d, s) => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => {
  const L = Math.hypot(...a) || 1;
  return [a[0] / L, a[1] / L, a[2] / L];
};

function corners(b) {
  const out = [];
  for (const x of [b.lo[0], b.hi[0]])
    for (const y of [b.lo[1], b.hi[1]])
      for (const z of [b.lo[2], b.hi[2]]) out.push([x, y, z]);
  return out;
}

/**
 * **取景距离**(闭式解,不是试出来的)
 * ----------------------------------
 * 第一版这里写的是 `dist = k × max(水平尺寸)`,量出来是错的 —— 而且是
 * 一个"看着像对"的错法:
 *   · 茶肆的立面是 12m 长 × 3m 高的**薄墙**,max 水平尺寸取的是 12m,
 *     于是相机被推到 39m 外、河对岸。一间临街铺子被拍成了一个远处的
 *     色块,而参数看起来毫无异常。
 *   · 换成长条形物体更荒唐:`mid_frame_e` 有 191m 长,相机直接被推到
 *     220m 外。
 * 根子上是**量的东西和要管的事没关系**:决定"该站多远"的不是物体多大,
 * 是**它在画面里占多大**。
 *
 * 所以这里改成真正的取景计算。相机 C = target + d·dist,视线朝 −d。
 * 取一组正交基:
 *     forward = −d
 *     right   = normalize(cross(forward, 世界上方))
 *     up      = cross(right, forward)
 * 对每个包围盒角点 P,记 w = P − target,则 v = P − C = w − d·dist。
 * 于是
 *     v·right    = w·right      (因为 d ⊥ right)
 *     v·up       = w·up         (因为 d ⊥ up)
 *     v·forward  = dist − w·d
 * **前两个与 dist 无关** —— 屏幕上的偏移量是定的,只有景深随 dist 变。
 * 于是"装进画面"就是一个不等式:
 *     |w·right| ≤ tanH·fill·(dist − w·d)
 *     |w·up|    ≤ tanV·fill·(dist − w·d)
 * 解出 dist,逐个角点取最大:
 *     dist = max over P of ( w·d + max(|w·right|/(tanH·fill), |w·up|/(tanV·fill)) )
 *
 * 好处是 `fill` 是个**看得懂、也验得了**的数:0.8 就是"物体占画面八成的
 * 边长"。上一版的 `k` 是个不知道为什么是 2.1 的倍数。
 */
function fitDistance(b, target, d, aspect, fovDeg, fill) {
  const tanV = Math.tan((fovDeg * Math.PI) / 360) * fill;
  const tanH = tanV * aspect;
  const forward = [-d[0], -d[1], -d[2]];
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);

  let dist = 0;
  for (const P of corners(b)) {
    const w = sub(P, target);
    const need = Math.max(
      Math.abs(dot(w, right)) / tanH,
      Math.abs(dot(w, up)) / tanV,
    );
    dist = Math.max(dist, dot(w, d) + need);
  }
  return dist;
}

/** 应用里实际用的相机参数 —— 取景距离必须按**同一个** fov 算,否则对不上。 */
const FOV_DEG = 50; // src/main.ts: new THREE.PerspectiveCamera(50, ...)
const ASPECT = 16 / 9; // 截图与 perf 采集都在 1600×900 下做

/**
 * 五个景点。
 *
 * `why` 字段会**原样写进 spots.json** —— 机位的来历要和机位一起交付,
 * 否则下一个人只会看到五个坐标,不知道哪个能改、改了会怎样。
 *
 * `fill` = 物体在画面里占的比例(0.8 ≈ 占八成边长)。方向(azimuth/pitch)
 * 仍是手写的,因为它表达的是**意图**("从河上看岸""沿街看过去"),
 * 这没法从包围盒推出来;但距离由 `fill` 经取景计算定,**不留手写余量**。
 */
const SPECS = [
  {
    id: 'bridge',
    name: '虹桥',
    anchor: '虹桥_桥面',
    // 瞄桥面**顶**——桥的看点就是那条起拱的弧。
    // 但瞄弧顶会让整座桥掉到画面下半,所以 pitch 取 0.40(23°)把桥压回中心。
    heightFrac: 1.0,
    fill: 0.78,
    azimuth: 0.62,
    pitch: 0.4,
    why:
      '瞄桥面顶(不用盒心):虹桥的看点是那条起拱的弧,瞄盒心会把弧顶留在画外。' +
      '机位取东南上方,与 Blender 侧 three_quarter 预览机位同侧 —— ' +
      '两端看图时能对上同一个面。',
  },
  {
    id: 'boat',
    name: '漕船',
    anchor: 'boat_cao_hero_hull',
    heightFrac: 0.55,
    fill: 0.8,
    // ⚠️ 方位从 0.95 改成 −1.53,**这是被实测挡下来的**。
    //    0.95(东南方)算出来的机位 (8.62, 3.69, −0.30) 落在 x∈[−10.5,10.5]、
    //    z∈[−3.9,3.9] 的虹桥盒子里 —— 镜头距桥板只有 1.82m,截图是一片木纹。
    //    取景算的是"相机与目标"的二人关系,遮挡要问整个场景;这件事只能
    //    开浏览器打射线才发现(tools/perf/verify_spots.mjs)。
    //
    //    −1.53rad ≈ −87.6°,即从**下游**(+z)看回来:船在 z∈[3.77,15.28],
    //    机位落在 z≈21.6,虹桥(z≤3.9)就退到船后面去了。顺带成了画里
    //    最经典的那一幕:漕船朝着虹桥去。
    azimuth: -1.53,
    pitch: 0.22,
    why:
      '机位在下游、顺着河道看回来 —— 船在前、虹桥在后,与画中"漕船将过桥"的' +
      '关系一致。俯角压到 0.22 是为了看见舷弧与舱篷的纵向关系:俯角一大,' +
      '船就成了一条梭子。' +
      '瞄 0.55 高度(水线以上一点)而不是盒心:盒心在龙骨附近,瞄它会把' +
      '船压在画面下半。',
  },
  {
    id: 'teahouse',
    name: '茶肆',
    anchor: 'shop_e0_1_cha_facade',
    heightFrac: 0.5,
    fill: 0.85,
    azimuth: Math.PI, // 从 −X 方向看,即从河/街一侧看岸
    pitch: 0.2,
    why:
      '临河茶肆的正面朝西(朝街),所以机位必须落在 −X 一侧,否则只能看到' +
      '背面。俯角取 0.20 —— 再大就把凉棚的挑出遮住了,而凉棚正是这间铺子' +
      '与普通悬山铺面的区别。',
  },
  {
    id: 'gate',
    name: '城门',
    anchor: 'gate_tower',
    heightFrac: 0.45,
    fill: 0.75,
    azimuth: -2.15,
    pitch: 0.22,
    why:
      '城门在东南、城墙沿 Z 铺开。机位从西北方看 —— 那是从河上望向城门' +
      '的方向,与画中"沿河望去见城楼"的视向一致。' +
      '锚点用 `gate_tower`(门楼本体)而不是整段城墙:城墙有 240m 长,' +
      '量进取景就成了一个远处的土坡。',
  },
  {
    id: 'market',
    name: '街市',
    // ⚠️ 锚点换过一次。第一版用 `mid_frame_e`,因为名字里有 "frame" ——
    //    量出来它 X[21.2, 40.8] Y[−96, 95] Z[0.3, 3.3]:**191m 长、
    //    3m 高的街区背墙**,不是街。用它当锚点会得到一张 191m 长土墙的
    //    全景。"名字里有 frame 就是街景"是个没验过的假定。
    //    换成彩楼欢门 `cel_e00_frame`:8.26m 宽 × 6.77m 高的实际构筑物,
    //    立在东岸店铺行(x≈19.85)前面,街道在它西侧 —— 这才是街市。
    anchor: 'cel_e00_frame',
    heightFrac: 0.45,
    // fill 取得比别的景点小:街市要的是**街**,彩楼欢门只是这条街的门框。
    // 填满了就只剩一个架子,看不出"街"。
    fill: 0.62,
    // 视线不是从物体正面看,而是**沿街**看过去:相机落在街面 x≈13,
    // 斜着望向门楼与它身后的店铺行。
    azimuth: -2.065,
    pitch: 0.13,
    why:
      '锚点取东岸的彩楼欢门,机位落在街面、沿街斜看 —— 门楼下是店铺行,' +
      '街道在它西侧,这样一张图里同时有门楼、店面与街。' +
      'fill 只取 0.62:填满了就只剩一个架子,街看不出来。',
  },
];

const { byName: QM_IDS } = await loadQmIds(ROOT);

const spots = SPECS.map((s) => {
  const b = box(s.anchor);
  const tgt = center(b, s.heightFrac);
  const d = dir(s.azimuth, s.pitch);
  const dist = fitDistance(b, tgt, d, ASPECT, FOV_DEG, s.fill);
  const view = add(tgt, d, dist);

  // 「走近看看」= 沿同一条视线缩短半径,视线方向不变 ——
  // 否则"走近"会变成"换一个角度看",与用户的预期不符。
  const near = add(tgt, d, dist * 0.45);

  // ⚠️ 相机不许落在地面以下。街面一带实测在 y ≈ 0,远处台地顶面 y = 3.85。
  //    这里用 2.2m 作最低高度 —— 低于它就该抬高,而不是让脚本记下一个
  //    地下机位。抬高只动 y,视线仍指向 target。
  const MIN_Y = 2.2;
  const raised = [];
  for (const [nm, p] of [['view', view], ['near', near]]) {
    if (p[1] < MIN_Y) {
      raised.push(`${nm} ${p[1].toFixed(2)}→${MIN_Y}`);
      p[1] = MIN_Y;
    }
  }

  return {
    id: s.id,
    name: s.name,
    anchor: {
      object: s.anchor,
      // ⚠️ 两个名字都要存。`object` 是 Blender 物体名(对着 stats.json 看尺寸
      //    时用),`qmId` 是网页标识(对着浏览器看时用)。只存一个的话,
      //    另一半工具的比对会**静默失败** —— 详见 tools/lib/qmids.mjs 的说明。
      qmId: qmIdOf({ byName: QM_IDS }, s.anchor),
      kind: b.kind,
      bboxThree: [...b.lo, ...b.hi],
    },
    target: r3(tgt),
    view: r3(view),
    near: r3(near),
    derived: {
      rule:
        'view = target + dir(azimuth,pitch) × fitDistance(bbox, fill);' +
        'fitDistance 解 |w·right| ≤ tanH·fill·(dist−w·d) 逐角点取最大',
      fovDeg: FOV_DEG,
      aspect: Number(ASPECT.toFixed(4)),
      fill: s.fill,
      dist: r3([dist])[0],
      azimuth: s.azimuth,
      pitch: s.pitch,
      raisedToMinY: raised.length ? raised : null,
    },
    why: s.why,
  };
});

function r3(a) {
  return a.map((v) => Math.round(v * 1000) / 1000);
}

const doc = {
  schema: 1,
  generatedFrom: 'blender/out/stats.json',
  seed: stats.seed,
  unit: 'm',
  coordNote:
    '本文件里的坐标一律是 **three 坐标(Y 向上)**。由 Blender 的 Z-up 换算:' +
    'x=x, y=z, z=−y。直接与 probe_pixel_web.mjs 的命中点比对,不需要再换算。',
  spots,
};

console.log('─'.repeat(80));
console.log(`景点机位(由实测包围盒推导) — 锚点池 ${byName.size - noBoxCount} 个有形状的物体,` +
            `另有 ${noBoxCount} 个(骨架等)无量不出包围盒,已在锚点池里标出原因`);
console.log('─'.repeat(80));
for (const s of spots) {
  console.log(`${s.name.padEnd(4)} 锚点 ${s.anchor.object}  (${s.anchor.kind})`);
  console.log(
    `     目标 (${s.target.join(', ')})` +
      `   fill ${s.derived.fill} → 距离 ${s.derived.dist} m`,
  );
  console.log(`     全景 (${s.view.join(', ')})`);
  console.log(`     近观 (${s.near.join(', ')})`);
  if (s.derived.raisedToMinY) {
    console.log(`     ⚠️ 抬到最低高度:${s.derived.raisedToMinY.join('、')}`);
  }
}
console.log('─'.repeat(80));

if (process.argv.includes('--dry')) {
  console.log('--dry:不写文件。');
} else {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`已写入 ${OUT}`);
}
