#!/usr/bin/env node
/**
 * 可复现性验证:从头跑两次构建,比统计量是否一致。
 *
 * 判据为什么是**统计量**而不是二进制哈希
 * --------------------------------------
 * 计划里写明:以"对象数 + 每对象三角面 + 包围盒(1e-4 精度)"为等价判据。
 * 理由是 glTF 导出器会往文件里写 generator 字段一类的元信息,二进制
 * 哈希可能不同 —— 哈希不同**不等于**场景不同。
 *
 * ⚠️ 但这条理由本身是**推断,不是实测**。所以本脚本把哈希也一并量出来
 *    并如实报告,只是**不拿它当判据**:
 *      · 哈希一致 ⇒ 顺带得到一个更强的结论(两次构建逐字节相同);
 *      · 哈希不一致 ⇒ 把**首次差异的字节位置与上下文**打出来,
 *        让它变成一个可以查的事实,而不是一句"反正是元信息"。
 *    一句话说不清的事,就让两行字节来回答。
 *
 * 判据分两层,两层都必须过
 * ------------------------
 *   场景层(blender/out/stats.json):对象名/类型/三角面/世界包围盒
 *   产物层(GLB 解包)              :节点名/三角面/世界包围盒/属性表/贴图字节
 * 只比场景层不够 —— 导出器自己也可能不确定(例如材质顺序、贴图编码)。
 * 只比产物层也不够 —— 产物对不上时,场景层能指出是哪一步漂的。
 *
 * ⚠️ 会跑两次完整构建,期间**会反复改写 `public/models/`**。
 *    别和别的构建同时跑。
 *
 * 用法:
 *   node tools/verify_reproducible.mjs                 # 两次,阶段 2
 *   node tools/verify_reproducible.mjs --runs 3
 *   node tools/verify_reproducible.mjs --reuse         # 不重跑,只比已有的 _repro/
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { determinismKey, summarizeGlbFile } from './lib/glb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'blender', 'out');
const REPRO = join(OUT, '_repro');
const MODELS = join(ROOT, 'public', 'models');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const RUNS = Number(opt('runs', '2'));
const STAGE = opt('stage', '2');
const REUSE = has('reuse');
const BLENDER = process.env.QM_BLENDER || 'D:/blender/install/blender.exe';
const TOL = 1e-4;

const B = '─'.repeat(78);

// --------------------------------------------------------------------------
// 采集一次
// --------------------------------------------------------------------------

function runBuild(i) {
  const log = join(OUT, `_repro_run${i}.log`);
  console.log(`  [${i}/${RUNS}] 构建中 … 日志 ${log.replace(ROOT + '\\', '')}`);
  const t0 = Date.now();
  const r = spawnSync(
    BLENDER,
    ['--background', '--factory-startup', '--python', join(ROOT, 'blender', 'run_all.py'),
      '--', '--stage', STAGE],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  writeFileSync(log, (r.stdout || '') + (r.stderr || ''), 'utf8');
  if (r.status !== 0) {
    // 退出码是唯一的"构建成功"信号 —— run_all.py 用 os._exit 保证了它是真的
    throw new Error(`第 ${i} 次构建失败(退出码 ${r.status}),详见 ${log}`);
  }
  console.log(`  [${i}/${RUNS}] 完成,用时 ${secs}s`);

  // 日志末尾再核一遍:退出码是 0 但日志说"未完成"这种事
  // 在本项目里**真的发生过**(见 run_all.py 里那段注释),所以两条都看。
  const tailText = (r.stdout || '').split('\n').filter((l) => l.includes('✗') || l.includes('⚠ 以下'));
  if (tailText.length) {
    throw new Error(`第 ${i} 次构建退出码为 0,但日志里有告警:\n    ${tailText.join('\n    ')}`);
  }
  return { secs, log };
}

function collect(i) {
  // —— 场景层 ——
  const statsPath = join(OUT, 'stats.json');
  if (!existsSync(statsPath)) {
    throw new Error(`缺少 ${statsPath} —— run_all.py 应当在导出前写出它`);
  }
  const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
  // meta.builtAt 每次都不同,比对前显式删掉 —— 留着它会让"两次不一致"
  // 变成一个恒真的结论,从而把真正的差异淹掉。
  delete stats.meta;

  // —— 产物层 ——
  const files = readdirSync(MODELS).filter((n) => n.endsWith('.glb')).sort();
  if (!files.length) throw new Error(`${MODELS} 里没有 .glb`);
  const glbs = files.map((name) => {
    const path = join(MODELS, name);
    const s = summarizeGlbFile(path);
    s.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    return s;
  });

  const snap = {
    run: i,
    stats,
    glbs,
    // 原始字节留一份,用于哈希不一致时定位首个差异字节
    raw: Object.fromEntries(files.map((n) => [n, readFileSync(join(MODELS, n))])),
  };
  const dir = join(REPRO, `run${i}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8');
  writeFileSync(
    join(dir, 'glb.json'),
    JSON.stringify(
      glbs.map((g) => ({ ...g, full: undefined, hash: g.sha256, key: determinismKey(g) })),
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(dir, 'hashes.json'),
    JSON.stringify(Object.fromEntries(files.map((n) => [n, snap.raw[n].toString('base64')])), null, 0),
    'utf8',
  );
  return snap;
}

// --------------------------------------------------------------------------
// 比对
// --------------------------------------------------------------------------

const diffs = [];
function cmp(pathText, a, b) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) return;
  diffs.push({ path: pathText, a: sa, b: sb });
}

/** 数值比:超过 TOL 才算差异。用于包围盒这类连续量。 */
function cmpNum(pathText, a, b) {
  if (a === null || b === null) {
    if (a !== b) diffs.push({ path: pathText, a: String(a), b: String(b) });
    return;
  }
  if (Math.abs(a - b) > TOL) diffs.push({ path: pathText, a: String(a), b: String(b) });
}

