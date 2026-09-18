/**
 * 直接拆 GLB —— 零依赖的 glTF 容器解析与统计。
 *
 * 为什么自己写,不用 @gltf-transform/cli
 * --------------------------------------
 * 计划里原定用 `@gltf-transform inspect`。改掉了,三条理由:
 *
 *   1. **它会把 `npm ci` 变脆。** 那条 CLI 拖着 sharp 一类的原生二进制,
 *      而本项目对外的硬承诺之一是"全新 clone → npm ci → build 四步零
 *      手工干预"。为一个只生成一张统计表的工具押上这条承诺,不值。
 *   2. **它返回的是它自己的字段名。** 报告里我要写的判据是
 *      "对象数 + 每对象三角面 + 包围盒(1e-4)",这几个量的口径必须
 *      落在这份文件里,而不是落在别人的版本号里。计划里那条
 *      "gltf-transform CLI 参数漂移"的风险,自己写就不存在了。
 *   3. **要数的东西本来就不多。** JSON 块就是个规范化的结构体,
 *      拆它不需要一个库。
 *
 * ⚠️ 与 `tools/check_texture_decode.mjs` 的关系:那个脚本里也有一段
 *    GLB 分块解析,但它做的是**浏览器里的解码验证**(真实解码后的
 *    尺寸与色彩空间),和这里的"读文件头"不是同一件事,所以两份都留着。
 *    哪边是权威要说清楚:**解码后的尺寸与色彩空间以那个脚本为准**,
 *    这里报的是**编码在文件里的**尺寸。两者不一致本身就是个要查的信号。
 *
 * 能力边界
 * --------
 * · 只读,不改写、不校验规范合规性。
 * · 包围盒:由 POSITION accessor 的 min/max 逐角点变换后取**轴对齐**
 *   包围盒。物体被旋转时它比真实范围偏大(这是 AABB 的定义,不是算错),
 *   所以它适合判"位置与尺度是否漂移",不适合判"形状是否一致"。
 * · 图像尺寸读的是 PNG/WebP/JPEG 的文件头。三种以外的格式报 null,
 *   不猜。
 * · 不解析 accessor 的实际数据 —— 顶点数据的内容一律不管。
 */

import { readFileSync } from 'node:fs';

const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

/** 包围盒/尺寸的取整位数。与 Blender 侧 report_objects.py 的 ND 一致。 */
export const ND = 4;

export function round4(x) {
  const v = Number(x.toFixed(ND));
  return v === 0 ? 0 : v;
}

/**
 * 拆开 GLB 容器,拿到 JSON 块与 BIN 块的字节区间。
 *
 * 头部布局(GLB 2.0):magic(4) version(4) length(4),之后是若干块,
 * 每块 = length(4) type(4) data(length)。
 */
export function parseGlb(buf) {
  if (buf.length < 12) throw new Error('文件不足 12 字节,不是 GLB');
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) {
    throw new Error(`magic 不是 "glTF"(读到 0x${magic.toString(16)}),不是 GLB`);
  }
  const version = buf.readUInt32LE(4);
  const totalBytes = buf.readUInt32LE(8);

  let off = 12;
  let json = null;
  let binStart = 0;
  let binLength = 0;
  let jsonBytes = 0;

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (type === CHUNK_JSON) {
      json = JSON.parse(buf.subarray(start, start + len).toString('utf8'));
      jsonBytes = len;
    } else if (type === CHUNK_BIN) {
      binStart = start;
      binLength = len;
    }
    // 块长按 4 字节对齐
    off = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('GLB 里没有 JSON 块');
  return { version, totalBytes, json, jsonBytes, binStart, binLength };
}

// --------------------------------------------------------------------------
// 矩阵
//
// glTF 的矩阵是**列主序**的 16 个数。写行主序的直觉在这里必错,
// 而且错了之后结果看上去也像个矩阵 —— 所以下面每个函数都标了序。
// --------------------------------------------------------------------------

