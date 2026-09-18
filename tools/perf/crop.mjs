#!/usr/bin/env node
/**
 * 局部放大截图 —— "近景要有可看的细节"这条要求,靠整幅 1600×900 是判断不了的:
 * 一面幌子在整幅图里只占 60×70 像素,看上去永远是一块色斑。
 *
 * 用 CDP 自己的 `clip` + `scale` 在浏览器里放大后再落盘,
 * 拿到的是**渲染器真实输出**的放大件(而不是把已保存的 png 拉伸),
 * 所以细节看不看得见这件事结论有效。
 *
 * 屏幕方框从哪来:先跑 tools/perf/once/flex_look.mjs / rigid_pivot_check.mjs,
 * 它们会把每个件的屏幕框打出来。**不要凭肉眼看图猜像素** —— 试过两次,
 * 两次都打在水面上。
 *
 * 用法:
 *   node tools/perf/crop.mjs --url "http://127.0.0.1:4173/?q=high&hud=0&spot=market" \
 *     --box 640 200 1020 580 --scale 2 --out screenshots/perf/crop_celou.png
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { launch, sleep } from './lib/cdp.mjs';

function parseArgs(argv) {
  const a = { url: 'http://127.0.0.1:4173/', out: 'screenshots/perf/crop.png',
              box: null, scale: 2, w: 1600, h: 900, warmup: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--url') a.url = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--scale') a.scale = Number(argv[++i]);
    else if (k === '--w') a.w = Number(argv[++i]);
    else if (k === '--h') a.h = Number(argv[++i]);
    else if (k === '--warmup') a.warmup = Number(argv[++i]);
    else if (k === '--box') a.box = [0, 1, 2, 3].map(() => Number(argv[++i]));
  }
  return a;
}

const a = parseArgs(process.argv.slice(2));
if (!a.box) {
  console.error('缺少 --box x0 y0 x1 y1(屏幕方框,从 flex_look.mjs 的输出里取)');
  process.exit(2);
}

const [x0, y0, x1, y1] = a.box;
const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: a.scale };

const { page, close } = await launch({ width: a.w, height: a.h });
try {
  await page.goto(a.url);
  await page.waitForReady({ timeout: 120000 });
  await sleep(a.warmup);
  const b64 = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip,
  });
  const out = resolve(a.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(b64.data, 'base64'));
  console.log(`已写出 ${out}`);
  console.log(`  取景 x ${x0}–${x1}  y ${y0}–${y1}  放大 ${a.scale}×  →  ${clip.width * a.scale}×${clip.height * a.scale} px`);
} finally {
  await close();
}