function compareScene(s1, s2) {
  // totals 是汇总;逐对象那一份才是判据的正身。两个都看 ——
  // 总数一样而逐个不同(改了 A 加了 B),正是"汇总正常、明细不同"的形状。
  for (const k of Object.keys(s1.totals)) cmpNum(`totals.${k}`, s1.totals[k], s2.totals[k]);
  for (const k of ['byKind', 'byZone', 'byLod', 'byAnim', 'tagKeys']) {
    cmp(k, s1[k], s2[k]);
  }
  cmp('agreement', s1.agreement, s2.agreement);

  // 逐对象:按名字对齐,比较 类型 / 三角面 / 世界包围盒
  const m1 = new Map(s1.objects.map((o) => [o.name, o]));
  const m2 = new Map(s2.objects.map((o) => [o.name, o]));
  for (const [name, o1] of m1) {
    const o2 = m2.get(name);
    if (!o2) { diffs.push({ path: `objects.${name}`, a: '存在', b: '缺失' }); continue; }
    cmpNum(`objects.${name}.tris`, o1.tris, o2.tris);
    cmpNum(`objects.${name}.verts`, o1.verts, o2.verts);
    if (o1.bbox && o2.bbox) {
      for (let i = 0; i < 6; i++) cmpNum(`objects.${name}.bbox[${i}]`, o1.bbox[i], o2.bbox[i]);
    } else if (o1.bbox !== o2.bbox) {
      diffs.push({ path: `objects.${name}.bbox`, a: String(o1.bbox), b: String(o2.bbox) });
    }
  }
  for (const name of m2.keys()) {
    if (!m1.has(name)) diffs.push({ path: `objects.${name}`, a: '缺失', b: '存在' });
  }
  cmp('materials', s1.materials, s2.materials);
  cmp('images', s1.images, s2.images);
  cmp('armatures', s1.armatures, s2.armatures);
}

function compareGlb(g1, g2) {
  cmp('counts', g1.counts, g2.counts);
  cmpNum('triangles', g1.triangles, g2.triangles);
  cmp('attributes', g1.attributes, g2.attributes);
  cmp('extensionsUsed', g1.extensionsUsed, g2.extensionsUsed);
  cmp('materials', g1.materials, g2.materials);
  const i1 = new Map(g1.items.map((it) => [it.name, it]));
  const i2 = new Map(g2.items.map((it) => [it.name, it]));
  for (const [name, a] of i1) {
    const b = i2.get(name);
    if (!b) { diffs.push({ path: `items.${name}`, a: '存在', b: '缺失' }); continue; }
    cmpNum(`items.${name}.triangles`, a.triangles, b.triangles);
    if (a.bbox && b.bbox) {
      for (let i = 0; i < 6; i++) cmpNum(`items.${name}.bbox[${i}]`, a.bbox[i], b.bbox[i]);
    }
  }
  for (const name of i2.keys()) {
    if (!i1.has(name)) diffs.push({ path: `items.${name}`, a: '缺失', b: '存在' });
  }
  // 贴图:名字/字节数/编码尺寸。**颜色不谈** —— 那是编码器的事,由
  // check_texture_decode.mjs 在浏览器里验。
  const t = (g) => g.images.map((im) => [im.name, im.byteLength, im.width, im.height, im.mimeType]);
  cmp('images', t(g1), t(g2));
}

/** 两份字节的首个差异位置与两侧上下文。哈希不一致时用。 */
function firstByteDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      const ctx = (buf, from) =>
        Array.from(buf.subarray(from, from + 16)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
      // JSON 块里存的是 UTF-8 文本,把上下文按可打印字符解出来 ——
      // 十六进制能定位,但看得出是什么才叫"可以查"。
      const show = (buf) => buf.subarray(i, Math.min(buf.length, i + 48))
        .toString('utf8').replace(/[^\x20-\x7e]/g, '·');
      return {
        offset: i,
        lenA: a.length,
        lenB: b.length,
        hexA: ctx(a, i),
        hexB: ctx(b, i),
        textA: show(a),
        textB: show(b),
      };
    }
  }
  if (a.length !== b.length) {
    return { offset: n, lenA: a.length, lenB: b.length, hexA: '', hexB: '', textA: '(前 n 字节相同,长度不同)', textB: '' };
  }
  return null;
}