/** 平移/旋转/缩放合成为列主序 4×4。四元数按 glTF 的 (x,y,z,w) 序。 */
function composeTRS(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

/** 列主序 4×4 相乘:返回 a·b(a 在后应用,b 先应用)。 */
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  return composeTRS(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
}

function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

// --------------------------------------------------------------------------
// 几何量
// --------------------------------------------------------------------------

/** 一个 primitive 的三角面数。mode 缺省是 4(TRIANGLES)。 */
function primTriangles(json, prim) {
  const mode = prim.mode === undefined ? 4 : prim.mode;
  const acc = (i) => json.accessors[i];
  if (mode !== 4) {
    // 条带/扇面:顶点数 − 2。Blender 导出器不用这两种,但报错要准。
    const n = acc(prim.attributes.POSITION).count;
    if (mode === 5 || mode === 6) return Math.max(0, n - 2);
    return 0; // 点/线:不计三角面
  }
  if (prim.indices !== undefined) return Math.floor(acc(prim.indices).count / 3);
  return Math.floor(acc(prim.attributes.POSITION).count / 3);
}

/** 一个 mesh 的局部 AABB(逐 primitive 并集),由 POSITION 的 min/max 得出。 */
function meshLocalBbox(json, mesh) {
  let lo = null;
  let hi = null;
  for (const prim of mesh.primitives) {
    const a = json.accessors[prim.attributes.POSITION];
    if (!a || !a.min || !a.max) continue;
    if (!lo) {
      lo = a.min.slice();
      hi = a.max.slice();
    } else {
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], a.min[i]);
        hi[i] = Math.max(hi[i], a.max[i]);
      }
    }
  }
  return lo ? { min: lo, max: hi } : null;
}

/** 把局部 AABB 的八个角点变换后取世界 AABB(会偏大,见文件头的能力边界)。 */
function transformBbox(m, box) {
  if (!box) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = [
      i & 1 ? box.max[0] : box.min[0],
      i & 2 ? box.max[1] : box.min[1],
      i & 4 ? box.max[2] : box.min[2],
    ];
    const w = transformPoint(m, p);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], w[k]);
      hi[k] = Math.max(hi[k], w[k]);
    }
  }
  return [
    round4(lo[0]), round4(lo[1]), round4(lo[2]),
    round4(hi[0]), round4(hi[1]), round4(hi[2]),
  ];
}

// --------------------------------------------------------------------------
// 图像头
// --------------------------------------------------------------------------

