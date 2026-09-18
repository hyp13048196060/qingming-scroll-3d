// 一次性探针:CDP 派发的触摸事件**到底有没有到页面里**。
//
// 起因:probe_mobile.mjs 里"触摸点景点按钮 → 相机走"和"画布单指拖动 → 绕行"
// 两条都判失败,位移 0.00 / 0.000 m,而**同一个触摸**点工具栏按钮却真的开了面板。
// 鼠标拖动是好的(阶段 1 的 verify_camera 验过),所以不是相机状态机的问题。
// 猜下去没有意义 —— 直接在页面里挂一圈 capture 监听,看**哪些事件真的来了**。
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/';
const { page, close } = await launch({
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});

const hooks = `
window.__QMEV__ = [];
(function () {
  var kinds = ['pointerdown','pointermove','pointerup','pointercancel',
               'touchstart','touchmove','touchend','click','mousedown','mouseup'];
  for (var i = 0; i < kinds.length; i++) {
    (function (k) {
      document.addEventListener(k, function (e) {
        var t = e.target;
        var cls = t && t.getAttribute ? (t.getAttribute('class') || t.tagName) : String(t);
        window.__QMEV__.push(k + ' pe=' + (e.pointerType === undefined ? '-' : e.pointerType)
          + ' @' + cls);
      }, true);
    })(kinds[i]);
  }
})();
`;

try {
  await page.send('Page.navigate', { url: URL });
  await page.waitForReady();
  await sleep(600);
  await page.evaluate(hooks);

  const env = await page.evaluate(`(() => ({
    ontouchstart: 'ontouchstart' in window,
    maxTouchPoints: navigator.maxTouchPoints,
    pointerTouch: (window.PointerEvent ? PointerEvent.prototype.constructor.name : 'no-PE'),
    stageTouchAction: getComputedStyle(document.querySelector('#stage')).touchAction,
    stagePE: getComputedStyle(document.querySelector('#stage')).pointerEvents,
  }))()`);
  console.log('环境:', JSON.stringify(env));

  // —— A. 触摸点景点按钮 ——
  const box = await page.evaluate(`(() => {
    var el = document.querySelector('.qm-spotnav__btn');
    var r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, cls: el.getAttribute('class'),
             hit: (function () { var t = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
                                 return t ? (t.getAttribute('class') || t.tagName) : null; })() };
  })()`);
  console.log('景点按钮:', JSON.stringify(box));
  await page.evaluate('window.__QMEV__ = []');
  const before = await page.evaluate('window.__QM__.camera.position.toArray()');
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
  await sleep(60);
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(900);
  const evA = await page.evaluate('window.__QMEV__.slice()');
  const afterA = await page.evaluate('window.__QM__.camera.position.toArray()');
  console.log('A 触摸景点按钮 → 事件:', evA.join(' | ') || '(一个都没来)');
  console.log('A 相机:', before.map((v) => v.toFixed(2)).join(','), '→', afterA.map((v) => v.toFixed(2)).join(','));

  // —— B. 触摸画布并拖动 ——
  await page.evaluate('window.__QMEV__ = []');
  const b = await page.evaluate('window.__QM__.camera.position.toArray()');
  const cx = 195, cy = 354;
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
  for (let i = 1; i <= 6; i++) {
    await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + i * 16, y: cy + i * 4 }] });
    await sleep(24);
  }
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(600);
  const evB = await page.evaluate('window.__QMEV__.slice()');
  const afterB = await page.evaluate('window.__QM__.camera.position.toArray()');
  console.log('B 画布拖动 → 事件:', evB.slice(0, 12).join(' | ') || '(一个都没来)',
    evB.length > 12 ? `… 共 ${evB.length} 条` : '');
  console.log('B 相机:', b.map((v) => v.toFixed(2)).join(','), '→', afterB.map((v) => v.toFixed(2)).join(','));

  // —— C. 对照:鼠标在画布上拖同样的距离 ——
  await page.evaluate('window.__QMEV__ = []');
  const c = await page.evaluate('window.__QM__.camera.position.toArray()');
  await page.mouse('mousePressed', cx, cy);
  for (let i = 1; i <= 6; i++) {
    await page.mouse('mouseMoved', cx + i * 16, cy + i * 4);
    await sleep(24);
  }
  await page.mouse('mouseReleased', cx + 96, cy + 24);
  await sleep(400);
  const evC = await page.evaluate('window.__QMEV__.slice()');
  const afterC = await page.evaluate('window.__QM__.camera.position.toArray()');
  console.log('C 鼠标拖动 → 事件:', evC.slice(0, 8).join(' | ') || '(一个都没来)');
  console.log('C 相机:', c.map((v) => v.toFixed(2)).join(','), '→', afterC.map((v) => v.toFixed(2)).join(','));
} finally {
  await close();
}
