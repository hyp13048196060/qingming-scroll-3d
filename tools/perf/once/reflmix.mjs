// 一次性探针:近处河面为什么会**发蓝** —— 对 uReflMix 做一次剂量-反应。
//
// 起因(实测,不是推断):`probe_water_color.mjs` 的 A/B 给出
//     reflect=1  近处(near)  H=216° S=0.13   ← 蓝
//     reflect=0  近处(near)  H= 39° S=0.12   ← 土黄
// 单变量对照说是反射干的。可这句话**推不下去**:近处是俯视角,
// 相机高出水面 2.9 m、看下去约 37°,F = 0.02 + 0.98·(1−cos37°)^5 ≈ 0.021
// —— 只有 2% 的反射,怎么会把一段土棕染成天蓝?
//
// 波纹也不是嫌疑人:三组行波的 Σ(a·k) ≈ 0.092,法线最多偏 5°,菲涅耳
// 顶多从 0.020 抬到 0.025。**数量级不够。**
//
// 于是真正的怀疑落在**单位**上:反射 RT 是 HalfFloat、存的是**线性且未
// 做色调映射**的辐射值,可以远大于 1;而 `uDeep = #2a1f14` 当作线性值
// 只有 0.021。两者混在一个 mix 里,2% × (亮天空) 完全可能盖过 98% × 0.021。
// **"2% 反射"这句话只有在两边同量纲时才成立。**
//
// 这个探针不改任何源码,只在页面里拨 `uReflMix`(= mix 的权重乘子,
// 见片元 `col = mix(body, refl, fres * uReflMix)`)从 0 到 1 走一遍,
// 看近处色相在哪一档从土黄翻到蓝:
//   · 若 uReflMix=1 才蓝、小值就正常 → 反射强度本身过大,给个衰减即可;
//   · 若 uReflMix 很小就已经蓝    → 反射的**量纲**不对,衰减治标不治本,
//     得先把 RT 的辐射值压回可与基色相比的范围。
// 两者的修法完全不同,所以必须先把这个分清楚。
//
// 同时**读回**每个 uniform 的值 —— 仪器没接上时,扫出来的是一条平线,
// 那不是"水对反射不敏感",是探针没接上。上一版 roughness 对照就栽在这。
//
// ⚠️ 只测不改:拨完还原,不落盘、不进产物。
import { launch, sleep } from '../lib/cdp.mjs';

const args = { url: 'http://127.0.0.1:4173/' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url') args.url = argv[++i];
}

// 与 probe_water_color.mjs 完全相同的机位,两组读数才能对上
const CAM = '2.087,2.888,21.45';
const LOOK = '1.6,0.218,9.52';

/** 旋钮 A 的取值:权重乘子。0 = 只剩水体,1 = 菲涅耳原样。 */
const MIXES = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0];
/** 旋钮 B 的取值:软压缩系数。0 = 不压缩(出问题时的状态),越大压得越狠。 */
const COMPRESS = [0, 0.25, 0.5, 1.0, 2.0, 4.0];

