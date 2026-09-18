// 一次性探针:390×844 下,屏幕中间那一片**到底被谁盖住了**。
//
// 上一步量到:画布上拖鼠标/拖手指,事件目标都是 `<li>`,不是 canvas;
// 连鼠标拖动都没能绕行(而桌面 1600×900 下 verify_camera 验过鼠标是好的)。
// 所以这里把中间那几个点上的元素按**命中顺序**列出来,看是谁在上面。
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/';
const { page, close } = await launch({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

const AT = (x, y) => `(() => {
  var list = document.elementsFromPoint(${x}, ${y});
  return {
    x: ${x}, y: ${y},
    stack: list.slice(0, 8).map(function (el) {
      var r = el.getBoundingClientRect();
      return el.tagName.toLowerCase() + '.' + (el.getAttribute('class') || '')
        + '[pe=' + getComputedStyle(el).pointerEvents
        + ',z=' + getComputedStyle(el).zIndex
        + ',xywh=' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + ',' + Math.round(r.height)
        + ']' + (el.closest('.qm-labels') ? ' <LABELS>' : '');
    }),
  };
})()`;

try {
  await page.send('Page.navigate', { url: URL });
  await page.waitForReady();
  await sleep(800);
  for (const [x, y] of [
    [195, 354],
    [195, 500],
    [195, 700],
    [60, 400],
    [330, 400],
  ]) {
    const r = await page.evaluate(AT(x, y));
    console.log(`\n=== (${r.x},${r.y}) 命中顺序(上→下)===`);
    for (const s of r.stack) console.log('   ' + s);
  }
  const labels = await page.evaluate(`(() => {
    var c = document.querySelector('.qm-labels');
    return { tag: c ? c.tagName : null, html: c ? c.outerHTML.slice(0, 260) : null,
             pe: c ? getComputedStyle(c).pointerEvents : null,
             z: c ? getComputedStyle(c).zIndex : null };
  })()`);
  console.log('\n.qm-labels 容器:', JSON.stringify(labels, null, 1));
} finally {
  await close();
}
