/**
 * 校验随包发布的楷体字体**真的在用**。
 *
 * 为什么需要这个检查:字体回退是全程静默的 —— woff2 没打包、URL 写错、
 * 子集漏了字,浏览器都不会报错,只是换一款系统字体把字画出来。页面看上去
 * "有字",可它与设计稿不是一回事。这类"看着正常"的失败在本项目里栽过多次,
 * 所以凡是能静默通过的地方都要有人真的去查一遍。
 *
 * 用系统 Chrome(见 tools/perf/lib/cdp.mjs 的说明),不下载 Chromium。
 *
 * 跑法(和别的探针一样,不自己起服务):
 *     node scripts/serve-dist.mjs --dir dist --port 4173 &
 *     node tools/check_fonts.mjs http://127.0.0.1:4173/
 */
import { launch, sleep } from './perf/lib/cdp.mjs';

const url = process.argv[2] || 'http://127.0.0.1:4173/';

/** 界面里一定会出现的字:标题、按钮、面板。取几个够判定就行。 */
const SAMPLE = '清明上河图虹桥胜景汴河漕运';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}

const { page, close, browserVersion } = await launch({ width: 1280, height: 720 });
try {
  console.log(`浏览器: ${browserVersion}`);
  console.log(`地址:   ${url}\n`);

  await page.goto(url);
  await sleep(8000); // 等模型加载完 + 字体下完(font-display: swap 是异步的)

  // ---- 1. 字体表里有没有这两个 face,状态是不是 loaded ----
  const faces = await page.evaluate(() => {
    const out = [];
    document.fonts.forEach((f) => out.push({ family: f.family, weight: f.weight, status: f.status }));
    return out;
  });
  const wenkai = faces.filter((f) => f.family.replace(/["']/g, '') === 'LXGW WenKai');
  check(
    '@font-face 已注册两个字重',
    wenkai.length === 2,
    wenkai.length ? JSON.stringify(wenkai) : `字体表里没有 LXGW WenKai(共 ${faces.length} 个 face)`,
  );

  const loaded = wenkai.filter((f) => f.status === 'loaded');
  check('两个 face 状态均为 loaded', loaded.length === 2, `loaded ${loaded.length}/${wenkai.length}`);

  // ---- 2. 字体文件真的下载成功了吗 ----
  const fontReqs = await page.evaluate(() => {
    return performance
      .getEntriesByType('resource')
      .filter((e) => /\.woff2?(\?|$)/.test(e.name))
      .map((e) => ({
        url: e.name.split('/').pop(),
        bytes: e.transferSize || e.decodedBodySize || 0,
        ms: Math.round(e.duration),
      }));
  });
  check('浏览器请求了 woff2', fontReqs.length >= 2, JSON.stringify(fontReqs));
  check(
    'woff2 不是零字节',
    fontReqs.length >= 2 && fontReqs.every((r) => r.bytes > 10000),
    fontReqs.map((r) => `${r.url}:${Math.round(r.bytes / 1024)}KB/${r.ms}ms`).join(' '),
  );

  // ---- 3. 真正的一票:把同一串字用两种字体**画出来**,逐像素比对 ----
  //
  // 两个坑,都踩过,写在这里免得下一个人再踩:
  //
  // ⚠️ 坑一:别写 `page.evaluate((sample) => {...}, SAMPLE)`。
  //    本仓库的 evaluate(fn) 只做 `(${fn.toString()})()`,第二个参数被静默丢掉,
  //    sample 成了 undefined,每个宽度都量成 0 —— 而检查会把它报成
  //    "文楷字形与 sans-serif 相同",一个**根本不存在的字体故障**。
  //    量具坏了却给出关于被测对象的结论,是本项目记录在案的老毛病。
  //    所以这里把值拼进表达式。
  //
  // ⚠️ 坑二:**别用中文串比宽度**。汉字在几乎所有中文字体里都是 1em 宽,
  //    13 个字 48px 在文楷和在微软雅黑下**都**是 624px —— 这个判据对
  //    "用的是哪款中文字体"结构性失明(量出来必然相等,于是永远报"没生效")。
  //    要区分字体只能看**画出来的像素**。
  const drawHash = (family) => `(() => {
    const W = 640, H = 96;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff';
    g.font = '48px ' + ${JSON.stringify(family)};
    g.textBaseline = 'top';
    g.fillText(${JSON.stringify(SAMPLE)}, 4, 20);
    const d = g.getImageData(0, 0, W, H).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 4) { h ^= d[i]; h = Math.imul(h, 16777619); }
    return h >>> 0;
  })()`;
  const uiVarFamily = await page.evaluate(
    "getComputedStyle(document.documentElement).getPropertyValue('--qm-font-ui')",
  );
  const h = {
    wenkai: await page.evaluate(drawHash('"LXGW WenKai"')),
    wenkai2: await page.evaluate(drawHash('"LXGW WenKai"')), // 负对照
    sans: await page.evaluate(drawHash('sans-serif')),
  };

  // 量具自检。放在结论之前:同一字体画两次必须得到同一个哈希,
  // 否则说明取像素这一步本身不稳定,下面任何"不同"都不可信。
  const gaugeOk = h.wenkai === h.wenkai2 && h.wenkai !== 0;
  check(
    '量具自检:同一字体画两次哈希一致',
    gaugeOk,
    `文楷 ${h.wenkai} / 再画一次 ${h.wenkai2}${gaugeOk ? '' : '  ← 测量不稳定,下面的结论不可信'}`,
  );
  if (!gaugeOk) {
    check('文楷画出的字形与 sans-serif 不同', false, '量具故障,未测');
  } else {
    check(
      '文楷画出的字形与 sans-serif 不同(证明字体真的在用)',
      h.wenkai !== h.sans,
      `文楷 ${h.wenkai} vs sans ${h.sans}`,
    );
  }

  // --qm-font-ui 的**首位**字体名必须是文楷。
  //
  // 这里刻意只查名字,不拿它整串去 canvas 上画了比对:那样量出来的东西和
  // 真实元素不一致 —— canvas 的 font 简写对"带逗号的字体列表"有自己的解析路径,
  // 同一个列表在 canvas 上和元素上的落点不同。我按那个口径量过一次,得到的
  // 是第三种哈希,看上去像"变量没落到文楷",其实元素侧一切正常。
  // 真正证明"界面在用文楷"的是上一项(画出来的像素不同)+ 下面第 4 项
  // (真实元素的计算样式),这条只负责确认变量本身没写歪。
  const firstFamily = String(uiVarFamily).split(',')[0].replace(/["']/g, '').trim();
  check('--qm-font-ui 首位字体是 LXGW WenKai', firstFamily === 'LXGW WenKai', `首位为 ${JSON.stringify(firstFamily)}`);

  // ---- 4. 实际渲染的文本节点,计算样式里 font-family 首位是不是它 ----
  const used = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, h1, h2, .qm-panel, body')];
    const seen = new Set();
    for (const el of els) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 200) continue;
      seen.add(getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim());
    }
    return [...seen];
  });
  check(
    '渲染元素的 font-family 首位是 LXGW WenKai',
    used.includes('LXGW WenKai'),
    `实际出现的首位字体: ${used.join(' | ') || '(无)'}`,
  );
} finally {
  await close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
