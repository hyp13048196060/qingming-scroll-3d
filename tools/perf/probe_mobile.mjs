/**
 * 阶段 3 出口的**第二套尺寸**:手机竖屏 390×844。
 *
 * 验收要求是「桌面 1600×900 与移动 390×844 两套截图无溢出」。
 * `probe_ui.mjs` 跑的是桌面那一套(它的 86 条断言都在 1600×900 上成立,
 * 包括三维标签的命中测试、舆图坐标、进度条宽度),换个尺寸重跑它既慢、
 * 又会让那些**与尺寸无关**的断言跟着一起变红,反倒看不清是哪一层的问题。
 *
 * 所以这里只量**窄屏专有**的几件事,一件不多:
 *   1. 没有横向溢出(整页级)
 *   2. 三块界面(topbar / panelhost / toolbar)互不重叠、且都在视口内
 *   3. 窄屏断点确实生效(否则"没溢出"可能只是因为规则压根没命中)
 *   4. 每一个可见按钮的**中心点命中的是它自己**(手机上控件挤成一团时
 *      最容易出的问题就是"按钮画在那儿但点不到")
 *   5. **触摸**真的能操作:点景点 → 相机走;点工具栏 → 面板开;
 *      在画布上单指拖动 → 相机绕行
 *
 * ⚠️ 第 4、5 两条是这一套里最要紧的。390px 宽下工具栏会折成两行
 *    (responsive.css 的 ≤420px 规则),两行按钮之间、以及按钮与
 *    面板容器之间的位置关系全变了 —— 而"看起来正常、实际点不到"
 *    恰恰是布局改动最容易留下的病,也正是本阶段"无无响应装饰控件"
 *    要防的东西。所以这两条用**真实触摸事件**(Input.dispatchTouchEvent)
 *    而非 element.click() —— 后者绕过命中测试,点不到也报成功。
 *
 * 用法:
 *   node tools/perf/probe_mobile.mjs --url http://127.0.0.1:4173/ \
 *        --out screenshots/mobile --json screenshots/perf/probe_mobile.json
 */
import { launch, sleep } from './lib/cdp.mjs';

function parseArgs(argv) {
  const a = {
    url: 'http://127.0.0.1:4173/',
    out: 'screenshots/mobile',
    w: 390,
    h: 844,
    dpr: 2,
    json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--url') a.url = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--json') a.json = argv[++i];
    else if (k === '--w') a.w = Number(argv[++i]);
    else if (k === '--h') a.h = Number(argv[++i]);
    else if (k === '--dpr') a.dpr = Number(argv[++i]);
    else if (k === '--help' || k === '-h') {
      console.log(
        '用法: node tools/perf/probe_mobile.mjs [--url URL] [--out 目录] [--w 390] [--h 844] [--dpr 2] [--json 结果.json]',
      );
      process.exit(0);
    }
  }
  return a;
}

const results = [];
function check(group, name, ok, detail = '') {
  results.push({ group, name, ok: Boolean(ok), detail });
}

/**
 * 取一个元素的矩形 + 它中心点上真正被谁命中。
 *
 * ⚠️ `hitSelf` 用 `closest(sel)` 而不是"是不是同一个元素":
 *    按钮里套着 `<span>` 文字是常态,点在文字上命中的是 span,
 *    但浏览器会把这个事件交给按钮 —— 那仍然叫点得到。
 */
const BOX_FN = (sel) => `(() => {
  var el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  var r = el.getBoundingClientRect();
  var cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  var top = document.elementFromPoint(cx, cy);
  return { x: cx, y: cy, w: r.width, h: r.height,
           left: r.x, top: r.y, right: r.right, bottom: r.bottom,
           hit: top ? (top.getAttribute('class') || top.tagName) : null,
           hitSelf: Boolean(top && top.closest(${JSON.stringify(sel)})) };
})()`;

const box = (page, sel) => page.evaluate(BOX_FN(sel));

