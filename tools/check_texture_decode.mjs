#!/usr/bin/env node
/**
 * 贴图能否**真的解码**——容器面 + 浏览器面,两面都查。
 *
 * 为什么必须有这个工具
 * --------------------
 * 阶段 2 把导出贴图从 PNG 换成 WebP,四个 GLB 从 37.84 MB 降到 12.71 MB。
 * 省下来的体积是真的,但**"体积小了"和"画面上看得见"是两件事**:
 * 一个解不开的贴图集,GLB 照样小、照样能导出成功,页面照样加载——
 * 只是模型变成一片平色。这是本项目反复栽的那个模式(读数正常,病灶
 * 在别处)在资产侧的翻版,所以不能靠"loader 应该支持吧"结案。
 *
 * 两段查的是**两个不同的问题**,缺一不可:
 *
 *   一、容器面(纯 Node,不开浏览器)
 *       问:导出的字节**是不是** WebP?图像是内嵌还是外部引用?
 *       它能抓到"导出器换了格式"或"图像被写成外链"(后者会让
 *       verify_offline 失败,而且离线打开就是一片白)。
 *
 *   二、浏览器面(真 Chrome,真 GPU)
 *       问:这台机器的这个浏览器,**解不减得开**这些字节?
 *       它去把 GLB 里的 WebP 数据切出来直接 createImageBitmap,
 *       并检查 three.js 装好的材质里每张贴图有没有真实尺寸。
 *       —— 容器面全绿而这里挂掉,是完全可能的(格式对但解码器不支持)。
 *
 * ⚠️ 别把"第 2 段需要浏览器"当成可以偷懒的理由。本项目所有关于
 *    "能不能显示"的结论,都必须在浏览器里量过才算数。
 *
 * 用法:
 *   node scripts/serve-dist.mjs --dir dist --port 4173 &
 *   node tools/check_texture_decode.mjs --url http://127.0.0.1:4173/
 */
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launch, sleep } from './perf/lib/cdp.mjs';

function parseArgs(argv) {
  const a = { models: 'public/models', url: '', timeout: 120000, config: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--models') a.models = argv[++i];
    else if (k === '--url') a.url = argv[++i];
    else if (k === '--timeout') a.timeout = Number(argv[++i]);
    else if (k === '--config') a.config = argv[++i];
    else if (k === '--help' || k === '-h') {
      console.log('用法: node tools/check_texture_decode.mjs [--models public/models] [--url http://...]');
      console.log('                                        [--config blender/config.py]');
      console.log('      不给 --url 就只跑容器面(第 1 段)。');
      console.log('      给 --config 会把贴图里量出的粗糙度与 config 的声明区间核对。');
      process.exit(0);
    }
  }
  return a;
}

/**
 * 从 `blender/config.py` 里读出 `ROUGH = { "类名": (下限, 上限), ... }`。
 *
 * 为什么要跨语言去读一个 Python 文件:因为「贴图里量出来的粗糙度」与
 * 「config 里声明的区间」是**两条独立路径产生的数**,两条对得上,才说明
 * 生成器真的按声明在画 —— 这正是本项目一直在用的取证方式。少了这一步,
 * 「粗糙度符合设定」就只是一句话,没有读数撑着。
 *
 * ⚠️ 解析**不许静默失败**。读不到就抛错退出,而不是当成"没有 config,
 *    跳过检查" —— 那样一次拼写错误会被读成"检查通过",正是本项目
 *    反复栽的那个模式。
 */
function loadRoughBands(path) {
  const src = readFileSync(path, 'utf8'); // 同步读:只在启动时做一次
  const block = src.match(/^\s*ROUGH\s*=\s*\{([\s\S]*?)^\s*\}/m);
  if (!block) throw new Error(`${path} 里找不到 ROUGH = { ... } 块`);
  const bands = {};
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*"([a-z_]+)"\s*:\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)\s*,/);
    if (m) bands[m[1]] = [Number(m[2]), Number(m[3])];
  }
  const n = Object.keys(bands).length;
  if (n < 5) throw new Error(`${path} 的 ROUGH 只解析出 ${n} 项,太少,多半是格式变了`);
  return bands;
}

