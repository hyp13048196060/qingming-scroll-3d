/**
 * 一次性仪表灵敏度检查:`sampleCanvas()` 的聚合量分不分得出**画面在动**?
 *
 * 起因:`tests/context_loss.mjs` 量到恢复后的画面与丢失前 Δrgb=(0,0,0)、
 * stdDev 也一模一样。这个"完美"反而是可疑的 —— 场景里有 48 个走路的人、
 * 风动的幌子、波动的水面,两帧的均色凭什么分毫不差?
 *
 * 两种可能,必须分清:
 *   ① 聚合量本来就对这点变化不敏感(均色被几十万像素摊平)—— 那么 Δ=0
 *      是**正常**的,但"画面回来了"这条断言的分辨力也就只到"没黑屏"为止;
 *   ② 场景压根没动 —— 那是真问题,和上下文丢失无关,但会更严重。
 *
 * 做法:同一个页面,不碰上下文,隔 1.5 秒采两次(其中一次连采两遍逼近同刻)。
 */
import { launch, sleep } from '../lib/cdp.mjs';

const { page, close } = await launch({ width: 1600, height: 900 });
await page.goto('http://127.0.0.1:4173/');
await page.waitForReady({ timeout: 120000 });
await sleep(1500);

const s = () => page.evaluate(() => window.__QM__.sampleCanvas());

const a1 = await s();
const a2 = await s();            // 紧接着再采一次:同一时刻附近
await sleep(1500);
const b1 = await s();
await sleep(1500);
const b2 = await s();

const fmt = (x) => `rgb(${x.meanColor.join(',')}) stdDev=${x.stdDev} 非背景=${x.nonUniformRatio}`;
console.log('立刻连采  ', fmt(a1));
console.log('立刻连采2 ', fmt(a2));
console.log('+1.5s     ', fmt(b1));
console.log('+3.0s     ', fmt(b2));

const d = (x, y) => x.meanColor.map((v, i) => Math.abs(v - y.meanColor[i])).join(',');
console.log('Δ 同刻  ', d(a1, a2));
console.log('Δ +1.5s ', d(a1, b1));
console.log('Δ +3.0s ', d(a1, b2));

// 人物位置:两次快照比差值 = "人确实在走"的独立证据(与画面无关)
const p1 = await page.evaluate(() => window.__QM__.actorsSnapshot().slice(0, 3).map((a) => a.pos));
await sleep(1200);
const p2 = await page.evaluate(() => window.__QM__.actorsSnapshot().slice(0, 3).map((a) => a.pos));
console.log('人物前 3 个位移(米)');
for (let i = 0; i < p1.length; i++) {
  const dd = Math.hypot(p1[i][0] - p2[i][0], p1[i][1] - p2[i][1], p1[i][2] - p2[i][2]);
  console.log(`  #${i}: ${dd.toFixed(3)}`);
}
await close();