// ⚠️ 注释里不能出现反引号 —— 会把模板字符串截断(这个坑踩过两次)。
const script = `(async () => {
  const qm = window.__QM__;
  const scene = qm.scene, renderer = qm.renderer, camera = qm.camera;
  const gl = renderer.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const readAll = () => {
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  };

  // 反射体:reflect=1 时它就是水面的可见表示
  let reflMesh = null;
  scene.traverse((o) => { if (o.isMesh && o.name === 'RiverReflector') reflMesh = o; });
  if (!reflMesh) return { error: '场景里找不到 RiverReflector —— 请用 ?reflect=1 打开' };
  const mat = Array.isArray(reflMesh.material) ? reflMesh.material[0] : reflMesh.material;
  const u = mat.uniforms;
  if (!u || !u.uReflMix) return { error: '反射体材质上没有 uReflMix —— 拿到的不是我们的着色器' };

  const rr = qm.riverRuntime ? qm.riverRuntime() : { mounted: false };

  // ── 差分求"看得见的水面" ─────────────────────────────────────────
  // 与主探针同一套方法:正常渲一帧 → 隐掉水面再渲一帧,两帧之差即水面。
  renderer.render(scene, camera);
  const onA = readAll();
  reflMesh.visible = false;
  renderer.render(scene, camera);
  const off = readAll();
  reflMesh.visible = true;

  const isWater = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (Math.abs(onA[i] - off[i]) > 6 || Math.abs(onA[i+1] - off[i+1]) > 6 ||
        Math.abs(onA[i+2] - off[i+2]) > 6) isWater[y * W + x] = 1;
  }

  // ── 按远近分三桶挑采样点 ────────────────────────────────────────
  // ⚠️ readPixels 原点在**左下**:y 小 = 画面下方 = 离相机近。
  const M = 6;
  const bands = [
    { key: 'near', y0: M, y1: Math.floor(H * 0.34) },
    { key: 'mid', y0: Math.floor(H * 0.34), y1: Math.floor(H * 0.62) },
    { key: 'far', y0: Math.floor(H * 0.62), y1: H - M },
  ];
  const isInterior = (x, y) =>
    isWater[y * W + x] && isWater[(y-M)*W + x] && isWater[(y+M)*W + x] &&
    isWater[y*W + (x-M)] && isWater[y*W + (x+M)];

  const byBucket = { near: [], mid: [], far: [] };
  for (const { key, y0, y1 } of bands) {
    const cand = [];
    for (let y = y0; y < y1; y += 3) for (let x = M; x < W - M; x += 3) {
      if (isInterior(x, y)) cand.push([x, y]);
    }
    const want = Math.min(5, cand.length);
    for (let i = 0; i < want; i++) byBucket[key].push(cand[Math.floor((i + 0.5) * cand.length / want)]);
  }
  if (!byBucket.near.length) return { error: '近处挑不出水面内部采样点' };

  const hsv = ([r, g, b]) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return { h: Math.round(h), s: Math.round((mx === 0 ? 0 : d / mx) * 100) / 100,
             v: Math.round(mx * 100) / 100 };
  };
  const circMeanH = (hs) => {
    const vivid = hs.filter((c) => c.s > 0.05);
    if (!vivid.length) return { h: null, n: 0 };
    let sx = 0, sy = 0;
    for (const c of vivid) { const a = c.h * Math.PI / 180; sx += Math.cos(a); sy += Math.sin(a); }
    return { h: Math.round(((Math.atan2(sy, sx) * 180 / Math.PI) + 360) % 360), n: vivid.length };
  };

  const stat = (buf, pts) => {
    const px = pts.map(([x, y]) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const i = ((y + dy) * W + (x + dx)) * 4;
        r += buf[i]; g += buf[i+1]; b += buf[i+2]; n++;
      }
      return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
    });
    const hs = px.map(hsv);
    const { h, n } = circMeanH(hs);
    const mean = px.reduce((a, c) => [a[0]+c[0], a[1]+c[1], a[2]+c[2]], [0,0,0]).map((v) => Math.round(v / px.length));
    return { h, n, s: Math.round((hs.reduce((a, c) => a + c.s, 0) / hs.length) * 100) / 100,
             v: Math.round((hs.reduce((a, c) => a + c.v, 0) / hs.length) * 100) / 100, mean };
  };

  // ── 均匀取色,仅供参照:太阳方向与雾 ──────────────────────────────
  const colorHex = (c) => (c && c.getHexString) ? '#' + c.getHexString() : null;
  const uniformReport = {
    uDeep: colorHex(u.uDeep.value), uShallow: colorHex(u.uShallow.value),
    uScatter: colorHex(u.uScatter.value),
    uDeepLinear: u.uDeep.value ? [u.uDeep.value.r, u.uDeep.value.g, u.uDeep.value.b].map((v) => +v.toFixed(4)) : null,
    uShallowLinear: u.uShallow.value ? [u.uShallow.value.r, u.uShallow.value.g, u.uShallow.value.b].map((v) => +v.toFixed(4)) : null,
    uRipple: u.uRipple.value, uHalfWidth: u.uHalfWidth.value,
    uSpecPower: u.uSpecPower.value, uSpecStrength: u.uSpecStrength.value,
    uFogDensity: u.uFogDensity.value,
    // 反射 RT 的格式 —— 怀疑"量纲"时这是头号证据
    rtFormat: (() => {
      // 反射体是 Mesh,真正的 RT 在它内部;能拿到就报,拿不到就说不清楚
      return null;
    })(),
  };

  // ── 剂量-反应:两个旋钮各扫一遍 ──────────────────────────────────
  //
  // 旋钮 A uReflMix:mix 的权重乘子。回答"反射强度本身是不是过大"。
  // 旋钮 B uReflCompress:反射的软压缩系数 r/(1+k·r)。回答
  //   "把反射压回与基色同量级之后,近处会不会回到土黄"。
  // 两个都扫,是因为它们能产生**看起来一样**的近处颜色,而修法完全不同:
  // A 只是整体调暗,治标;B 才动到量纲。只有 B 在 uReflMix 保持 1
  // 时可解,才说明近处与远处可以同时成立。
  const origMix = u.uReflMix.value;
  const origCompress = u.uReflCompress ? u.uReflCompress.value : null;
  if (origCompress === null) {
    return { error: '材质上没有 uReflCompress —— 页面跑的还是改动前的构建' };
  }

  const sweep = (setter, values, label) => {
    const out = [];
    for (const v of values) {
      setter(v);
      const back = setter(undefined);   // undefined = 只读
      if (Math.abs(back - v) > 1e-9) {
        return { error: label + ' 赋值没生效:写 ' + v + ' 读回 ' + back };
      }
      renderer.render(scene, camera);
      const buf = readAll();
      out.push({ v, near: stat(buf, byBucket.near), mid: stat(buf, byBucket.mid),
                 far: stat(buf, byBucket.far) });
    }
    return out;
  };

  // A:只动 uReflMix(压缩先置 0 = 不压缩,还原成出问题时的状态)
  u.uReflCompress.value = 0;
  const byMix = sweep(
    (v) => { if (v !== undefined) u.uReflMix.value = v; return u.uReflMix.value; },
    ${JSON.stringify(MIXES)}, 'uReflMix');

  // B:uReflMix 归位 1,只动压缩
  u.uReflMix.value = origMix;
  const byCompress = sweep(
    (v) => { if (v !== undefined) u.uReflCompress.value = v; return u.uReflCompress.value; },
    ${JSON.stringify(COMPRESS)}, 'uReflCompress');

  u.uReflMix.value = origMix;
  u.uReflCompress.value = origCompress;

  return {
    url: location.search || '(无参数)', river: rr, canvas: [W, H],
    counts: { near: byBucket.near.length, mid: byBucket.mid.length, far: byBucket.far.length },
    uniformReport, byMix, byCompress,
  };
})()`;