/** 贴图名 → config 里的材质类名:`tex_wood_plank_r` → `wood_plank`。 */
function texToClass(texName) {
  const m = texName.match(/^tex_(.+)_[cnr]$/);
  return m ? m[1] : null;
}

const args = parseArgs(process.argv.slice(2));
const problems = [];
const notes = [];

/**
 * 粗糙度核对的量化容差(0–255 灰阶)。
 *
 * 取 3 的依据:核对的是**有损 WebP 解出来的像素**与**config 里的小数声明**。
 * 编解码往返 + 浮点转字节的舍入,挪动一两个灰阶是正常的;放宽 3 足够
 * 吸收这些噪声,又不至于把"生成器真的画错了"也放过去(声明区间本身
 * 宽 30–50 个灰阶,3 只是零头)。
 */
const TOL = 3;

// --------------------------------------------------------------------------
// GLB 容器解析(与页面里那段逻辑同源,但这里用 Node 的 Buffer)
// --------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

/**
 * 拆开 GLB,拿到 JSON 块与 BIN 块的字节区间。
 *
 * ⚠️ bufferView 的 byteOffset 是**相对 BIN 块起点**的,不是相对文件头。
 *    早先有教程把两者混用,结果取出来的字节永远是错位的 —— 而错位的
 *    字节拿去解码会失败,失败又容易被误判成"格式不支持"。所以这里
 *    把 binStart 显式返回出来,让调用方别无选择。
 */
function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('不是 GLB 文件(魔数不符)');
  const version = buf.readUInt32LE(4);
  const total = buf.readUInt32LE(8);
  if (total !== buf.length) {
    throw new Error(`GLB 头声明长度 ${total} 与实际 ${buf.length} 不符`);
  }
  let off = 12;
  let json = null;
  let binStart = -1;
  let binLength = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const dataStart = off + 8;
    if (type === CHUNK_JSON) {
      json = JSON.parse(buf.slice(dataStart, dataStart + len).toString('utf8'));
    } else if (type === CHUNK_BIN) {
      binStart = dataStart;
      binLength = len;
    }
    off = dataStart + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('GLB 里没有 JSON 块');
  return { version, json, binStart, binLength };
}

