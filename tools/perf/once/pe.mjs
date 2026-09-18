// 一次性探针:量三维标签到底吃不吃指针事件。
//
// 起因:⑦ 里新加的那条"遮罩盖在标签之上"用的是 elementFromPoint,
// 而 elementFromPoint **看不见 pointer-events:none 的元素** ——
// 如果 .qm-label 是 none,那条断言就永远为真(不能失败的断言不是断言)。
// 所以先量清楚,再决定这条断言该怎么写。
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/';
const { page, close } = await launch({ width: 1600, height: 900 });
try {
  await page.send('Page.navigate', { url: URL });
  let phase = 'noQm';
  for (let i = 0; i < 400; i++) {
    phase = await page.evaluate(
      'window.__QM__ ? window.__QM__.store.read().load.phase : "noQm"',
    );
    if (phase === 'ready') break;
    await sleep(100);
  }
  const out = await page.evaluate(`(() => {
    var phaseNow = window.__QM__ ? window.__QM__.store.read().load.phase : 'noQm';
    function chain(el) {
      var out = [];
      while (el && el !== document.documentElement) {
        out.push(el.tagName.toLowerCase() + '.' + (el.getAttribute('class') || '')
          + ' => pe=' + getComputedStyle(el).pointerEvents);
        el = el.parentElement;
      }
      return out;
    }
    var lb = document.querySelector('.qm-label');
    if (!lb) return { err: 'no .qm-label', phase: phaseNow };
    var r = lb.getBoundingClientRect();
    var cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    var hitRaw = document.elementFromPoint(cx, cy);
    lb.style.pointerEvents = 'auto';
    var hitForced = document.elementFromPoint(cx, cy);
    var forcedIsSelf = hitForced === lb;
    lb.style.pointerEvents = '';
    var labels = document.querySelector('.qm-labels');
    var veil = document.querySelector('.veil');
    return {
      phase: phaseNow,
      labelPE: getComputedStyle(lb).pointerEvents,
      labelIsInteractive: lb.classList.contains('qm-interactive'),
      chain: chain(lb),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      hitRaw: hitRaw ? (hitRaw.getAttribute('class') || hitRaw.tagName) : null,
      hitRawInVeil: Boolean(hitRaw && hitRaw.closest && hitRaw.closest('.veil')),
      forcedHit: forcedIsSelf ? 'SELF(.qm-label)' : (hitForced ? (hitForced.getAttribute('class') || hitForced.tagName) : null),
      forcedHitInVeil: Boolean(hitForced && hitForced.closest && hitForced.closest('.veil')),
      veilZ: veil ? getComputedStyle(veil).zIndex : 'no-veil',
      labelsZ: labels ? getComputedStyle(labels).zIndex : 'no-labels',
      labelZ: getComputedStyle(lb).zIndex,
      veilHidden: veil ? veil.hidden : null,
    };
  })()`);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await close();
}
