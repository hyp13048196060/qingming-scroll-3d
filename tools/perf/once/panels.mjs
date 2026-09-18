// 一次性探针:面板到底能不能**同时**开着两个。
//
// 起因:probe_mobile 的 ⑤ 里,我点掉「简介」面板的关闭按钮之后,panelhost 里
// **还剩一个面板可见**,而且采样点命中的全是 `.qm-basis__*`(依据面板)。
// 两种可能:①我关错了面板;②真的能开两个、互相叠着。
// ②是实害(点一下开了面板,却藏在另一个后面),所以必须量清楚,不能猜。
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/';
const { page, close } = await launch({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

const PANELS = `(() => {
  var host = document.querySelector('.qm-panelhost');
  return Array.from(host.children).map(function (c, i) {
    var r = c.getBoundingClientRect();
    return { i: i, cls: (c.getAttribute('class') || ''), hidden: c.hidden,
             pe: getComputedStyle(c).pointerEvents,
             rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
  });
})()`;

async function show(page, tag) {
  const out = await page.evaluate(PANELS);
  console.log(`\n=== ${tag} ===`);
  for (const p of out) {
    console.log(
      `  #${p.i} ${p.cls}  hidden=${p.hidden} pe=${p.pe} rect=${p.rect.join(',')}`,
    );
  }
  const vis = await page.evaluate('window.__QM__.uiSnapshot().panelVisible');
  console.log(`  uiSnapshot.panelVisible = ${vis}`);
}

const tap = async (page, sel) => {
  const b = await page.evaluate(`(() => {
    var el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!b || b.w < 1) {
    console.log(`  (点不到 ${sel}:${b ? b.w + '×' + b.h : '不存在'})`);
    return false;
  }
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y }] });
  await sleep(60);
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
  return true;
};

try {
  await page.send('Page.navigate', { url: URL });
  await page.waitForReady();
  await sleep(700);
  await show(page, '初始');

  await tap(page, '.qm-spotnav__btn[data-spot="boat"]');
  await show(page, '触摸点景点「漕船」之后');

  await tap(page, '.qm-panel--spot .qm-btn--primary');
  await sleep(2200);
  await show(page, '触摸点【走近看看】之后(补间已走完)');

  await tap(page, '.qm-toolbar__btn[data-panel="basis"]');
  await show(page, '触摸点工具栏「依据」之后');

  await tap(page, '.qm-panel--spot .qm-btn--ghost');
  await show(page, '触摸点「简介」面板的关闭之后');
} finally {
  await close();
}