async function containerPass() {
  const dir = resolve(process.cwd(), args.models);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.glb')).sort();
  if (!names.length) {
    problems.push(`目录 ${args.models} 里没有 .glb 文件`);
    return [];
  }

  console.log('─'.repeat(78));
  console.log('第 1 段 · 容器面(不开浏览器)');
  console.log('─'.repeat(78));
  console.log(
    `${'文件'.padEnd(22)}${'图像'.padStart(5)}${'格式'.padStart(14)}` +
      `${'内嵌/外链'.padStart(12)}${'图像字节'.padStart(12)}${'占文件'.padStart(9)}`,
  );

  const summary = [];
  for (const name of names) {
    const path = join(dir, name);
    const fileBytes = (await stat(path)).size;
    const buf = await readFile(path);
    const { json, binStart, binLength } = parseGlb(buf);
    const images = json.images ?? [];
    const exts = json.extensionsUsed ?? [];

    const mimes = new Set();
    let embedded = 0;
    let external = 0;
    let imageBytes = 0;

    for (const im of images) {
      mimes.add(im.mimeType ?? '(缺)');
      if (im.bufferView !== undefined) {
        embedded++;
        const bv = json.bufferViews[im.bufferView];
        imageBytes += bv.byteLength;
        // 取出来验魔数:光看 mimeType 字段是"声明",这里看的是"事实"
        const b = buf.slice(binStart + (bv.byteOffset ?? 0), binStart + (bv.byteOffset ?? 0) + 12);
        const isWebp = b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP';
        const isPng = b.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
        const isJpg = b[0] === 0xff && b[1] === 0xd8;
        if (!isWebp && !isPng && !isJpg) {
          problems.push(`${name}: 图像 #${images.indexOf(im)} 字节既不是 WebP/PNG/JPEG,前 12 字节 = ${b.toString('hex')}`);
        }
        if ((im.mimeType === 'image/webp') !== isWebp) {
          problems.push(
            `${name}: 图像 #${images.indexOf(im)} 声明 mimeType=${im.mimeType},` +
              `而字节事实是 ${isWebp ? 'WebP' : isPng ? 'PNG' : isJpg ? 'JPEG' : '未知'} —— 声明与内容不符`,
          );
        }
      } else if (im.uri) {
        external++;
      }
    }

    if (external) {
      problems.push(
        `${name}: 有 ${external} 张图像是**外部 uri 引用**。GLB 应当是自包含的 —— ` +
          `外链会让离线打开变白图,verify_offline 也会失败。`,
      );
    }
    if (images.length && !exts.includes('EXT_texture_webp') && mimes.has('image/webp')) {
      problems.push(
        `${name}: 用了 WebP 却没有在 extensionsUsed 里声明 EXT_texture_webp —— ` +
          `读取方可能不认识这些贴图。`,
      );
    }
    // —— 金属度审计 ——
    // glTF 的 metallicRoughnessTexture 里 B 通道是金属度。本作品的材质一律
    // 非金属,所以要么 B 通道接近 0,要么一律用 `metallicFactor: 0` 把它乘没。
    // ⚠️ **两个条件都看**才算数:只看到 B 不为 0 就报警,会漏掉"其实被
    //    metallicFactor=0 乘掉了"的情形 —— 那是我第一次写这段时差点犯的错。
    const withMR = [];
    const inertMR = [];
    for (const m of json.materials ?? []) {
      const p = m.pbrMetallicRoughness ?? {};
      if (p.metallicRoughnessTexture?.index === undefined) continue;
      withMR.push(m.name);
      // ⚠️ glTF 里 metallicFactor 的**默认值是 1.0**,不是 0 —— 写成
      //    `?? 0` 会把"没写"当成"非金属",正好把要抓的情形放过去。
      const mf = p.metallicFactor ?? 1.0;
      // 最终金属度 = metallicFactor × B通道。factor 不为 0,B 就会真的参与着色。
      if (mf > 0.05) {
        problems.push(
          `${name}: 材质 ${m.name} 有金属度贴图,而 metallicFactor = ${mf}(非 0)。` +
            `本作品的材质一律非金属;B 通道会被乘进着色,让表面泛出金属反光。`,
        );
      } else {
        inertMR.push(m.name);
      }
    }
    if (withMR.length && inertMR.length === withMR.length) {
      notes.push(
        `${name}: ${withMR.length} 个材质都带金属度贴图,但 metallicFactor 全被写成 0 —— ` +
          `B 通道**不参与着色**,是白带的字节。这不影响画面,只是体积上还有余量。`,
      );
    }

    if (binLength && imageBytes / binLength > 0.95) {
      notes.push(
        `${name}: 图像占了 BIN 块的 ${((imageBytes / binLength) * 100).toFixed(1)}% —— ` +
          `几何几乎不占体积,想再压只能继续动贴图分辨率。`,
      );
    }

    console.log(
      `${name.padEnd(22)}${String(images.length).padStart(5)}` +
        `${[...mimes].join('/').padStart(14)}` +
        `${`${embedded}内/${external}外`.padStart(12)}` +
        `${(imageBytes / 1048576).toFixed(2).padStart(11)}M` +
        `${((imageBytes / fileBytes) * 100).toFixed(1).padStart(8)}%`,
    );
    summary.push({ name, images: images.length, imageBytes, fileBytes, mimes: [...mimes] });
  }
  return summary;
}

