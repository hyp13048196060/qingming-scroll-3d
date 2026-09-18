#!/usr/bin/env node
/**
 * 一次性诊断:把一具实例骨架的**全部骨骼名**打出来。
 *
 * 为什么需要它:`measureFacingFrom(rig,'shoulder_L','shoulder_R')` 返回 null,
 * 有两种完全不同的可能 ——
 *   (a) 骨头存在,但 `rig.traverse` 走不到 / 名字对不上;
 *   (b) **骨头根本不存在**(肩胛骨压根没建)。
 * 这两种的修法完全不同,而 `null` 本身不区分它们。
 *
 * ⚠️ 顺带记一个刚踩的坑:CharacterPool 里那句
 *    `facingSource = \`${pose} 模板(foot/shin/thigh 的左右连线)\``
 *    是**写死的字面量**,它把三个候选全列了一遍,**不表示实际用的是哪一个**。
 *    我据此推断"thigh 查不到、退回脚了" —— 那是把一个静态字符串当读数读。
 *    教训:凡是"来源/依据"这类字样,要么由代码填真值,要么就别印。
 *
 * 用法: node tools/perf/once/bones.mjs [URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=low&hud=0';

const { page, close } = await launch({ width: 800, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(1500);

  const out = await page.evaluate(`(() => {
    const s = window.__QM__.scene;
    const rigs = [];
    s.traverse((o) => { if (/^actor_\\d+/.test(o.name) && !rigs.includes(o.name)) rigs.push(o.name); });
    // 每个模板各取一具(按名字前缀去重后取前 8 个 rig 节点)
    const seen = new Map();
    for (const name of rigs) {
      const pose = name.replace(/^actor_\\d+_?/, '') || '(无名)';
      if (!seen.has(pose)) seen.set(pose, name);
    }
    const detail = [];
    for (const [pose, rigName] of seen) {
      let rig = null;
      s.traverse((o) => { if (o.name === rigName) rig = o; });
      if (!rig) continue;
      const bones = [];
      rig.traverse((o) => { if (o.isBone) bones.push(o.name); });
      detail.push({ pose, rigName, count: bones.length, bones });
    }
    return { rigCount: rigs.length, detail };
  })()`);

  console.log(`实例 rig 节点数: ${out.rigCount}`);
  for (const d of out.detail) {
    console.log(`\n── ${d.pose}  (${d.rigName})  骨骼 ${d.count} 根`);
    console.log(`   ${d.bones.join(', ')}`);
  }
} finally {
  await close();
}
