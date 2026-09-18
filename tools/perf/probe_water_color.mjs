#!/usr/bin/env node
/**
 * 河面颜色探针 —— 现在的职责是**阶段 4 的反射 A/B**。
 *
 * 用法:
 *   node tools/perf/probe_water_color.mjs            # 默认跑 reflect=1 与 reflect=0 两组
 *   node tools/perf/probe_water_color.mjs --url http://127.0.0.1:4173/
 *
 * 判据(计划风险 4,原话):河心像素色相 H 应落在 25–45°(土黄)、
 * 饱和度 S > 0.15;蓝青色的 H 在 180–240°。
 *
 * ══ 判据本身要按掠射角分桶,不能只报一个数 ═══════════════════════════
 *
 * 这一点是**实测出来的**,不是理论洁癖。同一片水,近处是俯视角、
 * 远处是掠射角,菲涅耳反射率 F = F0 + (1−F0)(1−cosθ)^5 在两者之间
 * 差了将近一个数量级:俯视时 F→0.02(看见基色),掠射时 F→1(看见天空)。
 * 拿同一个 H∈25–45° 去量这两处,结论可以完全相反,
 * 而报告里只会出现一个数 —— 于是"通过"与"失败"取决于**你挑了哪块像素**。
 * 所以下面一律按 near / mid / far 三段分别报,**三段都要看**。
 *
 * ⚠️ S 一律按 **HSV** 的 S(d/max)读,不按 HSL。原因是本文件下方那张
 *    roughness 表是 HSV 的,换成 HSL 会让新旧两表**没法比** —— 同一块
 *    像素换把尺子量出的 S 能差近一倍(暗棕 rgb(87,69,41):HSV S=0.53,
 *    HSL S=0.36),阈值 0.15 的位置就跟着挪了。两把尺子都对,混用就是错。
 *
 * ══ 历史记录:2026-09-18 那次"河为什么发蓝"的调查(仍然有效)════════
 *
 * 起因:导出的 `河道_水面` 材质,基色因子是 (0.095, 0.059, 0.022),
 * 一段不折不扣的暗棕;qm_note 里也写着「水色取土黄,非蓝色」。可是
 * 截图里那条河是灰蓝的。**声明与画面不一致,那就得有个读数来解释。**
 *
 * 结论(实测,不是推断):**导出的材质没有错。** three 侧读回的基色是
 * `#574529` ≈ rgb(87,69,41),与 glTF 的 baseColorFactor 一致,是不折不扣
 * 的土棕。**蓝不是画上去的,是低粗糙度表面在掠射角下反射天空照上去的。**
 * 单变量对照(只改 roughness、基色一动不动):
 *
 *     roughness   近处(俯视)      中景            远处(掠射)
 *       0.16     26° S=0.17 ✅   212° S=0.15 ❌   194° S=0.09 ❌   ← 当时导出值
 *       0.35     29° S=0.19 ✅   209° S=0.09 ❌   199° S=0.07 ❌
 *        0.6     33° S=0.26 ✅    31° S=0.07 △      —  近灰无色相
 *          1     34° S=0.29 ✅    36° S=0.18 ✅    32° S=0.14 △
 *
 * 两条边界,别把结论说过头:
 *   · **单靠抬粗糙度并不能修好**:r=1.0 时远处是 32°/S=0.14,卡在门槛
 *     下面 —— 从"蓝"变成了"灰",而**灰不等于土黄**。
 *   · 近处那几桶水当时在桥影里,所以"近处=土黄"里混着"阴影里=土黄",
 *     这两件事那次**没有分开**。此处不下断言。
 *
 * 于是阶段 4 的 `RiverReflector` 走的不是"拧粗糙度"这条路,而是
 * `refl = mix(refl, refl*uScatterColor*1.35, 0.45)` —— 把反射本身
 * 按散射色压过去。**下面这个 A/B 就是验它有没有奏效。**
 *
 * ══ 仪器踩过的三个坑,都留在这儿 ═══════════════════════════════════
 *
 * 坑 1:**采样点不许靠人猜。**
 *   第一版把采样点写成四个归一化坐标(「河面大概在画面下半部中间」)。
 *   跑出来 H=300°、S=0.02 —— 色相在这种饱和度下没有意义,可画面里那条河
 *   明明泛着蓝。两边对不上,只能说明**采样点没落在水面上**。猜屏幕坐标
 *   这种做法本身就是错的:机位一动、河一改,它就悄悄指到别处去,
 *   而报告的格式看上去毫无变化。
 *
 * 坑 2:**「只留水面渲一帧」也推不出水面在屏幕上的位置。**
 *   第二版改成隐掉其余物体、单渲水面。实测「水面占画面 92.6%」——
 *   虹桥下的河道**本身就有 600m 长**,没有建筑遮挡时它一路铺到地平线。
 *   **隔离渲染回答的是「这个物体有多大」,不是「哪些像素看得见它」**。
 *   现在改用**差分**:正常渲一帧 → 隐掉水面再渲一帧,两帧之差就是
 *   「真正看得见的水面」。遮挡关系由渲染器自己算,不用谁来猜。
 *
 * 坑 3(阶段 4 新增):**水面换了实现,探针得跟着换。**
 *   差分原本隐的是 `qm_kind==='water'` 的原始网格。阶段 4 之后那个网格
 *   被 `RiverReflector` 接管并**置为不可见**,于是它隐不隐都一样,
 *   差分差不出任何像素 —— `waterPct` 会掉到 0,报"挑不出采样点"。
 *   这不是水没了,是**探针量的是上一版的水**。现在改成隐**当前可见的**
 *   那一份表示(原始网格 / 反射体 / 替代面,谁可见隐谁)。
 *
 * 另外:每次读数都**先做空对照**(什么都不改、连渲两帧)把噪声底量出来。
 * 场景里有风、水波、云在动,只要有一处在动,差分就会把动画算成"水面"。
 * 空对照不接近 0 时,下面所有数字都不作数。
 *
 * ⚠️ 这个探针**只测不改**:隐显物体只为读数,读完原样还原、不落盘、不进产物。
 */