/** 从图像字节里读编码尺寸。认不出的格式返回 null —— 不猜。 */
export function imageHeader(bytes) {
  if (bytes.length < 24) return null;
  const b = bytes;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // WebP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fourcc = b.subarray(12, 16).toString('latin1');
    if (fourcc === 'VP8X') {
      const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
      const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
      return { format: 'webp/vp8x', width: w, height: h };
    }
    if (fourcc === 'VP8 ') {
      // 帧头:3 字节 tag + 3 字节起始码,然后是 14 位宽、14 位高
      const w = (b[26] | (b[27] << 8)) & 0x3fff;
      const h = (b[28] | (b[29] << 8)) & 0x3fff;
      return { format: 'webp/vp8', width: w, height: h };
    }
    if (fourcc === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return {
        format: 'webp/vp8l',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    return { format: 'webp/unknown', width: null, height: null };
  }
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15,但排除 DHT(c4)/JPG(c8)/DAC(cc)
      if (marker >= 0xc0 && marker <= 0xcf &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return { format: 'jpeg/unknown', width: null, height: null };
  }
  return null;
}

// --------------------------------------------------------------------------
// 统计
// --------------------------------------------------------------------------

/**
 * 把一个 GLB 统计成可 JSON 化的对象。
 *
 * 比 Blender 侧的 `report_objects.py` 多出、且只有这边才能量的:
 *   · 每种顶点属性出现了几次(COLOR_0 在不在、JOINTS_0/WEIGHTS_0 在不在)
 *   · extensionsUsed / extensionsRequired —— **EXT_texture_webp 就是从这里看**
 *   · 贴图在文件里**实际占的字节**(从 bufferViews 量,不是解压后的光栅大小)
 *   · 每个 primitive 的 material 槽位与 mode
 */
export function summarizeGlb(buf, { path = '', name = '' } = {}) {
  const { version, totalBytes, json, jsonBytes, binStart, binLength } = parseGlb(buf);
  const g = json;

  // —— 图像:字节数与文件头 ——
  const images = (g.images || []).map((img, i) => {
    let bytes = null;
    let embedded = false;
    if (img.bufferView !== undefined) {
      const bv = g.bufferViews[img.bufferView];
      bytes = buf.subarray(binStart + (bv.byteOffset || 0), binStart + (bv.byteOffset || 0) + bv.byteLength);
      embedded = true;
    } else if (img.uri && img.uri.startsWith('data:')) {
      const b64 = img.uri.slice(img.uri.indexOf(',') + 1);
      bytes = Buffer.from(b64, 'base64');
      embedded = true;
    }
    const head = bytes ? imageHeader(bytes) : null;
    return {
      index: i,
      name: img.name || '',
      mimeType: img.mimeType || (img.uri && !img.uri.startsWith('data:')
        ? img.uri.slice(img.uri.lastIndexOf('.') + 1) : ''),
      byteLength: bytes ? bytes.length : null,
      embedded,
      // 外链贴图的 uri 会离开 GLB。生产里不许出现 —— stats_report 会检查。
      externalUri: img.uri && !img.uri.startsWith('data:') ? img.uri : null,
      width: head ? head.width : null,
      height: head ? head.height : null,
      headerFormat: head ? head.format : null,
    };
  });

  const textureImages = (g.textures || []).map((t, i) => {
    // ⚠️ EXT_texture_webp 把 image 索引放在 extensions 里,**不在 t.source 上**。
    //    只读 t.source 会得到 undefined,于是"这张贴图指向哪张图"变成
    //    "没有图",而报告上看上去只是空了一格。实测确认过。
    const webp = t.extensions && t.extensions.EXT_texture_webp;
    const src = webp && webp.source !== undefined ? webp.source : t.source;
    return { index: i, name: t.name || '', source: src, viaWebp: Boolean(webp) };
  });

  // —— 逐 primitive / 逐 mesh ——
  const meshes = (g.meshes || []).map((m, i) => {
    const prims = m.primitives.map((p) => ({
      mode: p.mode === undefined ? 4 : p.mode,
      material: p.material === undefined ? null : p.material,
      vertices: g.accessors[p.attributes.POSITION] ? g.accessors[p.attributes.POSITION].count : 0,
      triangles: primTriangles(g, p),
      attributes: Object.keys(p.attributes).sort(),
      targets: p.targets ? p.targets.length : 0,
    }));
    return {
      index: i,
      name: m.name || '',
      primitives: prims,
      triangles: prims.reduce((s, p) => s + p.triangles, 0),
      localBbox: meshLocalBbox(g, m),
    };
  });

  // —— 节点树:算世界矩阵,得出"每对象世界包围盒 + 三角面" ——
  const nodes = g.nodes || [];
  const parents = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => {
    for (const c of n.children || []) parents[c] = i;
  });
  const worldCache = new Map();
  const worldMatrix = (i) => {
    if (worldCache.has(i)) return worldCache.get(i);
    const local = nodeMatrix(nodes[i]);
    const m = parents[i] >= 0 ? mul(worldMatrix(parents[i]), local) : local;
    worldCache.set(i, m);
    return m;
  };

  const items = [];
  nodes.forEach((n, i) => {
    if (n.mesh === undefined) return;
    const mesh = meshes[n.mesh];
    const skin = n.skin === undefined ? null : n.skin;
    items.push({
      node: i,
      name: n.name || '',
      mesh: n.mesh,
      meshName: mesh.name,
      triangles: mesh.triangles,
      bbox: transformBbox(worldMatrix(i), mesh.localBbox),
      materials: [...new Set(mesh.primitives.map((p) => p.material))].sort(
        (a, b) => (a ?? -1) - (b ?? -1),
      ),
      skinned: skin !== null,
      boneCount: skin !== null && g.skins && g.skins[skin]
        ? g.skins[skin].joints.length : 0,
      // 节点 extras —— 也就是 Blender 侧 `tag()` 写进去的 qm_* 标签。
      //
      // ⚠️ 这一项是**必须**的,不是顺手加的:`blender/out/stats.json` 只
      //    记了 `tagKeys`(标签的**名字**),没记**值**。于是按 blender 的
      //    物体名(`虹桥_桥面`)去和网页里的标识(`bridge_deck`)比对,
      //    永远对不上 —— 两个名字分属两套命名,而只有 GLB 里同时有
      //    "节点名"和"qm_id",是唯一能把它们连起来的地方。
      //    (`tools/perf/verify_spots.mjs` 第一版就栽在这:虹桥被判成
      //     "射线穿过去了",其实是拿 `虹桥` 去比 `bridge_deck`。)
      extras: n.extras || null,
    });
  });
  // 按名字排序:节点顺序由导出器决定,不是判据的一部分 —— 但**同一份导出器
  // 在同样的输入下顺序应当稳定**。若两次构建顺序不同而集合相同,排序能
  // 让比对只看集合;顺序不同这件事本身会被下面的 nodeOrder 记下来。
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.mesh - b.mesh));

  const attrHist = {};
  for (const m of meshes) {
    for (const p of m.primitives) {
      for (const a of p.attributes) attrHist[a] = (attrHist[a] || 0) + 1;
    }
  }

  return {
    name: name || path.split(/[\\/]/).pop(),
    path,
    container: { version, totalBytes, jsonBytes, binBytes: binLength },
    generator: (g.asset && g.asset.generator) || '',
    gltfVersion: (g.asset && g.asset.version) || '',
    extensionsUsed: (g.extensionsUsed || []).slice().sort(),
    extensionsRequired: (g.extensionsRequired || []).slice().sort(),
    counts: {
      nodes: nodes.length,
      meshNodes: items.length,
      meshes: meshes.length,
      primitives: meshes.reduce((s, m) => s + m.primitives.length, 0),
      materials: (g.materials || []).length,
      textures: (g.textures || []).length,
      images: images.length,
      samplers: (g.samplers || []).length,
      skins: (g.skins || []).length,
      animations: (g.animations || []).length,
      accessors: (g.accessors || []).length,
      bufferViews: (g.bufferViews || []).length,
    },
    triangles: items.reduce((s, it) => s + it.triangles, 0),
    // 每对象三角面的**分布**,用于比对:总和相同但分布不同,是两种不同的场景。
    trianglesByObject: Object.fromEntries(
      items.map((it) => [it.name, it.triangles]).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    attributes: Object.fromEntries(Object.entries(attrHist).sort()),
    materials: (g.materials || []).map((m, i) => ({
      index: i,
      name: m.name || '',
      // 双面与 alphaMode 会影响 drawcall 与排序,记下来
      doubleSided: Boolean(m.doubleSided),
      alphaMode: m.alphaMode || 'OPAQUE',
      hasPbr: Boolean(m.pbrMetallicRoughness),
      metallicFactor: m.pbrMetallicRoughness && m.pbrMetallicRoughness.metallicFactor !== undefined
        ? m.pbrMetallicRoughness.metallicFactor : 1,
      roughnessFactor: m.pbrMetallicRoughness && m.pbrMetallicRoughness.roughnessFactor !== undefined
        ? m.pbrMetallicRoughness.roughnessFactor : 1,
    })),
    images,
    textures: textureImages,
    items,
  };
}

/** 从磁盘读并统计。 */
export function summarizeGlbFile(path) {
  return summarizeGlb(readFileSync(path), { path });
}

/**
 * 只取确定性判据所需的那部分:
 * 对象数 + 每对象三角面 + 每对象世界包围盒(1e-4)。
 *
 * 比对用这一个函数,不要在调用处各写一遍 —— 两份"判据"必然会在
 * 某次改动里漂开,而漂开之后仍然各自看着正常。
 */
export function determinismKey(s) {
  return {
    name: s.name,
    meshNodes: s.counts.meshNodes,
    triangles: s.triangles,
    items: s.items.map((it) => ({
      name: it.name,
      triangles: it.triangles,
      bbox: it.bbox,
    })),
  };
}