const { page, close } = await launch({ width: 1600, height: 900 });
try {
  const u = new URL(args.url);
  u.searchParams.set('cam', CAM);
  u.searchParams.set('look', LOOK);
  u.searchParams.set('reflect', '1');
  u.searchParams.set('hud', '0');
  u.searchParams.set('tags', '0');

  await page.goto(u.toString());
  await page.waitForReady({ timeout: 120000 });
  await sleep(2500);

  const res = await page.evaluate(script);
  if (res.error) {
    console.error('❌', res.error);
    await close();
    process.exit(1);
  }

  const B = '─'.repeat(84);
  console.log(B);
  console.log('近处河面发蓝 —— uReflMix 剂量-反应(只拨这一个值,其余全不动)');
  console.log(`URL ${res.url}`);
  console.log(`反射器 ${res.river.mounted
    ? (res.river.enabled ? '开' : '关') + '  RT ' + res.river.rtSize.join('×') +
      '  每 ' + res.river.everyNFrames + ' 帧  已渲染 ' + res.river.reflectionPasses + ' 次'
    : '未挂载'}`);
  console.log(`画布 ${res.canvas[0]}×${res.canvas[1]}   采样点 near ${res.counts.near} mid ${res.counts.mid} far ${res.counts.far}`);
  console.log(B);
  const ur = res.uniformReport;
  console.log('读数前先看仪器接上没有 —— 这些是**从材质上读回来**的值:');
  console.log(`  uDeep ${ur.uDeep} 线性 ${JSON.stringify(ur.uDeepLinear)}`);
  console.log(`  uShallow ${ur.uShallow} 线性 ${JSON.stringify(ur.uShallowLinear)}`);
  console.log(`  uScatter ${ur.uScatter}   uRipple ${ur.uRipple}   uHalfWidth ${ur.uHalfWidth}`);
  console.log(`  uSpecPower ${ur.uSpecPower}   uSpecStrength ${ur.uSpecStrength}   uFogDensity ${ur.uFogDensity}`);
  console.log();
  console.log('⚠️ 看这两个数就够说明问题:uDeep 的**线性**值只有零点零几,');
  console.log('   而反射 RT 存的是半浮点线性辐射值,天空那一片可以是它的几十倍。');
  console.log('   两者混在同一个 mix 里,权重小**不等于**贡献小。');
  const isEarth = (c) => c.h !== null && c.h >= 25 && c.h <= 45;
  const isBlue = (c) => c.h !== null && c.h > 150 && c.h < 260;

  const table = (label, rows, key) => {
    console.log(B);
    console.log(`${label}`);
    console.log(B);
    console.log(`${key.padStart(9)} │${'near 俯视 H/S/V  rgb'.padStart(34)}│${'mid'.padStart(26)}│${'far 掠射'.padStart(22)}`);
    for (const r of rows) {
      const cell = (c, w) => (c.h === null ? '—(近灰无色相)' : c.h + '° S' + c.s + ' V' + c.v + '  rgb(' + c.mean.join(',') + ')').padStart(w);
      console.log(`${String(r.v).padStart(9)} │${cell(r.near, 34)}│${cell(r.mid, 26)}│${cell(r.far, 22)}`);
    }
    console.log();
    const earth = rows.filter((r) => isEarth(r.near));
    const blue = rows.filter((r) => isBlue(r.near));
    console.log(`  近处为土黄系(H∈25–45°)的${key}:${earth.length ? earth.map((r) => r.v).join(', ') : '无'}`);
    console.log(`  近处已翻成蓝青(H∈150–260°)的${key}:${blue.length ? blue.map((r) => r.v).join(', ') : '无'}`);
    return { earth, blue };
  };

  console.log();
  table('旋钮 A —— 只拨 uReflMix(压缩置 0,即出问题时的状态)', res.byMix, 'uReflMix');
  console.log('  读法:权重小到什么程度才不蓝,就是"反射的贡献有多大"的度量。');
  console.log('  若很小的权重就已经变色,说明问题在**量级**而不在强度。');
  const Bres = table('旋钮 B —— uReflMix 保持 1,只拨 uReflCompress', res.byCompress, 'uReflCompress');

  console.log(B);
  console.log('结论 —— 两个旋钮要分开读,它们能做出**看起来一样**的近处颜色:');
  const aSmallest = res.byMix.length ? Math.min(...res.byMix.filter((r) => isEarth(r.near)).map((r) => r.v)) : null;
  if (aSmallest !== null && aSmallest <= 0.1) {
    console.log(`  · 旋钮 A 要到 ${aSmallest} 才回到土黄 —— 那么小的权重意味着反射的`);
    console.log('    贡献被放大了两个数量级,**问题在量纲,不在强度**。整体调暗只是治标:');
    console.log('    它会把远处的倒影一起压没,而远处正是要靠倒影的地方。');
  }
  if (Bres.earth.length) {
    const best = Bres.earth.map((r) => r.v);
    console.log(`  · 旋钮 B 在 uReflCompress ∈ {${best.join(', ')}} 时近处回到土黄,`);
    console.log(`    而 uReflMix 仍是 1(反射未被整体削弱)。此时 far 段读数见上表 ——`);
    console.log('    **近处与远处能同时成立**,这才是要采用的修法。');
    console.log(`    取中间值 uReflCompress = ${best[Math.floor(best.length / 2)]} 作为默认。`);
  } else {
    console.log('  · 旋钮 B 全程不能让近处回到土黄 —— 那么单靠压缩解决不了,');
    console.log('    得回头查基色本身或采样点是否落在非水面像素上。');
  }
  console.log(B);

  // ── 逐档截图 ────────────────────────────────────────────────────
  //
  // 表里的 H/S/V 只能说明"色相对了",说明不了"像不像水"。上面这张表
  // 完全可能**靠把水调成泥浆**来满足判据 —— 实测就是这么回事。所以
  // 必须把每一档都拍下来看。数字给下限,眼睛做选择,两者缺一不可。
  const setKnob = (v) => page.evaluate(`(() => {
    const qm = window.__QM__;
    let m = null;
    qm.scene.traverse((o) => { if (o.isMesh && o.name === 'RiverReflector') m = o; });
    if (!m) return null;
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    mat.uniforms.uReflCompress.value = ${v};
    mat.uniforms.uReflMix.value = 1;
    qm.renderer.render(qm.scene, qm.camera);
    return mat.uniforms.uReflCompress.value;
  })()`);

  console.log('逐档截图(同一机位、同一画面,只差 uReflCompress):');
  for (const k of COMPRESS) {
    const back = await setKnob(k);
    if (back === null) {
      console.log('  ⚠️ 找不到反射体,跳过截图');
      break;
    }
    const out = `screenshots/perf/reflc_${String(k).replace('.', 'p')}.png`;
    await page.screenshot(out);
    console.log(`  uReflCompress=${String(k).padEnd(4)} → ${out}`);
  }
  console.log();
  console.log('看这几张图,回答表里答不了的那个问题:**像不像水**。');
  console.log('表里 H/S/V 合格、图上却是一滩泥,那种"通过"不算通过。');
  console.log(B);
} finally {
  await close();
}