import { launch, sleep } from './lib/cdp.mjs';

const args = { url: 'http://127.0.0.1:4173/' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url') args.url = argv[++i];
}

// 两组共用的机位:取 spots.json 里 boat 景点的 view/target(虹桥上游、
// 面向漕船顺流看)。
// ⚠️ 两组**必须同一个机位**,否则 near/mid/far 三桶装的根本不是同一片水,
//    两组读数相减得到的差里混着"机位也变了"。所以写死在这儿,不给外部覆盖。
const CAM = '2.087,2.888,21.45';
const LOOK = '1.6,0.218,9.52';

/** 在页面里做的全部事情。返回值即读数。
 *  ⚠️ 整个函数体是一段模板字符串,**注释里不能出现反引号** —— 会把字符串截断。 */
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

  // ── 1. 认出**当前可见的**水面表示 ───────────────────────────────
  // 阶段 4 之后水有三种身份:原始网格(已被接管、不可见)、反射体、
  // 关反射时的替代面。谁可见就隐谁 —— 隐一个本来就不可见的东西,
  // 差分恒为 0,而报告看上去毫无异常(这就是坑 3)。
  const worldVisible = (o) => {
    let p = o;
    while (p) { if (!p.visible) return false; p = p.parent; }
    return true;
  };
  const all = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const u = o.userData || {};
    const kind = u.qm_kind === 'water' ? '原始水面网格'
      : o.name === 'RiverReflector' ? '反射体'
      : o.name === 'RiverFlatFallback' ? '替代面' : null;
    if (kind) all.push({ o, kind, visible: worldVisible(o) });
  });
  const waters = all.filter((r) => r.visible).map((r) => r.o);
  if (!waters.length) {
    return { error: '找不到**可见的**水面网格。场景里的水面候选:' +
      all.map((r) => r.kind + (r.visible ? '(可见)' : '(不可见)')).join('、') };
  }

  // ── 2. 空对照:什么都不改,连渲两帧,画面自己会不会动? ──────────
  renderer.render(scene, camera);
  const nullA = readAll();
  renderer.render(scene, camera);
  const nullB = readAll();
  let nullDiff = 0;
  for (let i = 0; i < W * H; i++) {
    const j = i * 4;
    if (Math.abs(nullA[j] - nullB[j]) > 6 ||
        Math.abs(nullA[j+1] - nullB[j+1]) > 6 ||
        Math.abs(nullA[j+2] - nullB[j+2]) > 6) nullDiff++;
  }
  const nullPct = Math.round((nullDiff / (W * H)) * 1000) / 10;

  // ── 3. 差分求"真正看得见的水面" ────────────────────────────────
  for (const w of waters) w.visible = false;
  renderer.render(scene, camera);
  const noWater = readAll();
  for (const w of waters) w.visible = true;

  const isWater = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (Math.abs(nullA[i]   - noWater[i])   > 6 ||
        Math.abs(nullA[i+1] - noWater[i+1]) > 6 ||
        Math.abs(nullA[i+2] - noWater[i+2]) > 6) isWater[y * W + x] = 1;
  }
  let waterPx = 0;
  for (let i = 0; i < isWater.length; i++) waterPx += isWater[i];

  // 掩码的**形状**也要能看见 —— 只报一个百分比,分不出"一条河"和
  // "满屏噪点"这两种完全不同、却都写 13% 的情形。
  const MX = 64, MY = 24, maskArt = [];
  for (let my = 0; my < MY; my++) {
    let line = '';
    for (let mx = 0; mx < MX; mx++) {
      let hit = 0, tot = 0;
      const x0 = Math.floor(mx * W / MX), x1 = Math.floor((mx + 1) * W / MX);
      const y0 = Math.floor(my * H / MY), y1 = Math.floor((my + 1) * H / MY);
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { tot++; hit += isWater[y * W + x]; }
      const f = tot ? hit / tot : 0;
      line += f > 0.5 ? '#' : f > 0.15 ? '+' : f > 0 ? '.' : ' ';
    }
    maskArt.push(line);
  }

  // ── 4. 挑采样点 —— **按远近分桶各挑几个** ──────────────────────
  // 内部 = 四周 6px 都是水,避开驳岸/船体的边缘混色。
  // ⚠️ 挑法返过一次工:上一版自下而上扫、凑够 12 个就停,结果 12 个点
  //    全挤在画面最底下四分之一里。**一个专门为分辨远近而做的探针,
  //    采样点却全在最近处** —— 挑点的方式把它要回答的问题排除掉了。
  const M = 6;
  const bands = [
    { key: 'near', y0: M, y1: Math.floor(H * 0.34) },
    { key: 'mid', y0: Math.floor(H * 0.34), y1: Math.floor(H * 0.62) },
    { key: 'far', y0: Math.floor(H * 0.62), y1: H - M },
  ];
  const isInterior = (x, y) =>
    isWater[y * W + x] &&
    isWater[(y-M)*W + x] && isWater[(y+M)*W + x] &&
    isWater[y*W + (x-M)] && isWater[y*W + (x+M)];

  const spots = [];
  const bandPicked = {};
  for (const { key, y0, y1 } of bands) {
    const cand = [];
    for (let y = y0; y < y1; y += 3) for (let x = M; x < W - M; x += 3) {
      if (isInterior(x, y)) cand.push([x, y]);
    }
    const want = Math.min(5, cand.length);
    const picked = [];
    for (let i = 0; i < want; i++) picked.push(cand[Math.floor((i + 0.5) * cand.length / want)]);
    bandPicked[key] = { available: cand.length, picked: picked.length };
    spots.push(...picked);
  }

  function hsv([r, g, b]) {
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
  }
  const sampleSpots = (buf, ptList) => (ptList || spots).map(([x, y]) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const i = ((y + dy) * W + (x + dx)) * 4;
      r += buf[i]; g += buf[i+1]; b += buf[i+2]; n++;
    }
    return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
  });

  // readPixels 的原点在**左下**:y 越大越靠画面上方 = 越远。
  const bucketOf = (y) => (y < H * 0.34 ? 'near' : y < H * 0.62 ? 'mid' : 'far');
  const byBucket = { near: [], mid: [], far: [] };
  for (const [x, y] of spots) byBucket[bucketOf(y)].push([x, y]);

  const circMeanH = (hs) => {
    // 色相要按**向量**平均,不能算术平均 —— 359° 与 1° 的算术平均是
    // 180°(青),正好指到对面去。低饱和点先剔除,它们没有色相可言。
    const vivid = hs.filter((c) => c.s > 0.05);
    if (!vivid.length) return { h: null, n: 0 };
    let sx = 0, sy = 0;
    for (const c of vivid) { const a = c.h * Math.PI / 180; sx += Math.cos(a); sy += Math.sin(a); }
    return { h: Math.round(((Math.atan2(sy, sx) * 180 / Math.PI) + 360) % 360), n: vivid.length };
  };

  renderer.render(scene, camera);
  const buf = readAll();
  const stat = (ptList) => {
    const hs = sampleSpots(buf, ptList).map(hsv);
    if (!hs.length) return { h: null, s: null, v: null, n: 0, total: 0 };
    const { h, n } = circMeanH(hs);
    return {
      h, n, total: hs.length,
      s: Math.round((hs.reduce((a, c) => a + c.s, 0) / hs.length) * 100) / 100,
      v: Math.round((hs.reduce((a, c) => a + c.v, 0) / hs.length) * 100) / 100,
    };
  };

  // 反射器的运行时读数:URL 说要开,它就**真的**在跑吗?
  // 只读 URL 是不够的 —— 那正是阶段 4 踩过的坑(参数解析了没人消费)。
  const rr = qm.riverRuntime ? qm.riverRuntime() : { mounted: false };

  return {
    found: all.map((r) => r.kind + (r.visible ? '(可见)' : '(隐)')),
    reflecting: waters.map((w) => w.name),
    canvas: [W, H],
    url: location.search || '(无参数)',
    river: rr,
    nullPct,
    waterPct: Math.round((waterPx / (W * H)) * 1000) / 10,
    maskArt, spots, bandPicked,
    near: stat(byBucket.near),
    mid: stat(byBucket.mid),
    far: stat(byBucket.far),
  };
})()`;

// --------------------------------------------------------------------------
// 逐组测量
// --------------------------------------------------------------------------

const GROUPS = [
  { key: 'reflect1', reflect: '1', label: '反射 开 (?reflect=1)' },
  { key: 'reflect0', reflect: '0', label: '反射 关 (?reflect=0)' },
];

const results = [];
const { page, close } = await launch({ width: 1600, height: 900 });

try {
  for (const g of GROUPS) {
    const u = new URL(args.url);
    u.searchParams.set('cam', CAM);
    u.searchParams.set('look', LOOK);
    u.searchParams.set('reflect', g.reflect);
    u.searchParams.set('hud', '0');
    u.searchParams.set('tags', '0');

    await page.goto(u.toString());
    await page.waitForReady({ timeout: 120000 });
    await sleep(2500);

    const res = await page.evaluate(script);
    res.group = g;
    results.push(res);

    // 采样点画到截图上 —— "采样点长什么样"必须看得见。
    if (res.spots && res.spots.length) {
      // ⚠️ cdp 的 evaluate 只收一个函数、**不转发参数**(内部是 (fn.toString())()),
      //    所以这里把坐标拼进字符串,不能写成第二个实参。
      await page.evaluate(`(() => {
        // 采样点是 readPixels 坐标(原点左下),画到页面上要换成 CSS 坐标
        // (原点左上):y 取反,并按画布与 CSS 尺寸之比缩放。
        const raw = ${JSON.stringify(res.spots)};
        const bw = ${res.canvas[0]}, bh = ${res.canvas[1]};
        const spots = raw.map(([x, y]) => [x * innerWidth / bw, (bh - y) * innerHeight / bh]);
        const c = document.createElement('canvas');
        c.width = innerWidth; c.height = innerHeight;
        Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: '99999',
          pointerEvents: 'none' });
        const g = c.getContext('2d');
        g.lineWidth = 2;
        for (const [x, y] of spots) {
          g.strokeStyle = '#ff2d55';
          g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.stroke();
          g.beginPath(); g.moveTo(x - 16, y); g.lineTo(x + 16, y);
          g.moveTo(x, y - 16); g.lineTo(x, y + 16); g.stroke();
        }
        document.body.appendChild(c);
        return spots.length;
      })()`);
    }
    await page.screenshot(`screenshots/perf/ab_water_${g.key}.png`);
  }
} finally {
  await close();
}

// --------------------------------------------------------------------------
// 报告
// --------------------------------------------------------------------------

const B = '─'.repeat(78);
const verdictOf = (c) => {
  if (c.h === null || !c.n) return '△ 近灰无色相';
  if (c.h >= 25 && c.h <= 45 && c.s > 0.15) return '✅ 土黄';
  if (c.h > 150 && c.h < 260) return '❌ 发蓝';
  return `△ 偏色 H=${c.h}°`;
};

const problems = [];

console.log(B);
console.log('河面颜色 A/B —— 只改 reflect,其余(机位/时辰/画质/分辨率)完全一致');
console.log(`机位 ${CAM}  看向 ${LOOK}`);
console.log(B);

for (const r of results) {
  console.log(`${r.group.label}     URL: ${r.url}`);
  if (r.error) {
    console.log(`  ❌ ${r.error}`);
    problems.push(`${r.group.key}: ${r.error}`);
    console.log();
    continue;
  }
  console.log(`  水面表示  : ${r.found.join('、')}`);
  console.log(`  反射器状态: ${r.river.mounted
    ? (r.river.enabled ? '开' : '关') + `  RT ${r.river.rtSize.join('×')}` +
      `  每 ${r.river.everyNFrames} 帧  已渲染 ${r.river.reflectionPasses} 次` +
      `  跳过 ${r.river.skippedPasses} 次`
    : '未挂载'}`);
  console.log(`  空对照    : ${r.nullPct}% 的像素自己就变了(噪声底,越接近 0 越好)`);
  console.log(`  可见水面  : 占画面 ${r.waterPct}%`);
  console.log(`  采样点    : near ${r.bandPicked.near.picked}/${r.bandPicked.near.available}` +
    `  mid ${r.bandPicked.mid.picked}/${r.bandPicked.mid.available}` +
    `  far ${r.bandPicked.far.picked}/${r.bandPicked.far.available}`);
  console.log();
  console.log('  掩码形状(# 满  + 半  . 零星,64×24;第一行是画面**底部**):');
  const rowsN = r.maskArt.length;
  r.maskArt.forEach((line, i) => {
    const tag = i === 0 ? '底' : i === rowsN - 1 ? '顶' : '  ';
    console.log(`   ${tag}|${line}|`);
  });
  console.log();
}

console.log(B);
console.log('按掠射角分桶的色相/饱和度 —— 三段都要看');
console.log('判据(计划风险 4):H∈25–45°(土黄) 且 S>0.15(HSV 的 S)');
console.log('  near / mid 按上述**完整判据**硬校验;');
console.log('  far 掠射角按设计**允许偏色**,只拦"偏成青蓝"(H∈150–260)。');
console.log('  两条口径不同,所以下方的结论行分开说,不合并成一句。');
console.log(B);
console.log(`${'组'.padEnd(22)}│${'near 俯视'.padStart(24)}│${'mid'.padStart(24)}│${'far 掠射'.padStart(24)}`);
const sig = (r, k) => {
  const c = r[k];
  if (r.error) return '—';
  return c.h === null ? '— / — / —' : `${c.h}° / ${c.s} / ${c.v}`;
};
for (const r of results) {
  const cell = (k) => (sig(r, k) + '  ' + (r.error ? '' : verdictOf(r[k]))).padStart(23);
  console.log(`${r.group.label.padEnd(22)}│ ${cell('near')}│ ${cell('mid')}│ ${cell('far')}`);
}
console.log();

// ── 仪器自检 ────────────────────────────────────────────────────────
// 两组读数若逐字相同,说明 reflect 这一位根本没接上画面 ——
// 那么下面所有"通过"都是假的。这类自检比结论本身更重要。
const ok = results.filter((r) => !r.error);
if (ok.length === 2) {
  const same = ['near', 'mid', 'far'].every(
    (k) => JSON.stringify(ok[0][k]) === JSON.stringify(ok[1][k]),
  );
  if (same) {
    problems.push(
      '仪器自检未通过:reflect=1 与 reflect=0 两次读数逐字相同 —— ' +
        '这一位没接到画面上,下面的结论一律不可信',
    );
  } else {
    console.log('仪器自检:两组读数不同,reflect 确实作用到了画面上。');
  }
  // 空对照:噪声底太高时差分法不成立
  for (const r of ok) {
    if (r.nullPct > 1.0) {
      problems.push(
        `${r.group.key}: 空对照噪声底 ${r.nullPct}% 偏高 —— ` +
          '场景在两次渲染之间自己在动,差分求出的"水面"混着动画像素',
      );
    }
  }
  // URL 声明与实际状态必须一致(与 shot.mjs 同一道防线,不共用则各自成立)
  for (const r of ok) {
    const want = r.group.reflect === '1';
    if (r.river.mounted && r.river.enabled !== want) {
      problems.push(
        `${r.group.key}: URL 要求 reflect=${r.group.reflect},实际 enabled=${r.river.enabled}`,
      );
    }
  }
}
if (ok.length < 2) problems.push(`只有 ${ok.length}/2 组测到数据,无法做 A/B`);

// ── 判据 ────────────────────────────────────────────────────────────
// 三段分别判,**近处与中景是硬要求**(那是观众实际盯着看的河面),
// 远处掠射角允许偏色 —— 但偏到青蓝就是"海水"了,一样要拦。
//
// ⚠️ 2026-09-18 修:上面那两行注释、上方打印的判据行、以及收尾的结论行,
//    说的都是"完整判据 + 中景属硬要求";而此前**只有代码不这么说** ——
//    near 用完整判据,mid 与 far 却一起退化成只查"是不是蓝的"。
//    于是 mid 里一块 S=0.05 的灰水,注释说它该拦,代码放它过去。
//    这是"声明与实现在同一件事上不一致"的又一例,所以把 mid 提为严格判据。
//
//    far 维持"允许偏色、不许发蓝":这是**设计上的让步,不是漏检**。
//    但结论行必须如实说 far 只是"没发蓝",不能说它"土黄" ——
//    没达到阈值的东西,不许被一句好听的话盖过去。
const isEarthen = (c) => c.h >= 25 && c.h <= 45 && c.s > 0.15;
const isBlue = (c) => c.h > 150 && c.h < 260;

for (const r of ok) {
  if (r.near.h !== null && !isEarthen(r.near)) {
    problems.push(
      `${r.group.label} 近处水面颜色不合格:${verdictOf(r.near)}` +
        `(H=${r.near.h} S=${r.near.s};判据 H∈25–45° 且 S>0.15)`,
    );
  }
  if (r.mid.h !== null && !isEarthen(r.mid)) {
    problems.push(
      `${r.group.label} 中景水面颜色不合格(中景是硬要求):${verdictOf(r.mid)}` +
        `(H=${r.mid.h} S=${r.mid.s};判据 H∈25–45° 且 S>0.15)`,
    );
  }
  if (r.far.h !== null && isBlue(r.far)) {
    problems.push(`${r.group.label} 远处掠射水面发蓝:${verdictOf(r.far)}(H=${r.far.h} S=${r.far.s})`);
  }
}

console.log(B);
console.log('截图(采样点已标红): screenshots/perf/ab_water_reflect1.png / ab_water_reflect0.png');
console.log('⚠️ 采样点画在图上是为了**能被核对** —— 它们是不是真的落在水面上,');
console.log('   要在截图里逐个数过去。探针自己说不了这句话。');
console.log(B);

// far 段没达到土黄判据的,逐组点名。
// 它**不影响通过与否**(设计上允许偏色),但必须印出来 ——
// 否则收尾那句"通过"会被读成"三段都达到了土黄",而事实不是。
const farBelow = ok.filter((r) => r.far.h !== null && !isEarthen(r.far));

if (problems.length) {
  console.error('\n❌ 未通过:');
  for (const p of problems) console.error(`   · ${p}`);
  process.exit(1);
}

if (farBelow.length) {
  console.log();
  console.log(`   ⚠️ far 掠射段未达 S>0.15 的有 ${farBelow.length}/${ok.length} 组:`);
  for (const r of farBelow) {
    console.log(`      · ${r.group.label}  H=${r.far.h}° S=${r.far.s}`);
  }
  console.log('      按设计 far 允许偏色,所以这**不算失败**;');
  console.log('      但它也**不是**土黄判据下的合格 —— 别把"没拦"读成"达标"。');
}

console.log();
console.log('✅ 通过:reflect A/B 有差异、噪声底合格;');
console.log('   near / mid 达到土黄判据(H∈25–45° 且 S>0.15);');
console.log(
  farBelow.length
    ? `   far 未发蓝(允许偏色),但有 ${farBelow.length} 组未达 S>0.15 —— 见上方点名。`
    : '   far 未发蓝,且亦达到土黄判据。',
);
process.exit(0);
