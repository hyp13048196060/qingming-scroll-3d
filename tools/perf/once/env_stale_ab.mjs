/**
 * A/B:环境贴图没重烘时,画面到底黑多少?
 *
 * 缘起:`core/contextGuard.ts` 与 `world/skyTime.ts` 的注释里都写着
 * "PMREM 不重建 → 画面整体发黑、不报错"。那句话是从 three 的源码**读出来**的
 * (`WebGLTextures.setTexture2D` 对 `isRenderTargetTexture` 有早退分支,
 *  于是重新上传永远不会发生,只剩一张空贴图),**没有量过**。
 *
 * 读源码得出的结论必须自己验一遍 —— 这是本项目反复栽跟头的地方。
 *
 * 做法:不改产品代码。从页面里把 `skyTime.invalidateEnvironment` 换成空函数,
 * 等价于"这个重建钩子不存在",再走一遍 丢失 → 恢复,采画面。
 * A 组 = 钩子正常,B 组 = 钩子被摘掉。两组用同一个页面分别跑。
 */
import { launch, sleep } from '../lib/cdp.mjs';

async function run({ disableHook }) {
  const { page, close } = await launch({ width: 1600, height: 900 });
  await page.goto('http://127.0.0.1:4173/');
  await page.waitForReady({ timeout: 120000 });
  await sleep(1200);

  const before = await page.evaluate(() => window.__QM__.sampleCanvas());
  const rev0 = await page.evaluate(() => window.__QM__.skyTime.environmentRevision);

  if (disableHook) {
    await page.evaluate(`(() => {
      window.__QM__.skyTime.invalidateEnvironment = () => {};
      return true;
    })()`);
  }

  await page.evaluate('window.__QM__.renderer.forceContextLoss()');
  await sleep(300);
  await page.evaluate('window.__QM__.renderer.forceContextRestore()');
  // 等恢复 + 让渲染稳定下来
  await sleep(2500);

  const after = await page.evaluate(() => window.__QM__.sampleCanvas());
  const rev1 = await page.evaluate(() => window.__QM__.skyTime.environmentRevision);
  await close();
  return { before, after, rev0, rev1 };
}

const a = await run({ disableHook: false });
const b = await run({ disableHook: true });

const fmt = (c) =>
  `rgb(${c.meanColor.join(',')}) stdDev=${c.stdDev} 非背景=${c.nonUniformRatio}`;
const lum = (c) => 0.2126 * c.meanColor[0] + 0.7152 * c.meanColor[1] + 0.0722 * c.meanColor[2];

console.log('A 组(环境贴图钩子正常)');
console.log('  丢失前 ', fmt(a.before), `envRev=${a.rev0}`);
console.log('  恢复后 ', fmt(a.after), `envRev=${a.rev1}  ${a.rev1 > a.rev0 ? '★ 重烘过' : '(没重烘)'}`);
console.log('B 组(钩子被摘成空函数)');
console.log('  丢失前 ', fmt(b.before), `envRev=${b.rev0}`);
console.log('  恢复后 ', fmt(b.after), `envRev=${b.rev1}  ${b.rev1 > b.rev0 ? '(重烘过)' : '★ 没重烘'}`);
console.log('');
console.log(`A 组恢复后 / 丢失前 亮度比 = ${(lum(a.after) / lum(a.before)).toFixed(4)}`);
console.log(`B 组恢复后 / 丢失前 亮度比 = ${(lum(b.after) / lum(b.before)).toFixed(4)}`);
console.log(`两组"恢复后"的亮度比再比一次 = ${(lum(b.after) / lum(a.after)).toFixed(4)}`);