// --------------------------------------------------------------------------
// 浏览器面
// --------------------------------------------------------------------------

/**
 * 页面内脚本:直接从 GLB 字节里切出 WebP 来解。
 *
 * 这是**故意绕开 three.js** 的一步:它专门回答"这台机器的这个浏览器
 * 认不认 WebP",与 three.js 的加载链路无关。两件事分开测,出错时
 * 才分得清是"浏览器不行"还是"加载器接线接错了"。
 *
 * ⚠️ 关于"一张图算不算解坏了"——这里踩过一次,记下来:
 *    第一版把"像素标准差 < 1.0"判成"解出来是纯色图,等于没贴图",
 *    于是 `tex_cloth_r` 被判成坏件(512×512、1042 字节、亮度 227、
 *    标准差 0.62)。**那是误判。** 查回去:config.Palette.ROUGH 给
 *    cloth 的区间是 (0.80, 0.95),NORMAL 给的是 0.06(注释原文
 *    「织纹很浅」)—— 布料的粗糙度图**本来就该是一条窄带**,227
 *    正落在 204–242 中间。尺寸对、字节数是活的,东西是好的,
 *    **坏的是我这把尺子**:我用"起伏够不够大"去衡量一张**本来就
 *    不该有起伏**的图。
 *
 *    所以这里的判据只保留**真能说明解码失败**的两条:尺寸为 0、
 *    或者整张全透明(alpha 全 0)。起伏大小**照常量、照常打印**,
 *    但不用来判成败 —— 它是给人看的证据,不是结论。
 */
function decodeProbeScript(glbUrl) {
  return `(async () => {
    const res = await fetch(${JSON.stringify(glbUrl)});
    if (!res.ok) return { error: '取 GLB 失败 HTTP ' + res.status };
    const buf = await res.arrayBuffer();
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) return { error: '不是 GLB' };
    let off = 12, json = null, binStart = -1;
    while (off + 8 <= buf.byteLength) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      const s = off + 8;
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, s, len)));
      else if (type === 0x004e4942) binStart = s;
      off = s + len + ((4 - (len % 4)) % 4);
    }
    const rows = [];
    for (let idx = 0; idx < (json.images || []).length; idx++) {
      const im = json.images[idx];
      const bv = json.bufferViews[im.bufferView];
      const bytes = new Uint8Array(buf, binStart + (bv.byteOffset || 0), bv.byteLength);
      const row = { idx, mime: im.mimeType, bytes: bv.byteLength, name: im.name || '' };
      try {
        const bmp = await createImageBitmap(new Blob([bytes], { type: im.mimeType }));
        row.w = bmp.width; row.h = bmp.height;
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
        // 全分辨率统计,不抽稀 —— 抽稀会漏掉细织纹这类"只在局部起伏"的图
        const lo = [255, 255, 255, 255], hi = [0, 0, 0, 0];
        let sr = 0, sg = 0, sb = 0, sr2 = 0, sg2 = 0, sb2 = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
          if (r < lo[0]) lo[0] = r; if (r > hi[0]) hi[0] = r;
          if (g < lo[1]) lo[1] = g; if (g > hi[1]) hi[1] = g;
          if (b < lo[2]) lo[2] = b; if (b > hi[2]) hi[2] = b;
          if (a < lo[3]) lo[3] = a; if (a > hi[3]) hi[3] = a;
          sr += r; sg += g; sb += b; sr2 += r * r; sg2 += g * g; sb2 += b * b; n++;
        }
        const sd = (s, s2) => Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
        row.rgb = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
        row.sd = [sd(sr, sr2), sd(sg, sg2), sd(sb, sb2)].map((v) => Math.round(v * 100) / 100);
        row.range = [lo.slice(0, 3), hi.slice(0, 3)];
        row.alpha = [lo[3], hi[3]];
      } catch (e) {
        row.error = String(e);
      }
      rows.push(row);
    }
    return { rows };
  })()`;
}

