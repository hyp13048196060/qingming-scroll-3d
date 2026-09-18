/**
 * 每一个 URL 参数,都要有一条**碰得到渲染侧/DOM 侧**的断言。
 *
 * 起因(2026-09-18):展示图上 `?tod=0.05 / 0.5 / 0.95` 三张看起来一模一样。
 * 而采集脚本当时"核对"了 `store.read().tod`,值完全对得上,于是全部判为
 * "参数已落地"。可太阳的高度、颜色、雾色、曝光全停在 day 预设上 ——
 * **参数从来没有生效过**。
 *
 * 这正是 `src/world/skyTime.ts` 里写着的那句话:
 *    「要是测试只断言"store.tod 变了",那它证明的只是**状态改了**,
 *      完全没碰渲染侧 —— setter 里哪怕整个函数体是空的也照样通过。」
 * 我照着那句警告的反面写了一遍校验。
 *
 * 所以这个探针的口径是:**store 说什么不算数,要看消费者那边真的变了没有**。
 *
 * ── 挑观测量时的两条纪律(都踩过) ────────────────────────────────
 *
 * ① **观测量必须在被测量的那一维上有分辨力。**
 *    第一版拿 `shadowMap.enabled / pixelRatio / drawingBuffer` 去分
 *    low/mid/high。结果 low 与 mid 分得开(关/开阴影),mid 与 high
 *    读数**完全相同** —— 不是 high 没生效,是这三个量本来就与
 *    mid→high 那一步无关(那一步改的是反射 RT 尺寸与粒子密度)。
 *    差点报成一个不存在的画质缺陷。
 *
 * ② **别用"恒为 0"的量当判据。**
 *    `quality.report().wireframeMaterials` 写的是
 *    `wireframe ? eachMaterial(...) : 0` —— 内部分支为假时直接返回 0。
 *    于是"材质没被设成线框"和"线框开关本来就是关的"读数一模一样,
 *    它分不出被测物的两种状态。这个探针改成自己遍历材质数,
 *    不以那个字段为准。
 *
 * 用法:node scripts/serve-dist.mjs --dir dist --port 4173 &
 *       node tools/perf/once/url_params_probe.mjs http://127.0.0.1:4173/
 */
import { launch, sleep } from '../lib/cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:4173/';