/** 派发一对真实触摸事件(按下 → 抬起)。 */
async function touchTap(page, x, y) {
  await page.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  await sleep(60);
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * 中心点可命中才按下;返回矩形,不满足条件一律抛错。
 *
 * ⚠️ 三道关口一道都不能省 —— 少一道,这个助手就会**谎报成功**。
 *    第一版只判了"元素存不存在",于是它在一个 `hidden=true`、
 *    尺寸 `0×0` 的按钮上"成功"派发了一次 (0,0) 的触摸:
 *    调用方以为面板被关掉了,面板其实还开着,两条后续断言跟着变红。
 *    一个会谎报成功的仪表比没有仪表更坏 —— 它把"没做"写成"做了"。
 *
 *    三道关口分别是:元素存在 / 尺寸非零 / **中心点上命中的是它自己**。
 *    第三道用 `closest(sel)`:按钮里套着 `<span>` 文字是常态,点在文字上
 *    命中的是 span,而浏览器会把这次点击交给按钮 —— 那仍然叫点得到。
 */
async function touchClick(page, sel, desc) {
  const r = await box(page, sel);
  if (!r) throw new Error(`触摸点不到「${desc}」:页面上没有 ${sel}`);
  if (r.w < 1 || r.h < 1) {
    throw new Error(
      `触摸点不到「${desc}」:${sel} 尺寸 ${r.w.toFixed(0)}×${r.h.toFixed(0)}(多半是隐藏的),实际摸不到`,
    );
  }
  if (r.x < 0 || r.y < 0 || r.x > 10000 || r.y > 10000) {
    throw new Error(`触摸点不到「${desc}」:中心 (${r.x.toFixed(0)},${r.y.toFixed(0)}) 不在页面里`);
  }
  if (!r.hitSelf) {
    throw new Error(`触摸点不到「${desc}」:(${r.x.toFixed(0)},${r.y.toFixed(0)}) 上的是 ${r.hit}`);
  }
  await touchTap(page, r.x, r.y);
  return r;
}

const camPos = (page) =>
  page.evaluate(
    '(() => { var p = window.__QM__.camera.position; return [p.x, p.y, p.z]; })()',
  );

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { page, close, browserVersion } = await launch({
    width: args.w,
    height: args.h,
    deviceScaleFactor: args.dpr,
    mobile: true,
  });
  const errors = page.collectErrors();

  try {
    await page.setViewport({
      width: args.w,
      height: args.h,
      deviceScaleFactor: args.dpr,
      mobile: true,
    });
    await page.goto(args.url);
    await page.waitForReady();
    await sleep(800);

    console.log(
      `\n视口 ${args.w}×${args.h} @${args.dpr}x(mobile)  ${browserVersion}\n` +
        '─'.repeat(72),
    );

    // —— ① 有没有横向溢出 ——
    //
    // 量的是**整页**:documentElement 的 scrollWidth。
    // ⚠️ 不能拿某个元素的 scrollWidth 当溢出判据:顶栏里的景点条在窄屏上
    //    是**故意**做成横向滚动**的(responsive.css ≤720px 那条),
    //    它的 scrollWidth 本来就大于 clientWidth。那是设计,不是溢出。
    const ovf = await page.evaluate(`(() => {
      var de = document.documentElement;
      return { scrollW: de.scrollWidth, innerW: window.innerWidth,
               bodyScrollW: document.body.scrollWidth,
               bodyOverflowX: getComputedStyle(document.body).overflowX,
               spotnav: (function () {
                 var s = document.querySelector('.qm-spotnav');
                 if (!s) return null;
                 return { scrollW: s.scrollWidth, clientW: s.clientWidth,
                          overflowX: getComputedStyle(s).overflowX };
               })() };
    })()`);
    check(
      '响应式',
      `页面在 ${args.w}px 宽下没有横向溢出`,
      ovf.scrollW <= ovf.innerW && ovf.bodyScrollW <= ovf.innerW,
      `documentElement ${ovf.scrollW} / body ${ovf.bodyScrollW} / innerWidth ${ovf.innerW}`,
    );
    // 上面那条要成立,靠的是"景点条自己滚"而不是"整页跟着滚"。
    //
    // ⚠️ 判据只写 `overflow-x` 是不是 auto/scroll,**不能**要求"内容确实溢出"。
    //    第一版就是那么写的,结果红了:
    //        overflow-x=auto,内容 366 / 可视 366
    //    390px 下五个景点按钮**正好排得下**,没有东西可滚 —— 那是好事。
    //    我当时把"当前恰好不溢出"当成了要求,于是在页面没毛病的地方判了失败。
    //    要守的不变量是"**允许**滚动而不是把整页撑宽",不是"必须溢出"。
    check(
      '响应式',
      '景点条允许自己横滚(窄下去时不把整页撑宽)',
      Boolean(ovf.spotnav) && ['auto', 'scroll'].includes(ovf.spotnav.overflowX),
      ovf.spotnav
        ? `overflow-x=${ovf.spotnav.overflowX},内容 ${ovf.spotnav.scrollW} / 可视 ${ovf.spotnav.clientW}` +
          `(当前${ovf.spotnav.scrollW > ovf.spotnav.clientW ? '需要滚动' : '排得下,无需滚动'})`
        : '(无景点条)',
    );
    await page.screenshot(`${args.out}/mobile_01_default.png`);

    // —— ② 三块界面互不重叠、且都在视口内 ——
    //
    // ⚠️ 这条对应 responsive.css 开头那段警告:三块是**垂直叠放**的,
    //    面板的 top/bottom 是写死的数值,所以"顶栏变两行"会把面板压住。
    //    用**实测矩形**做关系判断,而不是回读我自己写的那几个 px 值 ——
    //    回读 CSS 只能证明"我写的是 A",量矩形才能证明"排出来确实是 A"。
    const blocks = await page.evaluate(`(() => {
      function r(sel) {
        var el = document.querySelector(sel);
        if (!el) return null;
        var b = el.getBoundingClientRect();
        return { sel: sel, top: b.top, bottom: b.bottom, left: b.left, right: b.right,
                 h: b.height, w: b.width };
      }
      return { topbar: r('.qm-topbar'), host: r('.qm-panelhost'),
               toolbar: r('.qm-toolbar'), canvas: r('#stage') };
    })()`);
    const bl = ['topbar', 'host', 'toolbar'].map((k) => blocks[k]).filter(Boolean);
    check(
      '响应式',
      '顶栏 / 面板区 / 工具栏都在视口内',
      bl.length === 3 &&
        bl.every(
          (b) => b.left >= -0.5 && b.right <= args.w + 0.5 && b.top >= -0.5 && b.bottom <= args.h + 0.5,
        ),
      bl
        .map(
          (b) =>
            `${b.sel} y ${b.top.toFixed(0)}–${b.bottom.toFixed(0)} x ${b.left.toFixed(0)}–${b.right.toFixed(0)}`,
        )
        .join(' | '),
    );
    const tb = blocks.topbar;
    const host = blocks.host;
    const tlb = blocks.toolbar;
    check(
      '响应式',
      '面板区没有被顶栏或工具栏压住(两者的实测矩形不相交)',
      Boolean(tb && host && tlb) && host.top >= tb.bottom - 0.5 && host.bottom <= tlb.top + 0.5,
      `顶栏底 ${tb?.bottom.toFixed(0)} ≤ 面板区顶 ${host?.top.toFixed(0)};` +
        `面板区底 ${host?.bottom.toFixed(0)} ≤ 工具栏顶 ${tlb?.top.toFixed(0)}`,
    );
    // 窄屏断点到底生效没有。生效的样子:顶栏竖排、工具栏竖排(≤420px 那一条)。
    const layout = await page.evaluate(`(() => ({
      topbarDir: getComputedStyle(document.querySelector('.qm-topbar')).flexDirection,
      toolbarDir: getComputedStyle(document.querySelector('.qm-toolbar')).flexDirection,
      toolbarH: document.querySelector('.qm-toolbar').getBoundingClientRect().height,
      hostLeft: getComputedStyle(document.querySelector('.qm-panelhost')).left,
    }))()`);
    check(
      '响应式',
      '窄屏断点确实命中(否则"没溢出"可能只是规则没生效)',
      layout.topbarDir === 'column' && layout.toolbarDir === 'column',
      `顶栏 ${layout.topbarDir} / 工具栏 ${layout.toolbarDir}(高 ${layout.toolbarH.toFixed(0)}px),` +
        `面板区 left=${layout.hostLeft}`,
    );
    check(
      '响应式',
      '三维画布仍然铺满整个视口(没有被界面挤小)',
      Boolean(blocks.canvas) &&
        Math.abs(blocks.canvas.w - args.w) < 1.5 &&
        Math.abs(blocks.canvas.h - args.h) < 1.5,
      blocks.canvas
        ? `画布 ${blocks.canvas.w.toFixed(0)}×${blocks.canvas.h.toFixed(0)}`
        : '(无画布)',
    );

    // —— ③ 每个可见按钮的中心点,命中的是不是它自己 ——
    const hits = await page.evaluate(`(() => {
      var sels = ['.qm-spotnav__btn', '.qm-toolbar__btn', '.qm-label'];
      var out = [];
      for (var s = 0; s < sels.length; s++) {
        var list = document.querySelectorAll(sels[s]);
        for (var i = 0; i < list.length; i++) {
          var el = list[i];
          if (el.hidden) continue;
          var r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;   // 隐藏的跳过
          var cx = r.x + r.width / 2, cy = r.y + r.height / 2;
          if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
            out.push({ sel: sels[s], i: i, text: (el.textContent || '').trim().slice(0, 12),
                       why: '中心点在视口外', cx: cx, cy: cy });
            continue;
          }
          var top = document.elementFromPoint(cx, cy);
          var inside = Boolean(top && top.closest(sels[s]));
          var inVeil = Boolean(top && top.closest && top.closest('.veil'));
          out.push({ sel: sels[s], i: i, text: (el.textContent || '').trim().slice(0, 12),
                     ok: inside || inVeil, why: inside ? 'self' : (inVeil ? 'veil' : 'blocked'),
                     cx: Math.round(cx), cy: Math.round(cy) });
        }
      }
      return out;
    })()`);
    const blocked = hits.filter((h) => !h.ok);
    const byKind = {};
    for (const h of hits) byKind[h.sel] = (byKind[h.sel] ?? 0) + 1;
    check(
      '响应式',
      '窄屏上每个可见控件都点得到(中心点命中它自己)',
      hits.length >= 6 && blocked.length === 0,
      `检查了 ${hits.length} 个(${Object.entries(byKind)
        .map(([k, v]) => `${k}×${v}`)
        .join(', ')}),` +
        (blocked.length
          ? `被挡住 ${blocked.length} 个:${blocked
              .map((b) => `「${b.text}」${b.why}@(${b.cx},${b.cy})`)
              .join(' ')}`
          : '全部可点'),
    );

    // —— ④ 触摸真的能操作 ——
    //
    // ⚠️ 这一段的判据被改过一次,改的原因值得记下来。
    //
    // 第一版写的是「触摸点景点按钮 → 相机位移 > 0.5m」,实测 **0.00 m**,判失败。
    // 但把事件打出来看,点击**是送到了**(pointerdown→touchstart→…→click,
    // 目标就是那个按钮),于是问题变成"为什么点了却不动"。
    // 翻源码才看见 UIRoot.ts 里那行注释:
    //     点这里**不移动相机** —— 想移动要点面板里的【走近看看】。
    // 也就是说**按设计它就不该动** —— 是我的判据在要求一件作品明确不做的事。
    // (顺带解释"恰好 0.00 m":第一个景点按钮是虹桥,而默认机位本来就是虹桥机位,
    //  就算它真飞,也是飞到自己脚下。)
    //
    // 所以这里改成按设计逐段验:点景点 → 开简介面板;点【走近看看】→ 相机到位。
    // 两条都判,缺一条都会让"触摸能不能用"变成半个结论。
    const curSpot = await page.evaluate('window.__QM__.store.read().ui.selected');
    let tapped = null;
    try {
      tapped = await touchClick(page, '.qm-spotnav__btn[data-spot="boat"]', '漕船按钮');
    } catch (e) {
      check('响应式', '触摸点景点按钮', false, e.message);
    }
    if (tapped) {
      await sleep(700);
      const snap = await page.evaluate('window.__QM__.uiSnapshot()');
      const title = await page.evaluate(
        `(document.querySelector('.qm-panel--spot .qm-panel__title') || {}).textContent || ''`,
      );
      check(
        '响应式',
        '触摸点景点按钮,简介面板真的开了(且开的是点的那个景点)',
        String(snap.panelVisible).includes('spot') &&
          snap.selected === 'boat' &&
          title.includes('漕船'),
        `panelVisible=${snap.panelVisible} selected=${snap.selected}(点前 ${curSpot}) 标题「${title.trim()}」`,
      );

      // 再从面板里点【走近看看】—— 这一步才该让相机走
      const boat = await page.evaluate(
        'window.__QM__.spots.find(function (s) { return s.id === "boat"; })',
      );
      const before = await camPos(page);
      let near = null;
      try {
        near = await touchClick(page, '.qm-panel--spot .qm-btn--primary', '走近看看');
      } catch (e) {
        check('响应式', '触摸点【走近看看】', false, e.message);
      }
      if (near) {
        // 等补间结束再量,否则量到的是"还在半路上"
        let moved = 0;
        for (let i = 0; i < 40; i++) {
          await sleep(200);
          const p = await camPos(page);
          moved = Math.hypot(p[0] - before[0], p[1] - before[1], p[2] - before[2]);
          const mode = await page.evaluate('window.__QM__.cameraSnapshot().mode');
          if (mode === 'orbit' && moved > 0.5) break;
        }
        const now = await camPos(page);
        const err = Math.hypot(
          now[0] - boat.near[0],
          now[1] - boat.near[1],
          now[2] - boat.near[2],
        );
        check(
          '响应式',
          '触摸点【走近看看】,相机走到了该景点的机位',
          moved > 0.5 && err < 0.25,
          `位移 ${moved.toFixed(2)} m,与漕船机位相差 ${err.toFixed(3)} m` +
            `(触摸点 ${near.x.toFixed(0)},${near.y.toFixed(0)})`,
        );
      }
    }

    // 触摸开面板:挑一个工具栏按钮,验的是"手机上打开面板"这条路
    let panelRect = null;
    try {
      const tr = await touchClick(page, '.qm-toolbar__btn[data-panel="basis"]', '依据按钮');
      await sleep(700);
      const snap = await page.evaluate('window.__QM__.uiSnapshot()');
      check(
        '响应式',
        '触摸点工具栏按钮,面板真的开了',
        String(snap.panelVisible).includes('basis'),
        `panelVisible=${snap.panelVisible}(触摸点 ${tr.x.toFixed(0)},${tr.y.toFixed(0)})`,
      );
      panelRect = await page.evaluate(`(() => {
        var el = document.querySelector('.qm-panel--basis');
        if (!el) return null;
        var b = el.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right,
                 w: b.width, h: b.height,
                 bodyScroll: (function () {
                   var bd = el.querySelector('.qm-panel__body');
                   return bd ? { sh: bd.scrollHeight, ch: bd.clientHeight,
                                 oy: getComputedStyle(bd).overflowY } : null;
                 })() };
      })()`);
      await page.screenshot(`${args.out}/mobile_02_panel.png`);
      check(
        '响应式',
        '面板在窄屏上没有超出视口',
        Boolean(panelRect) &&
          panelRect.left >= -0.5 &&
          panelRect.right <= args.w + 0.5 &&
          panelRect.top >= -0.5 &&
          panelRect.bottom <= args.h + 0.5,
        panelRect
          ? `面板 ${panelRect.w.toFixed(0)}×${panelRect.h.toFixed(0)} ` +
            `x ${panelRect.left.toFixed(0)}–${panelRect.right.toFixed(0)} ` +
            `y ${panelRect.top.toFixed(0)}–${panelRect.bottom.toFixed(0)}`
          : '(找不到 .qm-panel--basis)',
      );
      // 内容比可视区高的时候,必须能滚 —— 否则手机上有一段文字永远看不到。
      // ⚠️ 只在"确实超高"时才要求可滚;不超高时这条不成立也不该判失败,
      //    所以把实测数字印出来,让"没触发"和"触发了但不可滚"看得出区别。
      const bs = panelRect?.bodyScroll;
      check(
        '响应式',
        '面板内容超高时可滚动(内容看不全又不能滚 = 手机上永远读不到)',
        // ⚠️ 这里**不写** `!bs ||` —— 那样"面板压根没有 body"也算过。
        //    没有 body 本身就是坏消息,应该红。
        Boolean(bs) && (bs.sh <= bs.ch + 1 || ['auto', 'scroll'].includes(bs.oy)),
        bs
          ? `内容 ${bs.sh} / 可视 ${bs.ch} px,overflow-y=${bs.oy}`
          : '(面板里找不到 .qm-panel__body)',
      );
    } catch (e) {
      check('响应式', '触摸点工具栏按钮,面板真的开了', false, e.message);
    }

    // —— ⑤ 画布上单指拖动 = 绕行 ——
    //
    // `#stage { touch-action: none }` 是把触摸手势让给 OrbitControls 的写法,
    // 所以这里必须用**真触摸**验:鼠标事件走的是另一条分支,
    // 拿鼠标验过不能说明手指也能转。
    //
    // ⚠️ 两件事要先处理干净,否则量到的是别的东西(第一版两条都踩了):
    //
    //  1. 上一步为了验"触摸开面板",把简介面板留在了屏幕上 —— 它盖住中间
    //     一大片(x 8–382,y 104–692),站在它上面拖当然不动。所以先把面板收掉:
    //     用**触摸点面板上的「关闭」**而不是调试 API —— 既收干净了,又顺手
    //     多验了一条"关闭按钮在手机上点得到"(调试 API 里也没有 closePanel,
    //     我第一版写的 `__QM__.actions.closePanel()` 直接把探针崩了)。
    //     收完**验证它确实收掉了**再往下量。
    //
    //     关的时候要认**当前开着的那一个**,不能写死 `.qm-panel--spot`:
    //     上一步点工具栏开的已经是「依据」,「简介」那时是 hidden 的。
    //     实测(一次性探针 tools/perf/once/panels.mjs)确认作品这边没问题 ——
    //     panelhost 的五个面板**任何时刻最多只有一个** hidden=false,
    //     开「依据」会把「简介」收掉。坏的是我这个助手:它当时不检查元素尺寸,
    //     在一个 0×0 的隐藏按钮上"成功"点了一下,回头却什么都没发生。
    //
    //  2. 三维标签是 `.qm-interactive`,落在标签上的 pointerdown 会被它吃掉 ——
    //     这是设计(标签要能点),不是 bug;但它意味着**起手点压在标签上的拖动
    //     不会转相机**。第一版的起手点正好落在「虹桥」标签上(43×21px),
    //     于是量到 0.000 m,差点被当成"手机上转不动"。
    //     所以要**先扫一遍屏幕**,挑一个"最上面确实是画布"的起手点;
    //     顺手把"画布仍占屏幕主体"变成一条断言 —— 真有铺满全屏的遮挡物,
    //     这条会立刻变红,而不是等拖动莫名其妙不动了才回头查。
    // 关掉**当前开着的那一个**(最多循环几次,顺带量了"一次只开一个"这个不变量)
    let closedHow = '无面板可关';
    for (let i = 0; i < 4; i++) {
      const open = await page.evaluate(`(() => {
        var host = document.querySelector('.qm-panelhost');
        var v = Array.from(host.children).filter(function (c) { return !c.hidden; });
        return v.length ? v[0].getAttribute('class') : null;
      })()`);
      if (!open) {
        closedHow = `关了 ${i} 个`;
        break;
      }
      await touchClick(
        page,
        '.qm-panelhost > .qm-panel:not([hidden]) .qm-btn--ghost',
        `「${open.replace('qm-panel qm-panel--', '').split(' ')[0]}」面板的关闭`,
      );
      await sleep(400);
    }
    const openPanels = await page.evaluate(`(() => {
      var host = document.querySelector('.qm-panelhost');
      return host
        ? Array.from(host.children).filter(function (c) { return !c.hidden; }).length
        : -1;
    })()`);
    check(
      '响应式',
      '量拖动前面板已收起(否则量的是面板,不是画布)',
      openPanels === 0,
      `panelhost 里还有 ${openPanels} 个面板可见(${closedHow})`,
    );

    const grid = await page.evaluate(`(() => {
      var pts = [];
      for (var i = 1; i <= 5; i++) {
        for (var j = 1; j <= 6; j++) {
          var x = Math.round(window.innerWidth * i / 6);
          var y = Math.round(window.innerHeight * j / 7);
          var el = document.elementFromPoint(x, y);
          pts.push({ x: x, y: y,
                     owner: !el ? 'none'
                       : el.tagName === 'CANVAS' ? 'canvas'
                       : (el.getAttribute('class') || el.tagName) });
        }
      }
      return pts;
    })()`);
    const canvasPts = grid.filter((p) => p.owner === 'canvas');
    const owners = {};
    for (const p of grid) if (p.owner !== 'canvas') owners[p.owner] = (owners[p.owner] ?? 0) + 1;
    check(
      '响应式',
      '窄屏上画布仍是可触区域的主体(标签只占少数小岛)',
      canvasPts.length >= Math.round(grid.length * 0.6),
      `${canvasPts.length}/${grid.length} 个采样点最上面是画布` +
        (Object.keys(owners).length
          ? `;其余:${Object.entries(owners)
              .map(([k, v]) => `${k}×${v}`)
              .join(', ')}`
          : ''),
    );

    // 起手点取**最靠近屏幕中心**的那个画布点
    const mid = { x: args.w / 2, y: args.h / 2 };
    const start = canvasPts
      .slice()
      .sort(
        (a, b) => Math.hypot(a.x - mid.x, a.y - mid.y) - Math.hypot(b.x - mid.x, b.y - mid.y),
      )[0];
    if (!start) {
      check('响应式', '画布上单指拖动,相机跟着绕行', false, '屏幕上找不到一个最上面是画布的点');
    } else {
      const beforeDrag = await camPos(page);
      await page.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: start.x, y: start.y }],
      });
      for (let i = 1; i <= 8; i++) {
        await page.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: start.x + i * 12, y: start.y + i * 4 }],
        });
        await sleep(24);
      }
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(500);
      const afterDrag = await camPos(page);
      const dragged = Math.hypot(
        afterDrag[0] - beforeDrag[0],
        afterDrag[1] - beforeDrag[1],
        afterDrag[2] - beforeDrag[2],
      );
      check(
        '响应式',
        '画布上单指拖动,相机跟着绕行',
        dragged > 0.2,
        `位移 ${dragged.toFixed(3)} m(起手点 ${start.x},${start.y},最上面是画布)`,
      );
    }
    await page.screenshot(`${args.out}/mobile_03_drag.png`);

    // —— ⑥ 控制台 ——
    // collectErrors() 返回的是**数组本身**(边跑边往里 push),不是取数方法
    const errs = errors;
    check(
      '响应式',
      '窄屏下无未捕获异常与 console.error',
      errs.length === 0,
      errs.length ? errs.slice(0, 3).join(' | ') : '(无)',
    );
  } finally {
    await close();
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} [${r.group}] ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`);
  }
  console.log('\n' + '─'.repeat(72));
  console.log(`通过 ${pass} / 失败 ${fail} / 共 ${results.length}`);
  console.log(`截图已写入 ${parseArgs(process.argv.slice(2)).out}/mobile_*.png`);

  if (args.json) {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname, resolve } = await import('node:path');
    const p = resolve(process.cwd(), args.json);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(
      p,
      JSON.stringify(
        { checks: results, summary: { pass, fail, total: results.length } },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`明细已写入 ${args.json}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

await main();