// --------------------------------------------------------------------------

console.log(B);
console.log(`可复现性验证 —— 阶段 ${STAGE},跑 ${RUNS} 次`);
console.log(`  blender  ${BLENDER}`);
console.log(`  判据     对象数 + 每对象三角面 + 包围盒(容差 ${TOL})`);
console.log(B);

const snaps = [];
if (REUSE) {
  for (let i = 1; i <= RUNS; i++) {
    const dir = join(REPRO, `run${i}`);
    if (!existsSync(join(dir, 'stats.json'))) {
      throw new Error(`--reuse 需要 ${dir}/stats.json,但没有`);
    }
    const stats = JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8'));
    const glbs = JSON.parse(readFileSync(join(dir, 'glb.json'), 'utf8'));
    const b64 = JSON.parse(readFileSync(join(dir, 'hashes.json'), 'utf8'));
    snaps.push({
      run: i,
      stats,
      glbs,
      raw: Object.fromEntries(Object.entries(b64).map(([k, v]) => [k, Buffer.from(v, 'base64')])),
    });
  }
  console.log('(--reuse:只比对已有快照,未重新构建)');
} else {
  for (let i = 1; i <= RUNS; i++) {
    runBuild(i);
    snaps.push(collect(i));
  }
}

const base = snaps[0];
for (const s of snaps.slice(1)) {
  compareScene(base.stats, s.stats);
  for (const g of s.glbs) {
    const g0 = base.glbs.find((x) => x.name === g.name);
    if (!g0) { diffs.push({ path: `glb.${g.name}`, a: '缺失', b: '存在' }); continue; }
    const before = diffs.length;
    compareGlb(g0, g);
    // 把差异归到文件上,否则一条 `counts.materials` 看不出是哪一块
    for (let i = before; i < diffs.length; i++) diffs[i].path = `${g.name}: ${diffs[i].path}`;
  }
}

// —— 哈希:只报事实,不作判据 ——
console.log();
console.log('二进制哈希(仅供参考,**不作判据**):');
const files = base.glbs.map((g) => g.name);
let hashSame = 0;
for (const name of files) {
  const hashes = snaps.map((s) => s.glbs.find((g) => g.name === name).sha256);
  const allSame = hashes.every((h) => h === hashes[0]);
  if (allSame) hashSame++;
  console.log(`  ${allSame ? '相同' : '不同'}  ${name.padEnd(22)} ${hashes[0].slice(0, 16)}…`);
  if (!allSame) {
    const a = snaps[0].raw[name];
    const b = snaps[1].raw[name];
    const d = firstByteDiff(a, b);
    if (d) {
      console.log(`         首次差异 offset ${d.offset}  (长度 ${d.lenA} / ${d.lenB})`);
      console.log(`           跑1 ${d.hexA}`);
      console.log(`           跑2 ${d.hexB}`);
      console.log(`           跑1 文本 "…${d.textA}"`);
      console.log(`           跑2 文本 "…${d.textB}"`);
    }
  }
}
console.log(`  → ${hashSame}/${files.length} 个文件逐字节相同`);
if (hashSame === files.length) {
  console.log('    这比判据要求更强;判据不要求它,记下来只是因为它是个事实。');
}

// —— 判据 ——
console.log();
console.log(B);
if (diffs.length === 0) {
  console.log('✓ 可复现:所有统计量在容差内一致');
  console.log(`  比对的量:场景层 ${base.stats.objects.length} 个对象,`
    + `产物层 ${base.glbs.reduce((s, g) => s + g.counts.meshNodes, 0)} 个网格节点`);
} else {
  console.log(`✗ 有 ${diffs.length} 处统计量不一致 —— 构建**不确定**`);
  console.log('  前 20 处:');
  for (const d of diffs.slice(0, 20)) {
    console.log(`    ${d.path}`);
    console.log(`      跑1 ${d.a.length > 200 ? d.a.slice(0, 200) + '…' : d.a}`);
    console.log(`      跑2 ${d.b.length > 200 ? d.b.slice(0, 200) + '…' : d.b}`);
  }
  if (diffs.length > 20) console.log(`    …… 另有 ${diffs.length - 20} 处`);
}
console.log(B);

const report = {
  stage: Number(STAGE),
  runs: RUNS,
  tolerance: TOL,
  blender: BLENDER,
  hashIdentical: hashSame,
  files: files.length,
  sceneObjectsCompared: base.stats.objects.length,
  glbMeshNodesCompared: base.glbs.reduce((s, g) => s + g.counts.meshNodes, 0),
  diffs: diffs.slice(0, 200),
  diffCount: diffs.length,
  pass: diffs.length === 0,
  note: 'meta.builtAt 每次不同,已在比对前删除;二进制哈希如实记录但不作判据。',
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'repro.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`报告:${join('blender', 'out', 'repro.json')}`);

process.exit(diffs.length === 0 ? 0 : 1);