/** 页面内脚本:清点 three.js 真正装到材质上的贴图。 */
const sceneTextureScript = `(() => {
  const qm = window.__QM__;
  if (!qm) return { error: '页面上没有 window.__QM__' };
  const a = qm.assets;
  if (!a) return { error: '资源尚未装配(__QM__.assets 为空)' };
  const SLOTS = ['map','normalMap','roughnessMap','metalnessMap','aoMap','alphaMap','emissiveMap','specularMap','bumpMap','displacementMap'];
  const seen = new Map();
  let meshes = 0, mats = 0;
  const noDims = [];
  for (const [chunk, group] of a.chunks) {
    group.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (!m) continue;
        mats++;
        for (const slot of SLOTS) {
          const t = m[slot];
          if (!t || seen.has(t.uuid)) continue;
          const im = t.image;
          const w = (im && im.width) || 0, h = (im && im.height) || 0;
          seen.set(t.uuid, { chunk, slot, name: t.name || '', w, h, colorSpace: t.colorSpace });
          if (!w || !h) noDims.push(chunk + '/' + (m.name || '?') + '/' + slot);
        }
      }
    });
  }
  const all = [...seen.values()];
  const srgb = all.filter((r) => r.colorSpace === 'srgb');
  const nonColor = all.filter((r) => r.colorSpace !== 'srgb');
  return {
    meshes, mats, textures: all.length, noDims,
    srgbCount: srgb.length, nonColorCount: nonColor.length,
    sample: all.slice(0, 10),
  };
})()`;

