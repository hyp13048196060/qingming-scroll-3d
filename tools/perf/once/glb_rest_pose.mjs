/**
 * 把一份 GLB 里每个**命名节点**的静止世界矩阵导出来,供改前后逐件对比。
 *
 * 用法:
 *     node tools/perf/once/glb_rest_pose.mjs public/models/boats.glb before.json
 *     node tools/perf/once/glb_rest_pose.mjs public/models/boats.glb after.json
 *
 * ## 为什么要有这个工具
 *
 * 阶段 4 给整船加轻摇时,船上的构件被**挂到了船壳下**(父子关系),
 * 从平铺的同级件变成嵌套节点。这件事的正确性判据只有一句:
 *
 *     **静止姿态下,每一件的世界变换必须与改动前一模一样。**
 *
 * 不能靠看渲染图:船挂错了只是相对位置偏一点,或者干脆父级矩阵
 * 乘了两遍(整条船被 yaw 转了两次),而单看一张截图两张都"看着挺正常"。
 * 也不能靠"节点数对得上"—— 数量守恒完全不蕴含位置守恒。
 *
 * 所以这里直接把矩阵抠出来比。差一点都不放过。
 *
 * ## 口径
 *
 * - 只取**有名字**的节点:glTF 里无名节点是导出器插的中间层,
 *   名字本身不稳定,拿它当归一化的键会误报。
 * - 世界矩阵按 glTF 的节点层级自根向下累乘,不做任何"看看像不像"的宽容。
 * - 输出按名字排序,便于 diff,也便于人读。
 * - 同时报 `maxDepth`:平铺是 0,挂成父子后必然 >0。
 *   **它是"父子关系到底建没建起来"的判据** —— 真挂上了才谈得上比矩阵。
 */
import fs from 'node:fs';

function matMul(a, b) {
  // 列主序 4x4(glTF 与 three 同序):r = a·b
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < 4; i++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + i] * b[c * 4 + k];
      r[c * 4 + i] = s;
    }
  }
  return r;
}

/** glTF 的 TRS → 列主序矩阵。四元数是 (x,y,z,w)。 */
function trsToMat(n) {
  if (n.matrix) return n.matrix.slice();
  const t = n.translation || [0, 0, 0];
  const q = n.rotation || [0, 0, 0, 1];
  const s = n.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m = [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
  return m;
}

function loadGlb(path) {
  const b = fs.readFileSync(path);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path} 不是 GLB`);
  let off = 12;
  while (off < b.length) {
    const len = b.readUInt32LE(off);
    const type = b.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) {
      return JSON.parse(b.slice(off + 8, off + 8 + len).toString('utf8'));
    }
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  throw new Error(`${path} 里没有 JSON 块`);
}

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('用法: node glb_rest_pose.mjs <x.glb> <out.json>');
  process.exit(2);
}

const json = loadGlb(src);
const nodes = json.nodes || [];
const kids = new Set();
for (const n of nodes) for (const c of n.children || []) kids.add(c);
const roots = nodes.map((_, i) => i).filter((i) => !kids.has(i));

const pose = {};
let maxDepth = 0;

function walk(i, parentMat, depth) {
  const world = matMul(parentMat, trsToMat(nodes[i]));
  if (depth > maxDepth) maxDepth = depth;
  const name = nodes[i].name;
  if (name) {
    const r = (v) => Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e6) / 1e6;
    pose[name] = world.map(r);
  }
  for (const c of nodes[i].children || []) walk(c, world, depth + 1);
}

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
for (const r of roots) walk(r, I, 0);

const named = Object.keys(pose).sort();
const sorted = {};
for (const k of named) sorted[k] = pose[k];

fs.writeFileSync(out, JSON.stringify({ src, nodes: nodes.length, roots: roots.length, maxDepth, pose: sorted }, null, 1));
console.log(`${src}: 节点 ${nodes.length} · 顶层 ${roots.length} · 最大深度 ${maxDepth} · 具名节点 ${named.length} → ${out}`);
