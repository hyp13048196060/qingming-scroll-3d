#!/usr/bin/env node
/**
 * 阶段 3 的界面探针 —— 用**真实鼠标事件**驱动界面,并把每一步的结果拍下来。
 *
 * 为什么不用 `element.click()`
 * ---------------------------
 * `element.click()` 会绕过命中测试直接派发事件。于是下面这两种情况它都会"通过":
 *   · 按钮被某个面板盖住了(用户根本点不到);
 *   · 按钮大小为 0(有 DOM、无画面)。
 * 这个探针改为:取元素中心 → 用 CDP 派发真实 `mousePressed/mouseReleased` →
 * **再用 `elementFromPoint` 反查那个坐标上到底是谁**,并断言它确实落在目标
 * 元素(或其后代)上。点不到就报"点不到",而不是让断言悄悄失败在别处。
 *
 * ⚠️ 注入页面求值的字符串里**不能出现反引号**:`Page.evaluate` 会把函数
 *    序列化成一段 JS,反引号会提前终止外层模板字面量。本文件里一律用
 *    单引号 + JSON.stringify 拼注入串。
 *
 * 用法:
 *   node tools/perf/probe_ui.mjs --url http://127.0.0.1:4173/
 *   node tools/perf/probe_ui.mjs --out screenshots/web --keep-open
 */
import { launch, sleep } from './lib/cdp.mjs';

function parseArgs(argv) {
  const a = { url: 'http://127.0.0.1:4173/', out: 'screenshots/web', w: 1600, h: 900, json: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--url') a.url = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--json') a.json = argv[++i];
    else if (k === '--w') a.w = Number(argv[++i]);
    else if (k === '--h') a.h = Number(argv[++i]);
    else if (k === '--help' || k === '-h') {
      console.log(
        '用法: node tools/perf/probe_ui.mjs [--url URL] [--out 目录] [--w 1600] [--h 900] [--json 结果.json]',
      );
      process.exit(0);
    }
  }
  return a;
}

const results = [];
function check(group, name, ok, detail = '') {
  results.push({ group, name, ok: Boolean(ok), detail });
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark} [${group}] ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 注入页面用的求值片段(全部单引号,无反引号)
// ---------------------------------------------------------------------------

const RECT_FN = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
})()`;

const HIT_FN = (sel, x, y) => `(() => {
  const el = document.elementFromPoint(${x}, ${y});
  if (!el) return { ok: false, why: '该坐标上没有元素' };
  return { ok: Boolean(el.closest(${JSON.stringify(sel)})),
           tag: el.tagName, cls: String(el.className).slice(0, 60) };
})()`;

const UUID_SET_FN = `(() => {
  const out = [];
  window.__QM__.scene.traverse((o) => out.push(o.uuid));
  out.sort();
  return out;
})()`;

/**
 * 场景里全部材质的 uuid 集合。
 *
 * 「切画质/切线框不能新建材质」这条不变量**只能**这样量。早先我拿
 * `report().wireframeMaterials` 在关掉线框前后做比较,那不是测量:
 * 该字段的实现是 `wireframe ? eachMaterial(...) : 0` —— 关掉时**恒为 0**,
 * 于是"前后相等"永远成立,断言与它声称要守的东西毫无关系。
 * 仪表在关掉时读 0 是设计如此,不是材质少了。要比就比材质本身。
 */
const MATERIAL_UUID_FN = `(() => {
  const out = [];
  window.__QM__.scene.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    const list = Array.isArray(m) ? m : [m];
    for (const x of list) if (x) out.push(x.uuid);
  });
  return Array.from(new Set(out)).sort();
})()`;

/**
 * 两张人物快照之间**有几项变了**(位置/朝向/相位任一项)。
 * 「真的在走」与「真的冻住了」都靠它 —— 只看总位移会在原地转身时判成没动。
 *
 * ⚠️ 逐字节比 JSON 是有前提的:两张表由**同一个** `snapshot()` 产出,
 *    字段与键序都由构造决定。换个来源的表这么比就是错的。
 */
function countMoved(a, b) {
  const len = Math.max(a.length, b.length);
  let n = 0;
  for (let i = 0; i < len; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) n++;
  }
  return n;
}

/** 两个已排序数组是否逐项相同。 */
const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

async function rect(page, sel) {
  return page.evaluate(RECT_FN(sel));
}

/**
 * 确认一个元素**用户真的点得到**:存在、尺寸非零、且它的中心点上
 * 命中的确实是它自己(或它的后代/祖先)。不通过就抛错。
 *
 * ⚠️ 命中判定用 `closest(sel)`,所以对「复选框套在 label 里」这类结构,
 *    选择器要写 `label[for=...]` 而不是 `#id` —— 点在 span 文字上时,
 *    `closest('#id')` 是 null,会误报"被挡住",而实际上浏览器会把这次
 *    点击转给 input(这正是 label 的作用)。仪表选错,结论就整条反了。
 */
async function reachable(page, sel, desc) {
  const r = await rect(page, sel);
  if (!r) throw new Error(`点不到「${desc}」:页面上没有 ${sel}`);
  if (r.w < 1 || r.h < 1) {
    throw new Error(`点不到「${desc}」:${sel} 尺寸为 ${r.w}×${r.h},实际不可点`);
  }
  const hit = await page.evaluate(HIT_FN(sel, r.x, r.y));
  if (!hit.ok) {
    throw new Error(
      `点不到「${desc}」:(${r.x.toFixed(0)},${r.y.toFixed(0)}) 上的是 ` +
        `${hit.tag}.${hit.cls} —— 目标被挡住了`,
    );
  }
  return r;
}

/** 确认可达后派发一对真实鼠标事件。 */
async function click(page, sel, desc) {
  const r = await reachable(page, sel, desc);
  await page.mouse('mousePressed', r.x, r.y);
  await page.mouse('mouseReleased', r.x, r.y);
  return r;
}

/** 等补间结束(mode 回到 orbit),超时抛错。 */
async function waitSettled(page, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const m = await page.evaluate('window.__QM__.cameraSnapshot().mode');
    if (m === 'orbit') return true;
    await sleep(80);
  }
  return false;
}