async function browserPass(summary, bands) {
  console.log();
  console.log('─'.repeat(78));
  console.log('第 2 段 · 浏览器面(真 Chrome)');
  console.log('─'.repeat(78));

  const { page, close, browserVersion } = await launch({ width: 1600, height: 900 });
  try {
    const consoleErrors = page.collectErrors();
    await page.goto(args.url);
    await page.waitForReady({ timeout: args.timeout });
    await sleep(2500);

    console.log(`浏览器    : ${browserVersion}`);
    const ua = await page.evaluate('navigator.userAgent');
    console.log(`UA        : ${ua}`);

    // —— 2a:绕开 three.js,直接用浏览器自己的解码器 ——
    // ⚠️ **四个分块全解**,不是挑一个解。第一版只解了排在头一个的
    //    boats.glb,于是 scene_core / scene_props 里的 `_r` 图根本没进过
    //    粗糙度核对 —— 而输出看上去是完整的一份报告。抽查冒充全查,
    //    正是本项目最忌讳的那种"看着齐全"。
    const targets = summary.filter((s) => s.images > 0);
    if (!targets.length) {
      problems.push('没有任何分块含贴图,浏览器面无从验起');
    }
    let flat = 0;
    let checked = 0;
    const mr = [];
    for (const target of targets) {
      const glbUrl = new URL(`models/${target.name}`, args.url).href;
      const probe = await page.evaluate(decodeProbeScript(glbUrl));
      if (probe.error) {
        problems.push(`页面内解码探针失败(${target.name}):${probe.error}`);
        continue;
      }
      console.log();
      console.log(`用浏览器原生解码器直接解 ${target.name} 里的全部 WebP(绕开 three.js):`);
      console.log(
        `  ${'#'.padStart(2)} ${'贴图名'.padEnd(24)}${'字节'.padStart(8)}${'尺寸'.padStart(11)}` +
          `${'均值 R/G/B'.padStart(16)}${'标准差 R/G/B'.padStart(18)}${'alpha'.padStart(11)}`,
      );
      // ⚠️ 三个通道都要打。**只打 R 会得出错误结论** —— 本轮就是这么栽的:
      //    glTF 的 metallicRoughnessTexture 规定 **G 通道是粗糙度、B 是金属度**,
      //    **R 通道不参与着色**。第一版只打了 R,于是十二张 `_r` 图全都显示
      //    R 均值 254、范围 250–255,看上去像"粗糙度全被冲到 1.0,与 config
      //    声明的 0.76–0.97 对不上"。差一点就去改生成器了 —— 而真正该看的
      //    是 G 通道,R 是空的。**量错了通道,和量错了量具一样,读数照样一本正经。**
      for (const r of probe.rows) {
        const nm = (r.name || '(无名)').padEnd(24);
        if (r.error) {
          problems.push(`浏览器解不开 ${target.name} 的第 ${r.idx} 张(${r.bytes} 字节):${r.error}`);
          console.log(`  ${String(r.idx).padStart(2)} ${nm}${String(r.bytes).padStart(8)}   ❌ ${r.error}`);
          continue;
        }
        checked++;
        const isMR = /_r$/.test(r.name || '');
        console.log(
          `  ${String(r.idx).padStart(2)} ${nm}${String(r.bytes).padStart(8)}` +
            `${`${r.w}×${r.h}`.padStart(11)}` +
            `${r.rgb.join('/').padStart(16)}` +
            `${r.sd.map((v) => v.toFixed(1)).join('/').padStart(18)}` +
            `${`${r.alpha[0]}–${r.alpha[1]}`.padStart(11)}` +
            (isMR ? '   ← G=粗糙度 B=金属度' : ''),
        );
        // 粗糙度图:把**真正参与着色**的 G、B 记下来,供下面核对
        if (isMR) {
          mr.push({
            glb: target.name, name: r.name,
            g: r.rgb[1], b: r.rgb[2], gsd: r.sd[1], lo: r.range[0][1], hi: r.range[1][1],
          });
        }

        // —— 只判**确实说明解码失败**的两条 ——
        if (!r.w || !r.h) problems.push(`${target.name} 第 ${r.idx} 张解出的尺寸为 0`);
        if (r.alpha[1] === 0) {
          problems.push(
            `${target.name} 第 ${r.idx} 张 ${r.name} 解出来**整张全透明**(alpha 全 0)—— ` +
              `尺寸对但内容空,这是一张贴了等于没贴的图。`,
          );
        }
        // 起伏极小只作**提示**,不作判据:布料粗糙度这类图本来就该是窄带。
        if (Math.max(...r.sd) < 2.0 && r.alpha[0] === 255) flat++;
      }
    }

    console.log();
    console.log(`共解 ${checked} 张,四块合计 ${targets.reduce((s, t) => s + t.images, 0)} 张。`);

    // 粗糙度的**有效通道**(G)与 config 声明区间核对:两条独立路径的数对上了,
    // "贴图符合设定"才算有读数撑着。
    if (mr.length) {
      console.log();
      console.log(`粗糙度图的有效通道(G)${bands ? ' —— 与 config.Palette.ROUGH 核对' : '(未给 --config,只报数)'}:`);
      for (const m of mr) {
        console.log(
          `  ${m.name.padEnd(24)} ${m.glb.padEnd(18)} G 均值 ${String(m.g).padStart(3)}` +
            `(= ${(m.g / 255).toFixed(3)})   G 范围 ${m.lo}–${m.hi}   G 标准差 ${m.gsd.toFixed(2)}`,
        );
        if (!bands) continue;
        const cls = texToClass(m.name);
        const band = cls ? bands[cls] : undefined;
        if (!band) {
          problems.push(
            `${m.name}: 从名字反推不出 config.Palette.ROUGH 里的类名` +
              `(推出来是 ${JSON.stringify(cls)})—— 这张图的粗糙度**没被核对过**,不许当它通过了。`,
          );
          continue;
        }
        // 声明区间换成 0–255,再放宽 TOL:WebP 有损,量化会挪动一两个灰阶。
        const lo = band[0] * 255 - TOL;
        const hi = band[1] * 255 + TOL;
        const ok = m.lo >= lo && m.hi <= hi;
        console.log(
          `    ${' '.repeat(22)}声明 ${band[0]}–${band[1]} → ${Math.round(lo)}–${Math.round(hi)}` +
            `(含 ${TOL} 灰阶容差)  ${ok ? '✅ 落在区间内' : '❌ 超出区间'}`,
        );
        if (!ok) {
          problems.push(
            `${m.name} 量出的粗糙度范围 ${m.lo}–${m.hi} **超出** config 声明的 ` +
              `${band[0]}–${band[1]}(即 ${Math.round(lo)}–${Math.round(hi)},已含 ${TOL} 灰阶容差)。` +
              `生成器画出来的数与声明对不上 —— 要么改生成器,要么改声明,不许两边各说各话。`,
          );
        }
      }
    }
    if (flat) {
      notes.push(
        `四块里共有 ${flat} 张起伏极小(标准差 < 2)的图。**这本身不是错** —— ` +
          `布料的粗糙度图设计上就是窄带(config 里 cloth 的 ROUGH 区间只有 0.80–0.95)。` +
          `但若某张本该有纹理的图落进这里,要去查生成器,而不是改判据。`,
      );
    }

    // —— 2b:three.js 装到材质上的贴图 ——
    const scene = await page.evaluate(sceneTextureScript);
    console.log();
    if (scene.error) {
      problems.push(`场景贴图清点失败:${scene.error}`);
    } else {
      console.log(
        `three.js 材质贴图:网格 ${scene.meshes}  材质 ${scene.mats}  去重贴图 ${scene.textures}` +
          `  (sRGB ${scene.srgbCount} / 非彩色 ${scene.nonColorCount})`,
      );
      if (!scene.textures) {
        problems.push('场景里一张贴图都没有 —— 材质全是平色,模型会看起来"没做完"。');
      }
      if (scene.noDims.length) {
        problems.push(
          `有 ${scene.noDims.length} 张贴图**没有尺寸**(image 为空或宽高为 0):` +
            `${scene.noDims.slice(0, 6).join('、')} —— 这些就是没解码成功的那些。`,
        );
      }
      for (const r of scene.sample) {
        console.log(
          `    ${r.chunk.padEnd(18)}${r.slot.padEnd(13)}${`${r.w}×${r.h}`.padStart(11)}  ${r.colorSpace}`,
        );
      }
      if (scene.nonColorCount && scene.srgbCount) {
        notes.push(
          `色彩空间已分流:${scene.srgbCount} 张 sRGB(基色)+ ${scene.nonColorCount} 张 non-color` +
            `(法线/粗糙)。若两者都归成 sRGB,画面会发白发灰。`,
        );
      }
    }

    await page.screenshot('screenshots/web/texture_decode.png');
    console.log();
    console.log('截图      : screenshots/web/texture_decode.png');

    if (consoleErrors.length) problems.push(...consoleErrors);
  } finally {
    await close();
  }
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

const bands = args.config ? loadRoughBands(args.config) : null;
if (bands) {
  console.log(
    `已读入 config 声明:${Object.keys(bands).length} 类材质的粗糙度区间(来源 ${args.config})`,
  );
}

const summary = await containerPass();

if (args.url) {
  await browserPass(summary, bands);
} else {
  console.log();
  console.log('（未给 --url,只跑了容器面。贴图能否解码**还没验**,'
    + '别把这一步的绿灯当成全部。）');
}

console.log();
if (notes.length) {
  console.log('备注:');
  for (const n of notes) console.log(`  · ${n}`);
  console.log();
}

if (problems.length) {
  console.error(`❌ 未通过,${problems.length} 处问题:`);
  for (const p of problems) console.error(`   · ${p}`);
  process.exit(1);
}
console.log(
  args.url
    ? '✅ 两面全绿:GLB 内是内嵌 WebP,浏览器也真的解得开、且不是纯色。'
    : '✅ 容器面通过(浏览器面未跑)。',
);
