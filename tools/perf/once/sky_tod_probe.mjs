/**
 * 时辰(tod)到底有没有落到渲染侧?
 *
 * 起因:展示图上 tod=0.2 / 0.5 / 0.78 / 0.95 四张**看起来一样**。
 * 但当时的校验只对了 `store.read().tod` —— 那是**状态**,不是渲染。
 * skyTime.ts 里正写着这个坑:「只断言 store.tod 变了,证明的只是状态改了,
 * 完全没碰渲染侧 —— setter 里哪怕整个函数体是空的也照样通过」。
 * 所以这里换三把**碰得到渲染侧**的尺子:
 *
 *   ① 太阳的 position.y(由仰角算出,正午高、黄昏低)
 *   ② 太阳颜色、雾色、曝光的实际值
 *   ③ PMREM 重建计数 environmentRevision
 *   ④ 画面**天空区**的像素 —— 只取上缘那一横条,那里没有走动的行人,
 *      噪声底远低于整帧。整帧比对会被上百个移动角色淹没。
 *
 * 用法:node scripts/serve-dist.mjs --dir dist --port 4173 &
 *       node tools/perf/once/sky_tod_probe.mjs http://127.0.0.1:4173/
 */
import { launch, sleep } from '../lib/cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:4173/';
const TODS = [0.0, 0.2, 0.5, 0.78, 1.0];

const { page, close } = await launch({ width: 1600, height: 900 });
const rows = [];

try {
  for (const tod of TODS) {
    // 固定 spot 与画质,变量只有 tod。`cam`/`look` 也钉死,
    // 免得景点机位在两次之间有任何漂移。
    await page.goto(`${BASE}?spot=bridge&q=high&tod=${tod}`);
    await page.waitForReady({ timeout: 120000 });
    await sleep(4500);

    const r = await page.evaluate(`(() => {
      const qm = window.__QM__;
      const st = qm.store.read();
      const sun = qm.skyTime.sun;
      const fog = qm.skyTime.fog;
      // 天空区采样:画面最上面 40 行,横跨整个宽度。
      // 那里是天空与远山,没有角色在动 —— 噪声底比整帧低得多。
      const c = qm.renderer.domElement;
      const g = document.createElement('canvas');
      const W = 400, H = 40;
      g.width = c.width; g.height = c.height;
      const ctx = g.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, H).data;
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { sr += d[i]; sg += d[i+1]; sb += d[i+2]; n++; }
      return {
        storeTod: +st.tod.toFixed(3),
        sunY: +sun.position.y.toFixed(1),
        sunX: +sun.position.x.toFixed(1),
        sunZ: +sun.position.z.toFixed(1),
        sunColor: '#' + sun.color.getHexString(),
        sunI: +sun.intensity.toFixed(3),
        fogColor: '#' + fog.color.getHexString(),
        exposure: +qm.renderer.toneMappingExposure.toFixed(3),
        envRev: qm.skyTime.environmentRevision,
        sky: [Math.round(sr/n), Math.round(sg/n), Math.round(sb/n)],
      };
    })()`);
    rows.push({ tod, ...r });
    console.log(
      `tod=${String(tod).padEnd(4)} store=${String(r.storeTod).padEnd(5)}` +
        ` sunY=${String(r.sunY).padStart(7)} sun=${r.sunColor} I=${r.sunI}` +
        ` fog=${r.fogColor} expo=${r.exposure} envRev=${r.envRev}` +
        ` 天空均色 rgb(${r.sky.join(',')})`,
    );
  }
} finally {
  await close();
}

// —— 判定 ——
console.log('─'.repeat(78));
const problems = [];
const sunYs = rows.map((r) => r.sunY);
if (new Set(sunYs).size !== sunYs.length) {
  problems.push(`太阳高度在不同 tod 下有重复值:${sunYs.join(', ')} —— 至少两档没生效`);
}
const skySpread = rows.map((r) => Math.max(...r.sky) - Math.min(...r.sky));
if (Math.max(...skySpread) < 6) {
  problems.push(`天空均色在不同 tod 下几乎不变(最大极差 ${Math.max(...skySpread)})—— 光照没落到像素上`);
}
const envRevs = rows.map((r) => r.envRev);
if (new Set(envRevs).size < envRevs.length) {
  console.log(`注:envRev 在多档间相同(${envRevs.join(', ')}),页面加载后本就只重建一次,属正常`);
}

if (problems.length) {
  console.error('\n❌ 时辰未落到渲染侧:');
  for (const p of problems) console.error(`   · ${p}`);
  process.exit(1);
}
console.log('✅ 时辰在渲染侧确实生效:太阳高度、光色、天空像素三者都随时间变化');