const snap = (page) => page.evaluate('window.__QM__.uiSnapshot()');

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { page, close, browserVersion } = await launch({
    width: args.w,
    height: args.h,
  });
  const errors = page.collectErrors();

  try {
    await page.setViewport({ width: args.w, height: args.h });
    await page.goto(args.url);
    await page.waitForReady();

    const gpu = await page.evaluate('window.__QM__.gpu.renderer');
    console.log(`\n浏览器 ${browserVersion}\n渲染器 ${gpu}\n视口   ${args.w}×${args.h}\n`);

    // 等两帧,让标签完成一次投影(它挂在每帧的 ui.update 里)
    await sleep(600);

    // ================= ③ 标签 / 简介 / 走近看看 =================
    let s = await snap(page);
    check('③', '三维标签已生成', s.labelCount === 5, `${s.labelCount} 个`);
    check('③', '顶栏景点按钮', s.spotButtonCount === 5, `${s.spotButtonCount} 个`);

    // ⚠️ 只查 `!hidden` 是不够的:`.qm-label` 的 `hidden` **默认就是 false**,
    //    若 `Labels.update()` 一次都没跑过,五个标签全都"可见" ——
    //    而它们实际叠在 (0,0) 上。所以必须连带查每帧写进去的 transform:
    //    · 没有 transform 属性 → update() 没跑;
    //    · transform 解析出的坐标不在视口内 → 投影算错了。
    //    这两条都是"看着可见、其实没画对"的情形,只有解析坐标才抓得到。
    const labelVisible = await page.evaluate(`(() => {
      const root = document.querySelector('.qm-labels');
      const ls = Array.from(document.querySelectorAll('.qm-label'));
      const W = window.innerWidth, H = window.innerHeight;
      const placed = [];
      for (const e of ls) {
        if (e.hidden) continue;
        const m = /translate\\(([-0-9.]+)px, ([-0-9.]+)px\\)/.exec(e.style.transform || '');
        if (!m) continue;
        const x = Number(m[1]), y = Number(m[2]);
        if (x < 0 || x > W || y < 0 || y > H) continue;
        placed.push({ name: e.textContent, x: Math.round(x), y: Math.round(y),
                      opacity: e.style.opacity });
      }
      return { rootHidden: root ? root.hidden : null, total: ls.length,
               placed: placed.length,
               sample: placed.length ? placed[0] : null };
    })()`);
    check('③', '标签容器未被隐藏', labelVisible.rootHidden === false, String(labelVisible.rootHidden));
    check(
      '③',
      '标签经投影落在了视口内的真实坐标上',
      labelVisible.placed > 0,
      `${labelVisible.placed}/${labelVisible.total} 个在视口内` +
        (labelVisible.sample
          ? `,例:${labelVisible.sample.name} @ (${labelVisible.sample.x}, ${labelVisible.sample.y}) α=${labelVisible.sample.opacity}`
          : ' —— 一个都没投影出来'),
    );

    await page.screenshot(`${args.out}/ui_00_default.png`);

    // 点虹桥 → 简介面板
    await click(page, '.qm-spotnav__btn[data-spot="bridge"]', '虹桥按钮');
    await sleep(280);
    s = await snap(page);
    check('③', '点景点按钮后面板切换为简介', s.panel === 'spot', `panel=${s.panel}`);
    check('③', '简介面板确实可见', String(s.panelVisible).includes('spot'), s.panelVisible);
    const spotPanelTitle = await page.evaluate(
      `(document.querySelector('.qm-panel--spot .qm-panel__title') || {}).textContent || ''`,
    );
    check('③', '简介面板在 DOM 里也确实是展开的那个', spotPanelTitle.length > 0, spotPanelTitle);

    const spotText = await page.evaluate(`(() => {
      const body = document.querySelector('.qm-panel--spot .qm-panel__body');
      const title = document.querySelector('.qm-panel--spot .qm-panel__title');
      return { title: title ? title.textContent : '',
               len: body ? body.textContent.trim().length : 0,
               grade: (document.querySelector('.qm-panel--spot .qm-grade') || {}).textContent || '',
               caveat: (document.querySelector('.qm-panel--spot .qm-caveat') || {}).textContent || '' };
    })()`);
    check('③', '简介标题非空', spotText.title.length > 0, spotText.title);
    check('③', '简介正文非空', spotText.len > 40, `${spotText.len} 字`);
    check('③', '带可靠度徽标', /^[ABC]/.test(spotText.grade.trim()), spotText.grade.trim().slice(0, 12));
    check('③', '边界说明固定在面板里', spotText.caveat.length > 10, `${spotText.caveat.trim().length} 字`);
    await page.screenshot(`${args.out}/ui_01_spot.png`);

    // 走近看看 → 相机到近观位
    const near = await page.evaluate('window.__QM__.spots.find((s) => s.id === "bridge").near');
    await click(page, '.qm-panel--spot .qm-btn--primary', '走近看看');
    const settled = await waitSettled(page);
    const pos = await page.evaluate('window.__QM__.cameraSnapshot().position');
    const err = Math.hypot(pos[0] - near[0], pos[1] - near[1], pos[2] - near[2]);
    check('③', '走近看看把相机送到近观位', settled && err < 0.1, `误差 ${err.toFixed(4)} m`);
    await page.screenshot(`${args.out}/ui_02_near.png`);

    // ================= ④ 舆图 / 原卷 / 依据 =================
    await click(page, '.qm-toolbar__btn[data-panel="map"]', '舆图按钮');
    await sleep(280);
    s = await snap(page);
    check('④', '舆图面板可见', String(s.panelVisible).includes('map'), s.panelVisible);
    const mapInfo = await page.evaluate(`(() => {
      const spots = document.querySelectorAll('.qm-map__spot');
      const cam = document.querySelectorAll('.qm-map__cam');
      const svg = document.querySelector('.qm-map__svg');
      return { spots: spots.length, cam: cam.length,
               viewBox: svg ? svg.getAttribute('viewBox') : '',
               status: (document.querySelector('.qm-map__status') || {}).textContent || '' };
    })()`);
    check('④', '舆图上五个定位点', mapInfo.spots === 5, `${mapInfo.spots} 个`);
    check('④', '舆图上有相机标记', mapInfo.cam === 1, `${mapInfo.cam} 个`);
    await page.screenshot(`${args.out}/ui_03_map.png`);

    // 舆图点击 → 相机移动
    const before = await page.evaluate('window.__QM__.cameraSnapshot().position');
    await click(page, '.qm-map__spot', '舆图上的景点');
    await waitSettled(page);
    const after = await page.evaluate('window.__QM__.cameraSnapshot().position');
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
    check('④', '点舆图后相机确实移动', moved > 0.5, `位移 ${moved.toFixed(2)} m`);

    await click(page, '.qm-toolbar__btn[data-panel="basis"]', '依据按钮');
    await sleep(280);
    const basisInfo = await page.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('.qm-basis__item'));
      const grades = items.map((i) => i.dataset.grade);
      const uniq = Array.from(new Set(grades));
      const btns = Array.from(document.querySelectorAll('.qm-gradebtn'));
      return { n: items.length, uniq: uniq, btns: btns.length,
               counts: btns.map((b) => b.textContent) };
    })()`);
    check('④', '复原依据条目 ≥12', basisInfo.n >= 12, `${basisInfo.n} 条`);
    check(
      '④',
      '每条都带等级、且 A/B/C 都存在',
      basisInfo.uniq.sort().join('') === 'ABC',
      `实际出现 ${basisInfo.uniq.join('/')}`,
    );
    check(
      '④',
      '筛选按钮默认全开(不藏 C 级)',
      basisInfo.btns === 3 && basisInfo.counts.every((t) => /[ABC] 【?/.test(t) || /.+\\d+/.test(t)),
      basisInfo.counts.join(' | '),
    );
    await page.screenshot(`${args.out}/ui_04_basis.png`);

    // —— 原卷:横向浏览 ——
    await click(page, '.qm-toolbar__btn[data-panel="scroll"]', '原卷按钮');
    await sleep(400);
    s = await snap(page);
    check('④', '原卷面板可见', String(s.panelVisible).includes('scroll'), s.panelVisible);

    // 等四段全部**解码**完成(不是 onload)。最多等 20s。
    let scrollState = null;
    for (let i = 0; i < 100; i++) {
      scrollState = await page.evaluate(
        'window.__QM__.ui.panels.scroll.status().map((x) => x.state).join(",")',
      );
      if (!scrollState.includes('pending')) break;
      await sleep(200);
    }
    check('④', '原卷四段全部解码完成', scrollState === 'ok,ok,ok,ok', `状态:${scrollState}`);

    const scrollInfo = await page.evaluate(`(() => {
      const view = document.querySelector('.qm-scroll__view');
      const imgs = Array.from(document.querySelectorAll('.qm-scroll__img'));
      return {
        scrollWidth: view ? view.scrollWidth : 0,
        clientWidth: view ? view.clientWidth : 0,
        n: imgs.length,
        // 实物顺序:section1 在最左(它是画卷左端=城内),section4 在最右
        order: imgs.map((i) => (i.getAttribute('src') || '').split('/').pop()),
        // naturalWidth>0 才能证明真的解码了,而不是一个 0×0 的破图
        natural: imgs.map((i) => i.naturalWidth + 'x' + i.naturalHeight),
        panelWidth: Math.round(document.querySelector('.qm-panel--scroll').getBoundingClientRect().width),
      };
    })()`);
    check('④', '四张原卷图都在 DOM 里', scrollInfo.n === 4, `${scrollInfo.n} 张`);
    check(
      '④',
      '每张图都有真实像素(不是破图)',
      scrollInfo.natural.every((d) => !d.startsWith('0x')),
      scrollInfo.natural.join(' '),
    );
    check(
      '④',
      '长条远比视口宽(是"长卷"而非缩略图)',
      scrollInfo.scrollWidth > scrollInfo.clientWidth * 3,
      `条宽 ${scrollInfo.scrollWidth}px / 视口 ${scrollInfo.clientWidth}px = ` +
        `${(scrollInfo.scrollWidth / scrollInfo.clientWidth).toFixed(1)} 屏`,
    );
    check(
      '④',
      '四段按实物顺序排列(未镜像)',
      scrollInfo.order.join(',') === 'section1.jpg,section2.jpg,section3.jpg,section4.jpg',
      scrollInfo.order.join(' '),
    );

    // ⚠️ 卷首在**右**端、卷尾在左端 —— 手卷由右向左展阅。
    //    这条断言存在的意义:按钮写反了不会报错、也不会不动,
    //    只是按下去到了画卷的另一头,截图上看"确实动了"。
    const navState = await page.evaluate(`(() => {
      const view = document.querySelector('.qm-scroll__view');
      const btns = Array.from(document.querySelectorAll('.qm-scroll__nav .qm-btn'));
      return { labels: btns.map((b) => b.textContent), left: view.scrollLeft,
               max: view.scrollWidth - view.clientWidth };
    })()`);
    check('④', '卷首按钮标明了它落在右端', /卷首/.test(navState.labels[0]) && /右端/.test(navState.labels[0]),
      navState.labels.join(' | '));

    await click(page, '.qm-scroll__nav .qm-btn', '卷首(右端)');
    let headLeft = 0;
    for (let i = 0; i < 40; i++) {
      headLeft = await page.evaluate(`document.querySelector('.qm-scroll__view').scrollLeft`);
      if (headLeft >= navState.max - 2) break;
      await sleep(120);
    }
    check('④', '点「卷首」滚到最右端(卷首确实在右)', headLeft >= navState.max - 2,
      `scrollLeft=${headLeft.toFixed(0)} / 最大 ${navState.max.toFixed(0)}`);

    const tailBtns = await page.evaluate(
      `(() => { const b = document.querySelectorAll('.qm-scroll__nav .qm-btn'); return b[1].textContent; })()`,
    );
    check('④', '卷尾按钮标明了它落在左端', /卷尾/.test(tailBtns) && /左端/.test(tailBtns), tailBtns);
    await click(page, '.qm-scroll__nav .qm-btn:nth-of-type(2)', '卷尾(左端)');
    let tailLeft = 999;
    for (let i = 0; i < 40; i++) {
      tailLeft = await page.evaluate(`document.querySelector('.qm-scroll__view').scrollLeft`);
      if (tailLeft <= 2) break;
      await sleep(120);
    }
    check('④', '点「卷尾」滚回最左端', tailLeft <= 2, `scrollLeft=${tailLeft.toFixed(0)}`);

    const dirHint = await page.evaluate(
      `(document.querySelector('.qm-scroll__hint') || {}).textContent || ''`,
    );
    check('④', '面板写明了展阅方向与"未镜像"', /右向左/.test(dirHint) && /镜像/.test(dirHint),
      `${dirHint.trim().length} 字`);
    await page.screenshot(`${args.out}/ui_10_scroll.png`);

    // ================= ⑤ 时辰 / 画质 / 开关 =================
    await click(page, '.qm-toolbar__btn[data-panel="settings"]', '设置按钮');
    await sleep(280);
    await page.screenshot(`${args.out}/ui_05_settings.png`);

    // 画质:对象与材质的 uuid 集合都必须逐项相同
    const uuidsBefore = await page.evaluate(UUID_SET_FN);
    const matsBefore = await page.evaluate(MATERIAL_UUID_FN);
    await click(page, '.qm-seg__btn[data-quality="high"]', '精细档');
    await sleep(500);
    const uuidsAfter = await page.evaluate(UUID_SET_FN);
    const matsAfter = await page.evaluate(MATERIAL_UUID_FN);
    const q1 = await page.evaluate('window.__QM__.quality.report()');
    check(
      '⑤',
      '切画质前后对象 UUID 集合相同',
      sameSet(uuidsBefore, uuidsAfter),
      `${uuidsBefore.length} → ${uuidsAfter.length} 个对象`,
    );
    check(
      '⑤',
      '切画质前后材质 UUID 集合相同(未重建材质)',
      sameSet(matsBefore, matsAfter),
      `${matsBefore.length} → ${matsAfter.length} 个材质`,
    );
    check('⑤', '画质已切到 high', q1.quality === 'high', `quality=${q1.quality}`);
    check('⑤', '阴影贴图跟着变', q1.shadowMapSize === 4096, `${q1.shadowMapSize}px`);
    check(
      '⑤',
      '人物阴影名额有实际作用对象',
      q1.skinnedMeshCount === 0 ? true : q1.charactersCastingShadow > 0,
      `蒙皮网格 ${q1.skinnedMeshCount} 个,投影 ${q1.charactersCastingShadow} 个` +
        (q1.skinnedMeshCount === 0 ? '(场景内暂无人物,待阶段 4)' : ''),
    );

    // 线框:开 → 关,材质集合必须不变
    await click(page, 'label[for="qm-wireframe"]', '线框开关');
    await sleep(260);
    const qw = await page.evaluate('window.__QM__.quality.report()');
    const matsOn = await page.evaluate(MATERIAL_UUID_FN);
    check(
      '⑤',
      '线框已开且作用到材质',
      qw.wireframe === true && qw.wireframeMaterials > 0,
      `wireframe=${qw.wireframe},report 报 ${qw.wireframeMaterials} 个材质`,
    );
    // 交叉验证:report 自己数的材质数,应与直接遍历场景数出来的一致。
    // 不一致说明 report 的统计口径与场景实际不符 —— 而那个数字是要进报告的。
    check(
      '⑤',
      'report 的材质数与直接遍历场景一致',
      qw.wireframeMaterials === matsBefore.length,
      `report=${qw.wireframeMaterials} 实测=${matsBefore.length}`,
    );
    check(
      '⑤',
      '开线框没有新建材质',
      sameSet(matsBefore, matsOn),
      `${matsBefore.length} → ${matsOn.length}`,
    );
    await page.screenshot(`${args.out}/ui_06_wireframe.png`);

    await click(page, 'label[for="qm-wireframe"]', '线框开关(关)');
    await sleep(260);
    const matsOff = await page.evaluate(MATERIAL_UUID_FN);
    check(
      '⑤',
      '关掉线框后材质集合仍不变',
      sameSet(matsBefore, matsOff),
      `${matsBefore.length} → ${matsOff.length}`,
    );
    // 几何是否真的回到实体渲染 —— 只查 wireframe 标志位可能"标志改了但没生效"
    const solid = await page.evaluate(`(() => {
      let total = 0, wire = 0;
      window.__QM__.scene.traverse((o) => {
        if (!o.isMesh) return;
        const m = o.material;
        const list = Array.isArray(m) ? m : [m];
        for (const x of list) if (x && 'wireframe' in x) { total++; if (x.wireframe) wire++; }
      });
      return { total: total, wire: wire };
    })()`);
    check('⑤', '关掉后没有任何材质仍处于线框态', solid.wire === 0,
      `${solid.wire}/${solid.total} 个材质仍为 wireframe`);

    // 时辰
    //
    // ⚠️ 滑块的值是这样改的:先确认它**用户点得到**(尺寸非零、没被盖住),
    //    再派发一个真实的 `input` 事件。不用拖拽是因为 range 输入的
    //    "坐标 → 值"映射由浏览器按控件宽度算,脚本里复算一遍只会引入
    //    一个可能算错的中间量;而页面监听的正是 `input` 事件,
    //    这就是拖动会产生的那一个。可达性单独查,两者合起来才等于
    //    "用户拖得动且拖了有效果"。
    await reachable(page, '.qm-range', '时辰滑块');
    const todBefore = await page.evaluate('window.__QM__.skyTime.environmentRevision');
    await page.evaluate(`(() => {
      const el = document.querySelector('.qm-range');
      el.value = '0.85';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(1200);
    const todAfter = await page.evaluate('window.__QM__.skyTime.environmentRevision');
    const todVal = await page.evaluate('window.__QM__.store.read().tod');
    check('⑤', '时辰已改变', Math.abs(todVal - 0.85) < 1e-6, `tod=${todVal}`);
    check('⑤', '环境贴图确实重建了', todAfter > todBefore,
      `environmentRevision ${todBefore} → ${todAfter}`);
    await page.screenshot(`${args.out}/ui_07_dusk.png`);

    // 标签开关
    await click(page, 'label[for="qm-labels"]', '标签开关');
    await sleep(200);
    const labelsOff = await page.evaluate(`(() => {
      const root = document.querySelector('.qm-labels');
      return { hidden: root ? root.hidden : null };
    })()`);
    check('⑤', '标签开关真的隐藏了标签', labelsOff.hidden === true, String(labelsOff.hidden));
    await click(page, 'label[for="qm-labels"]', '标签开关(恢复)');
    await sleep(200);

    // ================= 「动画」开关(阶段 4 接入) =================
    //
    // ⚠️ 这一段在阶段 3 是**反着的**:当时断言「『动画』开关在无消费者时
    //    **不**出现」,因为它出现就意味着界面上多了一个按下去没反应的控件。
    //    阶段 4 把消费者接上了(`main.ts` 里三个 `clock: 'anim'` 的环节),
    //    断言随之翻面 —— 但**不是**改成"出现了就算过":
    //    只查出现,放过的恰好就是当初要防的那个东西。所以下面拨它两下,
    //    用两支时钟的读数加人物位置快照,验它真的有响应。
    const animRow = await page.evaluate(`Boolean(document.querySelector('#qm-anim'))`);
    check('⑤', '「动画」开关已出现(阶段 4 接上了消费者)', animRow === true,
      animRow ? '' : '没出现 —— 多半是 UIRoot 传给 createSettingsPanel 的 caps.anim 没生效');

    // 下面四条以上一条为前提。前提不过时**逐条记账为失败**,不留空白:
    // 结果表里少四行和"四行全过"看起来几乎一样。
    const ANIM_FOLLOWUPS = [
      '有可观测的人物(否则"冻住了"是句空话)',
      '关掉后人物完全不动',
      '关掉后动画钟一步不走、世界钟照常走',
      '打开后人物重新在动',
      '重新打开是从冻结点续上,不是跳到新相位',
    ];
    if (!animRow) {
      for (const name of ANIM_FOLLOWUPS) {
        check('⑤', name, false, '前置条件没过,这一条没跑 —— 不算通过');
      }
    } else {
      await reachable(page, 'label[for="qm-anim"]', '动画开关');

      // —— 关掉:确认"冻住"是冻住,而不是"更新还在跑、只是看不见" ——
      await click(page, 'label[for="qm-anim"]', '动画开关(关)');
      await sleep(300);
      const c0 = await page.evaluate('window.__QM__.clockSnapshot()');
      const p0 = await page.evaluate('window.__QM__.actorsSnapshot()');
      // 冻得久一点,"解冻时有没有跳变"才分辨得出来 —— 下面那个 0.5s 的门限
      // 与这里的时长是配套的,改一个要想着另一个(memory 第 33 条:要测的差
      // 小于抖动就没有分辨力)。
      await sleep(1500);
      const c1 = await page.evaluate('window.__QM__.clockSnapshot()');
      const p1 = await page.evaluate('window.__QM__.actorsSnapshot()');

      check('⑤', '有可观测的人物(否则"冻住了"是句空话)', p0.length > 0,
        `${p0.length} 个人物实例;空表时任何"没动"都自动成立`);
      const moved = countMoved(p0, p1);
      check('⑤', '关掉后人物完全不动', p0.length > 0 && moved === 0,
        `${moved}/${p0.length} 个人在动(animOn=${c0.animOn})`);
      check('⑤', '关掉后动画钟一步不走、世界钟照常走',
        c0.animOn === false && c1.anim === c0.anim && c1.world > c0.world,
        `anim ${c0.anim} → ${c1.anim},world ${c0.world} → ${c1.world}`);

      // —— 打开:确认"从冻结点续上" ——
      await click(page, 'label[for="qm-anim"]', '动画开关(开)');
      const c2 = await page.evaluate('window.__QM__.clockSnapshot()');
      const p2 = await page.evaluate('window.__QM__.actorsSnapshot()');
      await sleep(600);
      const p3 = await page.evaluate('window.__QM__.actorsSnapshot()');

      const resumed = countMoved(p2, p3);
      check('⑤', '打开后人物重新在动', c2.animOn === true && resumed > 0,
        `${resumed}/${p2.length} 个人在动(animOn=${c2.animOn})`);

      // 判据要说清分母:冻了多久、解冻瞬间动画钟前进了多少。
      // 若实现是"打开时把相位追平 worldTime",这里会一次跳出冻结时长那么多。
      // ⚠️ 必须同时要求 animOn===true —— 开关没生效时动画钟同样一动不动,
      //    光比差值会把"没打开"读成"没有跳变"。
      const leap = +(c2.anim - c1.anim).toFixed(3);
      const frozeFor = +(c1.world - c0.world).toFixed(2);
      check('⑤', '重新打开是从冻结点续上,不是跳到新相位',
        c2.animOn === true && leap >= 0 && leap < 0.5,
        `解冻瞬间动画钟 +${leap}s,而冻结时长为 ${frozeFor}s` +
        `(跳到新相位的话这里会≈${frozeFor}s)`);
    }

    // ================= 船体轻摇 / 不眠桅(阶段 4) =================
    //
    // ⚠️ 这一段的核心不是"计数对不对",是**父子链通不通**。
    //    `rigid.hull_rock === 5` 只证明"有 5 条船被登记成会摇",
    //    证明不了船壳转了之后船上的东西跟着转 —— 而"整船轻摇"的
    //    全部内容就是那个跟随。层级在导出时丢了、或 Blender 侧漏挂,
    //    计数照旧是 5,船却会散架。
    //
    //    所以判据取**自身没有任何动画的部件**(舱篷/肋骨/属具)的位置:
    //    它自己不会动,动了就只可能是被船壳带动的。
    //    反过来,上岸船的同一件**必须一步不动** —— 那是 `qm_beached`
    //    那道闸唯一的反面判据。
    //
    // ⚠️ 前置:上一段结束时「动画」开关是**开着的**(关→开的顺序)。
    //    冻住时船也不摇,所以下面每条都带上 animOn 一起判 ——
    //    否则"没打开"会被读成"没有摇"。
    const boats = await page.evaluate('window.__QM__.boatSnapshot()');
    const pr = await page.evaluate('window.__QM__.propsRuntime()');
    const animNow = await page.evaluate('window.__QM__.clockSnapshot().animOn');

    // ⚠️ 要 6 条不是 5 条:上岸船**也必须在这张表里**。
    //    它被 qm_beached 挡下、不进刚体表 —— 若观测表跟着从刚体表建,
    //    它就没有读数,"上岸船一步不动"那条会**静默地**自动成立。
    //    这里要求 6,就是把"上岸船有没有被观测到"本身当成断言。
    check('⑤', '6 条船都有观测读数(含上岸那条 —— 它必须被看见)', boats.length === 6,
      `${boats.length} 条船有读数;表空则"没动"毫无意义`);
    check('⑤', '5 条下水船被登记为整船横摇',
      pr.mounted === true && pr.rigid && pr.rigid.hull_rock === 5,
      `rigid=${JSON.stringify(pr.rigid)}`);
    check('⑤', '上岸船被 qm_beached 挡在摇晃之外',
      pr.skipped && pr.skipped['刚体·已拖上岸,不随水摇'] === 2,
      `skipped=${JSON.stringify(pr.skipped)}(应为 2:上岸船的船壳 + 它的舵)`);

    if (boats.length !== 6) {
      for (const name of [
        '横摇角真的在变,且量级与声明的 2° 相符',
        '船壳转动与船上部件的位移符合刚体关系(位移 = 2·力臂·sin(Δθ/2))',
        '上岸船一步不动(qm_beached 的反面判据)',
        '上岸船是被闸门挡下的,不是振幅恰好为 0',
      ]) {
        check('⑤', name, false, '前置条件没过,这一条没跑 —— 不算通过');
      }
    } else {
      // 连拍 4 张,取**两两之间的最大距离**,而不是"两张不同":
      // 两张有可能正好落在正弦的同值点上(相位差半个周期),那时
      // "不同"不成立而船其实摇得好好的 —— 那是假失败。
      // 采样跨度 1.8s ≈ 横摇周期 6.5s 的 28%(相位走 100°)。
      // 最坏情形(采样窗正对着波的顶点)下仍能覆盖 sin 的 0.32 倍幅值,
      // 见下面门限的取法。
      const shots = [];
      for (let i = 0; i < 4; i++) {
        shots.push(await page.evaluate('window.__QM__.boatSnapshot()'));
        await sleep(600);
      }

      // 按 id 归拢,不按下标 —— 下标顺序依赖 boatSnapshot 的实现顺序,
      // 那是一条没人保证的隐式约定。
      const byId = {};
      const rockById = {};
      for (const s of shots) {
        for (const b of s) {
          (byId[b.id] = byId[b.id] || []).push(b.childXyz);
          (rockById[b.id] = rockById[b.id] || []).push(b.rockDeg);
        }
      }
      const span = (xs, f = (v) => v) => {
        const vs = xs.map(f);
        return Math.max(...vs) - Math.min(...vs);
      };
      // 距离取**三维**,不取某一个分量:横摇时部件主要**横向**走,
      // 竖向变化是二阶量(1−cos2° ≈ 0.6mm);而"横向"在 three 里算哪个轴
      // 要看每条船的艏向。取三维距离与艏向无关。
      const maxPairDist = (pts) => {
        let m = 0;
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            m = Math.max(m, Math.hypot(
              pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]));
          }
        }
        return m;
      };

      const ids = Object.keys(byId);
      const movingIds = ids.filter((k) => !k.includes('repair'));
      const parkedIds = ids.filter((k) => k.includes('repair'));

      const swings = {};
      for (const k of movingIds) {
        swings[k] = +span(rockById[k], Math.abs).toFixed(4);
      }
      const minSwing = Math.min(...Object.values(swings));
      const maxSwing = Math.max(...Object.values(swings));
      check('⑤', '横摇角真的在变,且量级与声明的 2° 相符',
        animNow === true && minSwing > 0.2 && maxSwing <= 4.0001,
        `各船 |角| 极差 ${JSON.stringify(swings)}°(2° 幅值的极差应落在 0.2~4)`);

      // ================= 刚体核对:位移 = 2·力臂·sin(Δθ/2) =================
      //
      // ⚠️ 这一段是这次返工的全部理由。上一版量的是见证件的
      //    `getWorldPosition()`,即它的**原点** —— 而船部件的原点普遍
      //    就压在船壳锚点上,锚点正是横摇轴心,是旋转的**不动点**。
      //    于是 5 条船读数**恰好为 0**,而同一批样本的角度极差
      //    有 1.1~1.8°:两个都是真读数,凑在一起是假的。
      //    换了材质点之后还有第二层错:力臂要量到**轴线**,不是到轴心
      //    **点** —— 沿轴向的分量再大也不产生位移。
      //
      // 核对的是物理关系本身,不是"动了就行":
      //   绕定轴转 Δθ,刚体上离轴 rPerp 的一点走过的弦长 = 2·rPerp·sin(Δθ/2)。
      //   角度和位置取自**同一次** boatSnapshot 调用,不存在跨调用对时。
      //   力臂取自装载时算好的值,而它和 update() 用的是同一套轴心/轴向 ——
      //   轴标错了力臂就错,这条同样核不上。
      if (movingIds.length !== 5) {
        check('⑤', '船壳转动与船上部件的位移符合刚体关系', false,
          `只有 ${movingIds.length} 条下水船,凑不出样本 —— 这一条没跑,不算通过`);
      } else {
        const resid = {};
        let worstRel = 0;
        for (const k of movingIds) {
          const angs = rockById[k];
          let lo = 0;
          let hi = 0;
          for (let i = 1; i < angs.length; i++) {
            if (angs[i] < angs[lo]) lo = i;
            if (angs[i] > angs[hi]) hi = i;
          }
          const dTheta = (Math.abs(angs[hi] - angs[lo]) * Math.PI) / 180;
          const rPerp = shots[0].find((b) => b.id === k).rPerp;
          const a = byId[k][lo];
          const b = byId[k][hi];
          const chord = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          const pred = 2 * rPerp * Math.sin(dTheta / 2);
          resid[k] = +(chord - pred).toFixed(6);
          worstRel = Math.max(worstRel, pred > 1e-6 ? Math.abs(chord - pred) / pred : 1);
        }
        // 门限 5%:实测吻合到 0.01mm(相对残差 <0.1%),留 50 倍余量给
        // 采样时刻抖动。取相对量,不吃船的大小。
        check('⑤', '船壳转动与船上部件的位移符合刚体关系(位移 = 2·力臂·sin(Δθ/2))',
          animNow === true && worstRel < 0.05,
          `各船"实测−预测"余差 ${JSON.stringify(resid)} m,最大相对残差 ` +
          `${(worstRel * 100).toFixed(2)}%(门限 5%)。` +
          `力臂 ${shots[0].filter((b) => b.rockDeg !== null).map((b) => b.rPerp).join('/')} m`);
      }

      // 反面:上岸船一步不动。必须**精确**为 0 —— 它连一帧都不该动。
      const parkedMove = parkedIds.map((k) => +maxPairDist(byId[k]).toFixed(6));
      check('⑤', '上岸船一步不动(qm_beached 的反面判据)',
        parkedIds.length === 1 && parkedMove.every((v) => v === 0),
        `${parkedIds.join(',')} 的三维位移 ${JSON.stringify(parkedMove)} m`);

      // 而且它必须是**根本没被驱动**,不是"被驱动了但振幅恰好是 0"。
      // rockDeg 声明成 number|null 就是为这个:`null` = 闸门挡下,没进刚体表;
      // 0 = 进了表但振幅为零。两者在"没动"这个读数上完全一样,
      // 分不清就说明不了 qm_beached 起了作用 —— 那样这条断言可以永远成立。
      const parkedRock = parkedIds.flatMap((k) => rockById[k] ?? []);
      check('⑤', '上岸船是被闸门挡下的,不是振幅恰好为 0',
        parkedIds.length === 1 && parkedRock.length === 4 &&
        parkedRock.every((v) => v === null),
        `rockDeg 读数 ${JSON.stringify(parkedRock)}(应全为 null:null=没被驱动)`);
    }

    // ================= ⑥ 巡游 / 隐藏界面 / 全屏 =================
    await click(page, '.qm-toolbar__btn[data-panel="settings"]', '关掉设置');
    await sleep(200);

    await click(page, '.qm-toolbar__btn[data-action="tour"]', '巡游');
    await sleep(400);
    const tourOn = await page.evaluate('window.__QM__.cameraSnapshot().autoTour');
    check('⑥', '点巡游后 autoTour === true', tourOn === true, String(tourOn));
    const tourLabel = await page.evaluate(
      `document.querySelector('.qm-toolbar__btn[data-action="tour"]').textContent`,
    );
    check('⑥', '按钮文字跟着变成「停止巡游」', tourLabel.includes('停止'), tourLabel);
    await page.screenshot(`${args.out}/ui_08_tour.png`);

    // 手动操作必须退出巡游 —— 派发真实指针事件到画布
    const c = await rect(page, '#stage');
    await page.mouse('mousePressed', c.x, c.y);
    await page.mouse('mouseReleased', c.x, c.y);
    await sleep(300);
    const tourOff = await page.evaluate('window.__QM__.cameraSnapshot()');
    check('⑥', '手动操作立即退出巡游', tourOff.autoTour === false, `退出原因:${tourOff.exitReason}`);

    await click(page, '.qm-toolbar__btn[data-action="chrome"]', '隐藏界面');
    await sleep(250);
    const chromeOff = await page.evaluate(`(() => {
      const t = document.querySelector('.qm-topbar');
      const b = document.querySelector('.qm-toolbar');
      const l = document.querySelector('.qm-labels');
      const p = document.querySelector('.qm-panelhost');
      return { topbar: t.hidden, toolbar: b.hidden, labels: l.hidden, panelhost: p.hidden };
    })()`);
    check('⑥', '隐藏界面后顶栏、工具栏、面板容器都消失',
      chromeOff.topbar && chromeOff.toolbar && chromeOff.panelhost,
      `topbar=${chromeOff.topbar} toolbar=${chromeOff.toolbar} panelhost=${chromeOff.panelhost}`);
    check('⑥', '但三维标签仍在(它属于画面内容)', chromeOff.labels === false,
      `labels.hidden=${chromeOff.labels}`);
    await page.screenshot(`${args.out}/ui_09_nochrome.png`);

    // ⚠️ **关键断言:隐藏界面不能是一条不归路。**
    //    「显示界面」原先就挂在被隐藏的那条工具栏上,点下去之后按钮自己是
    //    0×0,再也点不回来 —— 界面成一次性的。这里用 reachable() 明确要求
    //    屏幕上存在一个**点得到的**恢复入口,并且真的靠它回到有界面的状态。
    const restore = await reachable(page, '[data-action="unhide"]', '恢复界面的按钮');
    check('⑥', '隐藏界面后存在可点的恢复入口', restore.w > 0 && restore.h > 0,
      `尺寸 ${restore.w.toFixed(0)}×${restore.h.toFixed(0)} @ (${restore.x.toFixed(0)}, ${restore.y.toFixed(0)})`);
    await click(page, '[data-action="unhide"]', '显示界面');
    await sleep(250);
    s = await snap(page);
    check('⑥', '点恢复入口真的回到了有界面的状态', s.chrome === true, `chrome=${s.chrome}`);

    // 键盘退路:H 键。触屏没有键盘,所以这是**第二条**路,不是唯一那条。
    await page.evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    s = await snap(page);
    check('⑥', '键盘 H 也能隐藏界面', s.chrome === false, `chrome=${s.chrome}`);
    await page.evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    s = await snap(page);
    check('⑥', '再按一次 H 恢复', s.chrome === true, `chrome=${s.chrome}`);

    // ================= 配乐 =================
    //
    // 出口条件写的是「AudioContext running」,而这个说法本身要拆开:
    //   ① 按钮在不在(不在 = 引擎没接进来,那是个点了没反应的装饰控件);
    //   ② 点下去以后 `AudioContext.state` 到底是不是 'running';
    //   ③ **有没有真的在响** —— 上下文跑起来不等于有声音,得看工作节点
    //      真的起播了几个音(`started`)。
    // 只查 ① 会把"按钮亮着但静音"判成通过;只查 ② 会把"上下文空转"判成通过。
    const audioBtn = await page.evaluate(
      `Boolean(document.querySelector('.qm-toolbar__btn[data-action="audio"]'))`,
    );
    const rt0 = await page.evaluate('window.__QM__.audioRuntime');
    check(
      '⑥',
      '「配乐」按钮存在(音频引擎已接入)',
      audioBtn === true,
      audioBtn ? '' : `按钮没画出来 —— 引擎${rt0.wired ? '在但没注入' : `没起来:${rt0.reason}`}`,
    );
    if (audioBtn) {
      // 真实点击(不是 element.click()):init() 必须在**用户手势**里发生,
      // 而这个前置条件本身就是要验的东西之一 —— 用脚本直接调 init() 就把它绕过去了。
      await click(page, '.qm-toolbar__btn[data-action="audio"]', '配乐按钮');
      await sleep(1200);
      const rt1 = await page.evaluate('window.__QM__.audioRuntime');
      const s1 = await snap(page);
      check(
        '⑥',
        '点「配乐」后 AudioContext 处于 running',
        rt1.state === 'running',
        `state=${rt1.state} enabled=${rt1.enabled} store.audio=${s1.audio} ` +
          `worklet=${rt1.workletSource}${rt1.workletError ? `(曾失败:${rt1.workletError})` : ''}`,
      );
      check(
        '⑥',
        'store 的 audio 与引擎真实状态一致(不是只改了高亮)',
        s1.audio === true && rt1.enabled === true,
        `store.audio=${s1.audio} engine.enabled=${rt1.enabled}`,
      );
      // 再等一会儿,给调度器时间把音符真正发到工作节点。
      await sleep(1800);
      const rt2 = await page.evaluate('window.__QM__.audioRuntime');
      check(
        '⑥',
        '工作节点确实起播了音符(不只是上下文空转)',
        rt2.started > 0,
        `已起播 ${rt2.started} 个音,被动丢音 ${rt2.dropped},` +
          `渲染循环最大间隔 ${(rt2.maxGap * 1000).toFixed(2)}ms,` +
          `时钟错位 ${(rt2.clockSkew * 1000).toFixed(2)}ms,` +
          `乐句 ${rt2.noteCount} 音 指纹 ${String(rt2.fingerprint).slice(0, 8)}`,
      );
      // 关掉:按钮要回到"配乐",且引擎跟着关
      await click(page, '.qm-toolbar__btn[data-action="audio"]', '配乐按钮');
      await sleep(600);
      const rt3 = await page.evaluate('window.__QM__.audioRuntime');
      const s3 = await snap(page);
      check(
        '⑥',
        '再点一次关得掉,且状态回写一致',
        s3.audio === false && rt3.enabled === false,
        `store.audio=${s3.audio} engine.enabled=${rt3.enabled} state=${rt3.state}`,
      );
    }

    // ================= ⑦ 真实进度 + 错误提示 =================
    //
    // 这一组要回答两个**不同**的问题,而且必须分工回答:
    //   ① 进度条上的数字是不是单调爬到 100%?
    //   ② 某个 GLB 真的坏掉时,遮罩有没有说清"哪个文件、什么错"?
    //
    // ⚠️ 进度怎么量:用 MutationObserver 盯进度条的 `style.width`,
    //    **不是**每帧去读 store。每帧读是**抽样** —— 两次读之间的变化
    //    整个丢掉,而"单调不减"正是那种会被抽样抹平的缺陷。
    //    进度条是应用自己按 store 算出来的,store 每变一次它就变一次,
    //    于是盯 DOM 拿到的是**完整序列**。
    //    代价是分辨率只有 1%(遮罩写的是 Math.round(progress*100)),
    //    小于 1% 的回退量测不到 —— 所以再补一条每帧读 store 的
    //    **全精度**序列:一条保证不漏,一条保证够细,两条一起才成立。
    //
    // ⚠️ 这个记录器必须在**文档创建时**就装上,所以走
    //    `Page.addScriptToEvaluateOnNewDocument` + reload,
    //    没法在已经加载完的页面上补装 —— 那只能采到后半段。
    // ⚠️ 记录器**必须在加载结束时自己停掉**。
    //    它盯着全文档的 style 变化,而标签每帧都在写 style.transform ——
    //    不停的话它会给后面每一组测量都加上一层开销。那正是"一个仪表
    //    把另一个仪表读数搞坏"的老毛病:第 ⑧ 组量的就是每帧开销。
    //    判据取 phase,不用计时器:加载到 ready 或 failed 就是终态。
    const PROGRESS_RECORDER = `
window.__QMPROG__ = { bar: [], store: [] };
window.__QMPROG__.obs = new MutationObserver(function (muts) {
  for (var i = 0; i < muts.length; i++) {
    var t = muts[i].target;
    if (t && t.classList && t.classList.contains('veil__bar')) {
      window.__QMPROG__.bar.push(parseFloat(t.style.width) || 0);
    }
  }
});
window.__QMPROG__.obs.observe(document, { subtree: true, attributes: true, attributeFilter: ['style'] });
(function tick() {
  var qm = window.__QM__;
  if (qm) {
    var L = qm.store.read().load;
    window.__QMPROG__.store.push(L.progress);
    if (L.phase === 'ready' || L.phase === 'failed') {
      window.__QMPROG__.obs.disconnect();
      return;
    }
  }
  requestAnimationFrame(tick);
})();
`;

    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROGRESS_RECORDER });
    {
      const loaded = page.conn.waitForEvent('Page.loadEventFired', {
        timeout: 90000,
        sessionId: page.sessionId,
      });
      await page.send('Page.reload', { ignoreCache: true });
      await loaded;
    }
    await page.waitForReady({ timeout: 120000 });

    const prog = await page.evaluate(`(() => {
      var p = window.__QMPROG__;
      var bar = p.bar, st = p.store;
      var barMono = true, barBack = 0, barWorst = 0;
      for (var i = 1; i < bar.length; i++) {
        var d = bar[i] - bar[i - 1];
        if (d < -1e-9) { barMono = false; barBack++; if (-d > barWorst) barWorst = -d; }
      }
      var stMono = true, stBack = 0, stWorst = 0;
      for (var j = 1; j < st.length; j++) {
        var e = st[j] - st[j - 1];
        if (e < -1e-12) { stMono = false; stBack++; if (-e > stWorst) stWorst = -e; }
      }
      var phases = window.__QM__.store.read().load.phaseLog.map(function (m) { return m.phase; });
      return {
        barN: bar.length, barDistinct: Array.from(new Set(bar)).length,
        barFirst: bar.length ? bar[0] : null, barLast: bar.length ? bar[bar.length - 1] : null,
        barMono: barMono, barBack: barBack, barWorst: barWorst,
        stN: st.length, stFirst: st.length ? st[0] : null, stLast: st.length ? st[st.length - 1] : null,
        stMono: stMono, stBack: stBack, stWorst: stWorst,
        phases: phases
      };
    })()`);

    check(
      '⑦',
      '进度条被逐次变化地采到了(不是抽样)',
      prog.barN >= 20 && prog.barDistinct >= 15,
      `${prog.barN} 次变化 / ${prog.barDistinct} 个不同取值`,
    );
    check(
      '⑦',
      '进度条上的数字全程单调不减',
      prog.barMono,
      prog.barMono
        ? `${prog.barFirst}% → ${prog.barLast}%`
        : `回退 ${prog.barBack} 次,最大回退 ${prog.barWorst}%`,
    );
    check('⑦', '进度条走到 100%', prog.barLast === 100, `终值 ${prog.barLast}%`);
    check(
      '⑦',
      '全精度进度单调不减且终值为 1',
      prog.stMono && prog.stLast > 0.999,
      prog.stMono
        ? `${prog.stFirst} → ${prog.stLast}`
        : `回退 ${prog.stBack} 次,最大 ${prog.stWorst}`,
    );
    // ⚠️ 首帧必须是 0。这一条**不是**在夸自己,而是在验证仪表本身:
    //    记录器晚装一帧,采到的就是后半段,"单调"仍然成立 —— 但那是对
    //    半段说的。首值为 0 才能证明它从第一帧就看着。
    check('⑦', '记录器从第 0 帧就开始采(不是半途插入)', prog.stFirst === 0, `首值 ${prog.stFirst}`);
    check(
      '⑦',
      '进度依次经过 下载 → 解析 → 编译 → 就绪',
      ['manifest', 'fetching', 'parsing', 'compiling', 'ready'].every((p) =>
        prog.phases.includes(p),
      ),
      prog.phases.join(' → '),
    );

    // —— 注入一个真实的 404 ——
    //
    // ⚠️ 用 `Fetch.fulfillRequest` 返回 **404 状态码**,不用
    //    `Network.setBlockedURLs`。后者让请求失败得"更彻底",但报出来的是
    //    `net::ERR_BLOCKED_BY_CLIENT` —— 那是"被拦截",不是"文件不存在"。
    //    本组要验的是"服务器说这个文件没有"时界面怎么讲,
    //    用拦截来模拟会验成另一件事。
    //
    // ⚠️ 模式只匹配这一个 URL,其余请求原样放行 —— 否则整页都停住等
    //    我们处理,页面再也加载不完。
    let blockedHits = 0;
    await page.send('Fetch.enable', {
      patterns: [{ urlPattern: '*scene_props.glb', requestStage: 'Request' }],
    });
    const offFetch = page.conn.on((msg) => {
      if (msg.sessionId !== page.sessionId) return;
      if (msg.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = msg.params;
      if (/scene_props\.glb/.test(request.url)) {
        blockedHits++;
        page
          .send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 404,
            responsePhrase: 'Not Found',
            responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }],
            body: Buffer.from('not found').toString('base64'),
          })
          .catch(() => {});
      } else {
        page.send('Fetch.continueRequest', { requestId }).catch(() => {});
      }
    });

    {
      const loaded = page.conn.waitForEvent('Page.loadEventFired', {
        timeout: 90000,
        sessionId: page.sessionId,
      });
      await page.send('Page.reload', { ignoreCache: true });
      await loaded;
    }
    let failedPhase = 'none';
    for (let i = 0; i < 300; i++) {
      failedPhase = await page.evaluate(
        'window.__QM__ ? window.__QM__.store.read().load.phase : "noQm"',
      );
      if (failedPhase === 'failed') break;
      await sleep(100);
    }
    check('⑦', '注入 404 后加载确实进了失败态', failedPhase === 'failed', `phase=${failedPhase}`);
    check('⑦', '404 确实被我们拦下来改写过', blockedHits === 1, `${blockedHits} 次`);

    const failUi = await page.evaluate(`(() => {
      var veil = document.querySelector('.veil');
      var box = document.querySelector('.veil__error');
      var items = Array.from(document.querySelectorAll('.veil__error li')).map(function (li) {
        return { code: (li.querySelector('code') || {}).textContent || '',
                 text: li.textContent || '' };
      });
      var retry = document.querySelector('.veil__retry');
      var s = window.__QM__.store.read().load;
      return {
        veilHidden: veil ? veil.hidden : null,
        isFailed: veil ? veil.classList.contains('is-failed') : null,
        boxHidden: box ? box.hidden : null,
        items: items,
        retryText: retry ? retry.textContent : '',
        failures: s.failures.map(function (f) { return { url: f.url, stage: f.stage, status: f.status, message: f.message }; })
      };
    })()`);
    check('⑦', '遮罩没有消失,而是切成了失败态', failUi.veilHidden === false && failUi.isFailed === true,
      `hidden=${failUi.veilHidden} is-failed=${failUi.isFailed}`);
    check('⑦', '失败条目出现在遮罩里', failUi.items.length === 1, `${failUi.items.length} 条`);
    check(
      '⑦',
      '指明了是哪个文件',
      failUi.failures.length === 1 && /scene_props\.glb$/.test(failUi.failures[0].url),
      failUi.failures.map((f) => f.url.split('/').pop()).join(','),
    );
    check(
      '⑦',
      '指明了是哪一步、什么状态码',
      failUi.failures[0]?.stage === 'fetch' && failUi.failures[0]?.status === 404,
      `stage=${failUi.failures[0]?.stage} status=${failUi.failures[0]?.status} msg=${failUi.failures[0]?.message}`,
    );
    check(
      '⑦',
      '界面上的文字把文件名与原因都写出来了',
      failUi.items.length === 1 &&
        /scene_props\.glb/.test(failUi.items[0].text) &&
        /404/.test(failUi.items[0].text) &&
        /下载/.test(failUi.items[0].text),
      failUi.items[0] ? failUi.items[0].text.trim().slice(0, 90) : '(无)',
    );
    check('⑦', '提供了重试入口', failUi.retryText.length > 0, failUi.retryText);

    // ⚠️ 遮罩必须**盖在界面之上**,而且这一条只能用命中测试来量。
    //    缺陷的样子是:顶栏按钮、工具栏、三维标签全都画在遮罩之上 ——
    //    元素都在、尺寸都正常、断言全过,只有层次是反的。
    //    (它是从截图里看出来的:ui_11_loadfail.png 上「虹桥」正好压在
    //     进度条上、「漕船」压在「重试」按钮上。)
    //    实害是**加载期间顶栏能点**:点「虹桥」会把相机飞向一个还没加载
    //    出来的空场景 —— 什么也不会发生,也什么错都不报。
    //
    //    ⚠️ 这条断言有个前提,不查清就会变成"不能失败的断言":
    //       elementFromPoint **看不见 pointer-events:none 的元素**。
    //       实测(一次性探针 tools/perf/once/pe.mjs,phase=ready 时量)的继承链是:
    //         button.qm-label.qm-interactive => pe=auto   ← 命中测试能看到它
    //         div.qm-labels                  => pe=none   ← 从 #ui-root 继承来的
    //       也就是说,**三维标签能被命中的唯一原因是按钮自己带了
    //       .qm-interactive**。哪天有人把这个 class 摘了,标签依然在、依然
    //       好看,而这条断言会永远为真 —— 变成摆设。
    //       所以下面把每个被探测元素的 computed pointer-events 一并量出来,
    //       不是 auto 就直接判失败:断言顺手检查自己的仪表。
    const stack = await page.evaluate(`(() => {
      function probe(sel) {
        var el = document.querySelector(sel);
        if (!el) return null;
        var r = el.getBoundingClientRect();
        var hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { sel: sel, pe: getComputedStyle(el).pointerEvents,
                 hit: hit ? (hit.getAttribute('class') || hit.tagName) : null,
                 inVeil: Boolean(hit && hit.closest && hit.closest('.veil')) };
      }
      return { topbar: probe('.qm-spotnav__btn'), toolbar: probe('.qm-toolbar__btn'),
               label: probe('.qm-label') };
    })()`);
    const onTop = ['topbar', 'toolbar', 'label']
      .map((k) => stack[k])
      .filter(Boolean);
    check(
      '⑦',
      '遮罩盖在顶栏/工具栏/三维标签之上(加载期间点不到它们)',
      onTop.length === 3 && onTop.every((p) => p.inVeil && p.pe === 'auto'),
      onTop.map((p) => `${p.sel}→${p.inVeil ? '遮罩' : p.hit}(pe=${p.pe})`).join(' '),
    );
    await page.screenshot(`${args.out}/ui_11_loadfail.png`);

    // —— 重试必须真的能救回来 ——
    // ⚠️ 先撤掉 404,否则"重试成功"要么不可能,要么得靠第二次改写,
    //    那验的就成了改写逻辑。这里放行之后再点,验的是**重试本身**。
    await page.send('Fetch.disable');
    offFetch();
    await click(page, '.veil__retry', '重试按钮');
    let recovered = 'none';
    for (let i = 0; i < 600; i++) {
      recovered = await page.evaluate(
        'window.__QM__ ? window.__QM__.store.read().load.phase : "noQm"',
      );
      if (recovered === 'ready') break;
      await sleep(100);
    }
    const afterRetry = await page.evaluate(`(() => {
      var veil = document.querySelector('.veil');
      return { phase: window.__QM__.store.read().load.phase,
               veilHidden: veil ? veil.hidden : null,
               chunks: window.__QM__.assets ? window.__QM__.assets.chunks.size : -1,
               sceneChildren: window.__QM__.scene.children.length };
    })()`);
    check('⑦', '点重试后真的恢复到了就绪', recovered === 'ready', `phase=${afterRetry.phase}`);
    check('⑦', '恢复后遮罩撤掉、四块模型都在场景里',
      afterRetry.veilHidden === true && afterRetry.chunks === 4,
      `veil.hidden=${afterRetry.veilHidden} chunks=${afterRetry.chunks} children=${afterRetry.sceneChildren}`);
    // ⚠️ 恢复后场景里对象数不能翻倍。`assemble()` 是"把 chunks 加进场景",
    //    它被调用两次就会把同一批模型加两遍 —— 画面上看不出来(完全重合),
    //    只有三角面数与 drawcall 会翻番。这条断言就是为那个而立的。
    const sceneDup = await page.evaluate(`(() => {
      var top = window.__QM__.scene.children.map(function (o) { return o.name; })
        .filter(function (n) { return n; });
      var seen = {}, dup = [];
      for (var i = 0; i < top.length; i++) {
        if (seen[top[i]]) dup.push(top[i]); else seen[top[i]] = 1;
      }
      return { names: top, dup: dup };
    })()`);
    check('⑦', '重试没有把模型往场景里加第二遍', sceneDup.dup.length === 0,
      sceneDup.dup.length ? `重复:${sceneDup.dup.join(',')}` : `${sceneDup.names.length} 个顶层组,无重名`);

    // ================= ⑧ 相机稳定性 =================
    //
    // 三件事:漫游时每帧走多远、停住时会不会自己漂、以及**相机有没有钻到
    // 地面以下**。前两件靠逐帧记录,第三件靠记录完之后**回放射线**。
    //
    // ⚠️ 射线为什么放到记录之后:一次向下 raycast 要遍历几十万三角面,
    //    是**阻塞**的。边记录边打射线会卡住 rAF,把"单帧位移"这套统计
    //    污染成射线耗时造成的假抖动 —— 一个仪表把另一个仪表的读数搞坏。
    //    几何在记录期间不动,所以拿记录下来的坐标事后补打,
    //    结果**一模一样**,而记录过程是干净的。
    //    ⚠️ 记录里**同时存两个时钟**:rAF 时间戳 `ts` 与 `performance.now()`。
    //
    //    这不是冗余,是踩过一次坑留下的疤。第一版只存 performance.now(),
    //    量出来的速度是这个样子:
    //        速度 p50 2.182 / p95 2.407 / max 4.008 m/s  ← max 是 p50 的 1.8 倍
    //    把尖刺那几步的原始数打出来(tools/perf/once/stab.mjs),它们是:
    //        #590  v=3.686  d=0.01382m  dt=3.75ms  (同一帧用 rAF 戳算是 6.33ms)
    //        #1613 v=3.363  d=0.01310m  dt=3.90ms  (                 6.00ms)
    //        #881  v=3.198  d=0.01335m  dt=4.18ms  (                 6.11ms)
    //    **0.01382/6.33 = 2.18**、0.01310/6.00 = 2.18、0.01335/6.11 = 2.18 ——
    //    八根尖刺无一例外,换成 rAF 戳作分母全部落回中位速度。
    //    另一头也对得上:最慢的几帧 dt=23.9ms d=0.05073 → 2.123 m/s。
    //
    //    原因是**两个仪表用的不是同一个钟**:相机每帧走多远由 `Timer.update(ts)`
    //    决定,用的是 rAF 时间戳;而 `performance.now()` 量的是"我的回调这一刻",
    //    它在帧内的落点每次能差两三毫秒。于是**同一帧位移被除以了偏小的 dt**,
    //    除出来一根不存在的尖刺。控件里的帧长本身并没有抖到那个程度。
    //    所以主判据改用 rAF 戳算 dt —— 与被测对象同一个钟;
    //    performance.now() 那一路仍然算出来打印在旁边,当作**仪表自检**:
    //    哪天两者差得离谱,就说明记录器又开始量错时间了。
    const STAB_RECORDER = (label) => `
window.__QMSTAB__ = (function () {
  var cam = window.__QM__.camera;
  var s = []; var running = true;
  function tick(ts) {
    if (!running) return;
    s.push([ts, performance.now(), cam.position.x, cam.position.y, cam.position.z]);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return { label: ${JSON.stringify(label)},
           stop: function () { running = false; return s; } };
})();
`;

    /**
     * 从给定的若干位置**向下**打射线,量"脚下是什么、离它多高"。
     * 返回每条射线的净空(相机高度 − 命中点高度),没打中任何东西的记 null。
     *
     * ⚠️ 样本是 `[rAF戳, performance.now, x, y, z]` —— 坐标从**第 2 位**起。
     *    记录器加时钟字段那天,这里的下标必须一起改;漏改的下场是
     *    "拿 performance.now() 当 x 坐标"去打射线:数照样出得来,只是全错。
     */
    const CLEARANCE_FN = (positions) => `(() => {
  var qm = window.__QM__;
  var THREE = qm.THREE;
  var ray = new THREE.Raycaster();
  var down = new THREE.Vector3(0, -1, 0);
  var origin = new THREE.Vector3();
  var pos = ${JSON.stringify(positions)};
  var out = [];
  var t0 = performance.now();
  for (var i = 0; i < pos.length; i++) {
    origin.set(pos[i][2], pos[i][3], pos[i][4]);
    ray.set(origin, down);
    var hits = ray.intersectObjects(qm.scene.children, true);
    if (!hits.length) { out.push({ i: i, clear: null, hit: '' }); continue; }
    out.push({ i: i, y: pos[i][3], hitY: hits[0].point.y,
               clear: pos[i][3] - hits[0].point.y,
               hit: hits[0].object.name || hits[0].object.type });
  }
  return { ms: Math.round(performance.now() - t0), rays: out };
})()`;

    /**
     * 逐帧位移统计。样本形如 [rAF戳, performance.now, x, y, z]。
     *
     * 同时给出**位移**与**速度**两套数,因为它们回答的不是同一个问题 ——
     * 下面 ⑧A 的注释里记了这件事踩到的坑。
     * 速度按**两个钟各算一遍**:主判据用 rAF 戳(`sMax`),`performance.now()`
     * 那一路(`nMax`)只用来做仪表自检 —— 两者差得离谱就说明记录器量错了时间。
     */
    function stepStats(samples) {
      const steps = [];
      const speeds = [];
      const speedsNow = [];
      const dts = [];
      for (let i = 1; i < samples.length; i++) {
        const d = Math.hypot(
          samples[i][2] - samples[i - 1][2],
          samples[i][3] - samples[i - 1][3],
          samples[i][4] - samples[i - 1][4],
        );
        const dt = (samples[i][0] - samples[i - 1][0]) / 1000; // rAF 时间戳,与相机同一个钟
        const dtNow = (samples[i][1] - samples[i - 1][1]) / 1000;
        steps.push(d);
        dts.push(dt);
        // dt 极小(同一毫秒内的两帧)时除法会炸出一个假的大速度,故设下限
        speeds.push(dt > 1e-4 ? d / dt : 0);
        speedsNow.push(dtNow > 1e-4 ? d / dtNow : 0);
      }
      const q = (arr, p) => {
        const s = [...arr].sort((a, b) => a - b);
        return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
      };
      return {
        n: steps.length,
        path: steps.reduce((a, b) => a + b, 0),
        p50: q(steps, 0.5),
        p95: q(steps, 0.95),
        max: q(steps, 1),
        sP50: q(speeds, 0.5),
        sP95: q(speeds, 0.95),
        sMax: q(speeds, 1),
        // performance.now() 钟下的最大速度,仅作对照
        nMax: q(speedsNow, 1),
        dtP50: q(dts, 0.5),
        dtMax: q(dts, 1),
      };
    }

    /** 每隔 step 帧取一个点,给射线用。 */
    function thin(samples, k) {
      const out = [];
      const every = Math.max(1, Math.floor(samples.length / k));
      for (let i = 0; i < samples.length; i += every) out.push(samples[i]);
      return out;
    }

    const DEFAULT_POSE = { position: [26, 14, 30], target: [0, 4, 0] };

    async function record(ms, label) {
      await page.evaluate(STAB_RECORDER(label));
      await sleep(ms);
      return page.evaluate('window.__QMSTAB__.stop()');
    }

    // —— ⑧A 漫游 10s(默认机位起) ——
    await page.evaluate(
      `window.__QM__.director.place([${DEFAULT_POSE.position.join(',')}],` +
        `[${DEFAULT_POSE.target.join(',')}]);`,
    );
    await sleep(200);
    await page.evaluate('window.__QM__.startRoam()');
    const roamA = await record(10000, 'roam-default');
    const modeA = await page.evaluate('window.__QM__.cameraSnapshot().mode');
    check('⑧', '漫游确实在跑', modeA === 'roam', `mode=${modeA}`);

    const stA = stepStats(roamA);
    check('⑧', '漫游期间采到了足够多的帧', stA.n >= 300, `${stA.n} 帧 / ${roamA.length} 个样本`);
    // ⚠️ 「总位移 > 0」这条是**防"测试因为什么都没发生而通过"**的。
    //    相机不动时,任何"位移不超过 X"的断言都成立,而那种成立毫无意义。
    check('⑧', '漫游期间相机确实在移动(否则下面的断言是空的)',
      stA.path > 1, `累计路程 ${stA.path.toFixed(2)} m`);
    // ⚠️⚠️ 判据为什么是**速度**而不是**位移**
    //
    // 计划书原文是「单帧位移 <2×p95」。先按原文量了,**没过**:
    //     p50 0.0132 / p95 0.0135 / max 0.0488 m —— max 是 p95 的 3.6 倍
    // 查下去发现那**不是相机跳**,是帧时:
    //     漫游每帧走多远完全由 dt 决定 —— `stepRoam` 里 `azimuth += ROAM_RATE*dt`。
    //     那个 0.0488m 出现在耗时约 22ms 的一帧,而中位帧只有约 6ms;
    //     6.0 → 22.3ms 正好让位移涨 3.7 倍,与实测的 3.6 倍对得上。
    // 所以按原文量到的是"某一帧卡了一下",不是"相机瞬移"。
    // 而这个仪表本身也有偏差:无头 Chrome 没有垂直同步,帧长在 6ms 上下抖。
    //
    // 判据改成 **速度 = 位移 ÷ dt**。它对帧时抖动免疫,量的才是相机自己。
    // 原始位移数仍原样打印 —— 读者可以自己核上面这条推理,不必信我。
    // (这不是"把标准放松到能过":速度极差 1% 比位移极差 3.6 倍**严得多**,
    //  它要求每一帧都恰好在按角速度走,多走一点就露。)
    const okA = stA.sMax <= Math.max(2 * stA.sP95, 0.05);
    check(
      '⑧',
      '漫游瞬时速度不超过 2×p95(没有瞬移)',
      okA,
      `速度 p50 ${stA.sP50.toFixed(3)} / p95 ${stA.sP95.toFixed(3)} / max ${stA.sMax.toFixed(3)} m/s` +
        `(阈值 ${Math.max(2 * stA.sP95, 0.05).toFixed(3)}) —— ` +
        `同时测到的位移 p50 ${stA.p50.toFixed(4)} / p95 ${stA.p95.toFixed(4)} / max ${stA.max.toFixed(4)} m,` +
        `帧长 p50 ${(stA.dtP50 * 1000).toFixed(1)} / max ${(stA.dtMax * 1000).toFixed(1)} ms`,
    );
    // 位移与 dt 成正比是漫游的**实现方式**,所以再直接量一次这个比例关系:
    // 速度的极差小,就等于说"每一帧的位移都恰好等于该帧时长应走的路"。
    //
    // ⚠️ 这条判据先后错过两次,两次都不是相机的问题,是仪表的问题:
    //    第一次用位移时,量到的是帧长抖动(换了判据);
    //    第二次换了速度却仍用 performance.now() 当分母,量到的是**回调在帧内
    //    的落点漂移**(换了钟)。所以这里把两套钟的结果并排打出来:
    //    并排着看,读者不必相信"已经修好了",他自己就能看出哪个数是假的。
    const spread = stA.sP50 > 0 ? (stA.sMax - stA.sP50) / stA.sP50 : 1;
    check(
      '⑧',
      '每一帧的位移都等于该帧时长应走的距离(速度恒定)',
      spread < 0.2,
      `速度中位 ${stA.sP50.toFixed(3)} m/s,最大偏离 +${(spread * 100).toFixed(1)}%` +
        ` —— 同一批样本换 performance.now() 当分母,最大速度 ${stA.nMax.toFixed(3)} m/s` +
        `(${((stA.nMax / stA.sP50 - 1) * 100).toFixed(0)}%),那是回调落点漂移造成的假数`,
    );

    const rayA = await page.evaluate(CLEARANCE_FN(thin(roamA, 12)));
    const clearsA = rayA.rays.filter((r) => r.clear !== null);
    const minA = clearsA.length ? Math.min(...clearsA.map((r) => r.clear)) : NaN;
    check('⑧', '漫游全程相机在地面之上',
      clearsA.length >= 10 && clearsA.every((r) => r.clear > 0),
      `${clearsA.length}/${rayA.rays.length} 条射线命中,最小净空 ${minA.toFixed(2)} m ` +
        `(射线耗时 ${rayA.ms}ms)`);

    // —— ⑧B 近观位静止 10s ——
    await page.evaluate('window.__QM__.director.exitAuto("probe")');
    await page.evaluate(
      `window.__QM__.flyTo({ position: window.__QM__.spots.find(function (s) { return s.id === "bridge"; }).near,` +
        ` target: window.__QM__.spots.find(function (s) { return s.id === "bridge"; }).target });`,
    );
    await waitSettled(page);
    await sleep(600);
    const nearB = await record(10000, 'near-bridge');
    const stB = stepStats(nearB);
    // 停住的时候判据要换一个:此时 p95 本身就≈0,"2×p95"也跟着≈0,
    // 拿它当阈值会把浮点噪声判成"瞬移"。静止场景要的是**绝对**阈值。
    const drift = Math.max(
      ...nearB.map((s) =>
        Math.hypot(s[2] - nearB[0][2], s[3] - nearB[0][3], s[4] - nearB[0][4]),
      ),
    );
    check('⑧', '近观位停住后相机不再自己走', drift < 0.02 && stB.max < 0.01,
      `最大漂移 ${(drift * 1000).toFixed(2)} mm,单帧最大位移 ${(stB.max * 1000).toFixed(3)} mm`);

    const rayB = await page.evaluate(CLEARANCE_FN(thin(nearB, 6)));
    const clearsB = rayB.rays.filter((r) => r.clear !== null).map((r) => r.clear);
    check('⑧', '近观位脚下有实地、相机在其上方',
      rayB.rays.every((r) => r.clear === null || r.clear > 0),
      `最小净空 ${clearsB.length ? Math.min(...clearsB).toFixed(2) : 'n/a'} m,` +
        `命中物 ${rayB.rays[0]?.hit ?? '(无)'}`);

    // —— ⑧C 从近观位再漫游 10s ——
    //
    // ⚠️ 我原以为这一段是"低空扫掠"、能贴着地面走 —— **实测不是**。
    //    相机高度最低 11.40m,和近观位本身一样高。
    //    原因是 `stepRoam` **只改方位角**:半径与极角在 `startRoam` 里
    //    定下之后就不动了,所以漫游的高度是**恒定**的,从头到尾一条水平圆。
    //    (把这条写下来,是因为"漫游会不会穿地"这个问题的正确答案是
    //     "在漫游这一态里它连高度都不变",而不是"测了十秒没穿"。)
    //
    //    保留这一段仍然有意义:同样一条不变量在另一个半径、另一个目标点上
    //    再验一次,而且它把上面那个"高度恒定"的事实**量出来**了。
    await page.evaluate('window.__QM__.startRoam()');
    const roamC = await record(10000, 'roam-near');
    const stC = stepStats(roamC);
    check('⑧', '换一个半径再漫游,相机仍在移动', stC.path > 1, `累计路程 ${stC.path.toFixed(2)} m`);
    const rayC = await page.evaluate(CLEARANCE_FN(thin(roamC, 12)));
    const clearsC = rayC.rays.filter((r) => r.clear !== null);
    const minC = clearsC.length ? Math.min(...clearsC.map((r) => r.clear)) : NaN;
    const ys = roamC.map((s) => s[3]);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    check('⑧', '漫游的高度是恒定的(只有方位角在变)',
      yMax - yMin < 0.01,
      `高度 ${yMin.toFixed(2)}…${yMax.toFixed(2)} m,极差 ${((yMax - yMin) * 1000).toFixed(1)} mm`);
    check('⑧', '这一段漫游也全程在地面之上',
      clearsC.length >= 10 && clearsC.every((r) => r.clear > 0),
      `最低机位 y=${yMin.toFixed(2)} m,最小净空 ${minC.toFixed(2)} m`);

    await page.screenshot(`${args.out}/ui_12_stability.png`);

    // —— ⑧D 五个景点的全景位与近观位,各打一条 ——
    const poses = await page.evaluate(`(function () {
      var out = [];
      window.__QM__.spots.forEach(function (s) {
        out.push({ id: s.id + ':view', p: s.view, t: s.target });
        out.push({ id: s.id + ':near', p: s.near, t: s.target });
      });
      return out;
    })()`);
    const poseRays = [];
    for (const pose of poses) {
      await page.evaluate(
        `window.__QM__.director.place([${pose.p.join(',')}],[${pose.t.join(',')}]);`,
      );
      await sleep(60);
      const r = await page.evaluate(`(() => {
        var qm = window.__QM__;
        var THREE = qm.THREE;
        var ray = new THREE.Raycaster();
        ray.set(new THREE.Vector3(${pose.p.join(',')}), new THREE.Vector3(0, -1, 0));
        var hits = ray.intersectObjects(qm.scene.children, true);
        return { clear: hits.length ? ${pose.p[1]} - hits[0].point.y : null,
                 hit: hits.length ? (hits[0].object.name || hits[0].object.type) : '' };
      })()`);
      poseRays.push({ id: pose.id, ...r });
    }
    const badPoses = poseRays.filter((r) => r.clear !== null && r.clear <= 0);
    const noHit = poseRays.filter((r) => r.clear === null);
    check(
      '⑧',
      '十个预设机位全部在地面之上',
      badPoses.length === 0,
      `${poseRays.length} 个机位,最小净空 ` +
        `${Math.min(...poseRays.filter((r) => r.clear !== null).map((r) => r.clear)).toFixed(2)} m` +
        (noHit.length ? `,${noHit.length} 个脚下无几何(${noHit.map((r) => r.id).join(',')})` : ''),
    );

    // ================= 溢出检查 =================
    const overflow = await page.evaluate(`(() => {
      const d = document.documentElement;
      return { sw: d.scrollWidth, iw: window.innerWidth,
               sh: d.scrollHeight, ih: window.innerHeight };
    })()`);
    check(
      '布局',
      `桌面 ${args.w}×${args.h} 无横向溢出`,
      overflow.sw <= overflow.iw + 1,
      `scrollWidth=${overflow.sw} innerWidth=${overflow.iw}`,
    );

    // ================= 控制台 =================
    const realErrors = errors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND/i.test(e));
    check('控制台', '无未捕获异常与 console.error', realErrors.length === 0, realErrors.slice(0, 3).join(' / '));

    // —— 汇总 ——
    const pass = results.filter((r) => r.ok).length;
    const fail = results.length - pass;
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`通过 ${pass} / 失败 ${fail} / 共 ${results.length}`);
    if (fail > 0) {
      console.log('\n失败项:');
      for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ [${r.group}] ${r.name} ${r.detail}`);
    }
    console.log(`\n截图已写入 ${args.out}/ui_*.png`);

    // ⚠️ `--json` 不是为了方便看,而是为了**只有一份断言**。
    //    `tests/smoke_flow.mjs` 要给出一张八组总表,如果它把这八组
    //    自己再实现一遍,同一件事就有两份会各自漂移的实现 ——
    //    到时候"哪一份是对的"没人答得上来。所以它读这份 json,
    //    把结果原样并进总表。这一份是唯一的来源。
    if (args.json) {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const out = args.json;
      await mkdir(dirname(out), { recursive: true });
      await writeFile(
        out,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            url: args.url,
            viewport: [args.w, args.h],
            renderer: gpu,
            checks: results,
            summary: { pass, fail, total: results.length },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      console.log(`明细已写入 ${out}`);
    }
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(`\n探针异常终止:${e.message}`);
  process.exit(2);
});