/** 每个参数一条。`read` 里取的全是消费者那一侧的值。 */
const CASES = [
  {
    name: 'tod',
    urls: ['tod=0.05', 'tod=0.5', 'tod=0.95'],
    read: `(() => { const s = window.__QM__.skyTime; return {
      sunY: +s.sun.position.y.toFixed(2),
      sunColor: '#' + s.sun.color.getHexString(),
      fogColor: '#' + s.fog.color.getHexString(),
      exposure: +window.__QM__.renderer.toneMappingExposure.toFixed(3),
    }; })()`,
    // 判据取"两两不同",不取"等于某个期望值" —— 期望值要另抄一份预设表,
    // 抄错了就成了第二个真相源。这里只问一件事:变了没有。
    check: (rows) => {
      const ys = rows.map((r) => r.r.sunY);
      return new Set(ys).size === ys.length
        ? null
        : `太阳高度在三档 tod 下出现重复:${ys.join(' / ')} —— 至少两档没生效`;
    },
  },
  {
    name: 'q',
    urls: ['q=low', 'q=mid', 'q=high'],
    // 这三个量分别对应三档之间的**那一步**:
    //   low→mid  阴影开关 + 人物投影名额
    //   mid→high 反射 RT 尺寸 + 粒子密度
    // 用 report() 的**纯数据字段**(它只读不写,见 quality.ts 里那段说明)。
    read: `(() => { const q = window.__QM__.quality; const r = q.report(); return {
      quality: r.quality,
      shadowMapSize: r.shadowMapSize,
      charShadows: r.charactersCastingShadow,
      rt: (window.__QM__.riverRuntime() || {}).rtSize || null,
      fx: (() => { const f = window.__QM__.fxRuntime(); return f.puffs ?? null; })(),
    }; })()`,
    check: (rows) => {
      const sig = rows.map((r) => JSON.stringify(r.r));
      return new Set(sig).size === sig.length
        ? null
        : `三档画质下渲染器状态有重复:\n` +
            rows.map((r, i) => `       ${r.url} -> ${sig[i]}`).join('\n');
    },
  },
  {
    name: 'tags',
    urls: ['tags=0', 'tags=1'],
    // 标签的开关落在容器 `.qm-labels` 的 `hidden` 上(Labels.ts:120)。
    // ⚠️ 选择器要**精确到容器本身**。第一版写 `[class*="label"]`,
    //    把 `.qm-labels` 容器连同面板里带 label 字样的元素一起数了进来,
    //    数出 13 与 11 两个都不为零的值,方向还是反的。
    read: `(() => {
      const root = document.querySelector('.qm-labels');
      return {
        rootHidden: root ? root.hidden : null,
        items: document.querySelectorAll('.qm-label').length,
        shownItems: [...document.querySelectorAll('.qm-label')].filter((e) => !e.hidden).length,
      };
    })()`,
    check: (rows) => {
      const [off, on] = rows;
      if (off.r.rootHidden !== true) return `tags=0 时 .qm-labels 仍可见 —— 关不掉`;
      if (on.r.rootHidden !== false) return `tags=1 时 .qm-labels 仍隐藏 —— 打不开`;
      if (on.r.shownItems < 1) return `tags=1 但一个标签都没显示`;
      return null;
    },
  },
  {
    name: 'wire',
    urls: ['wire=0', 'wire=1'],
    // 自己遍历数线框材质,不用 report().wireframeMaterials —— 理由见文件头 ②。
    read: `(() => {
      let n = 0, total = 0;
      window.__QM__.scene.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        for (const m of [].concat(o.material)) {
          if (!m) continue; total++;
          if (m.wireframe) n++;
        }
      });
      return { wireframeMats: n, totalMats: total, flag: window.__QM__.quality.report().wireframe };
    })()`,
    check: (rows) => {
      const [off, on] = rows;
      if (off.r.wireframeMats !== 0) return `wire=0 却有 ${off.r.wireframeMats} 个线框材质`;
      if (on.r.wireframeMats === 0) {
        return (
          `wire=1 但场景里 ${on.r.totalMats} 个材质**一个都没被设成线框**` +
          `(内部标志为 ${on.r.flag})—— 开关没落到材质上`
        );
      }
      return null;
    },
  },
];

const { page, close } = await launch({ width: 1280, height: 720 });
const failures = [];

try {
  for (const c of CASES) {
    const rows = [];
    for (const u of c.urls) {
      // 每次都带 spot=bridge 固定机位:变量只留被测参数一个。
      await page.goto(`${BASE}?spot=bridge&${u}`);
      await page.waitForReady({ timeout: 120000 });
      await sleep(3000);
      const r = await page.evaluate(c.read);
      const state = await page.evaluate(`(() => { const s = window.__QM__.store.read(); return {
        q: s.quality, tod: +s.tod.toFixed(3), tags: s.ui.labels, wire: s.ui.wireframe }; })()`);
      rows.push({ url: u, r, state });
      console.log(`  ${u.padEnd(10)} 渲染侧 ${JSON.stringify(r)}`);
    }
    const bad = c.check(rows);
    console.log(`  store 说: ${rows.map((x) => JSON.stringify(x.state)).join(' | ')}`);
    if (bad) {
      failures.push(`${c.name}: ${bad}`);
      console.log(`✗ ${c.name}\n`);
    } else {
      console.log(`✓ ${c.name}  —— 渲染侧确实随参数变化\n`);
    }
  }
} finally {
  await close();
}

console.log('─'.repeat(78));
if (failures.length) {
  console.error(`❌ ${failures.length}/${CASES.length} 个 URL 参数没落到渲染侧:`);
  for (const f of failures) console.error(`   · ${f}`);
  process.exit(1);
}
console.log(`✅ ${CASES.length} 个 URL 参数全部在渲染侧生效`);
