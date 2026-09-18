#!/usr/bin/env node
/**
 * 把带 qm_anim 的对象连同它们的**全部标签**印出来。
 *
 * 这是网页侧驱动的接口契约 —— 写 `propsAnim.ts` 之前必须知道
 * 真实拿到的是哪些字段,而不是照着计划书上的表写。计划书写的是
 * 设计意图,导出后的 userData 才是事实,两者历史上已经对不上过。
 *
 * 用法: node tools/perf/once/tag_dump.mjs [URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=low&hud=0';

const { page, close } = await launch({ width: 900, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(2500);
  const out = await page.evaluate(`(() => {
    const qm = window.__QM__;
    const byAnim = {};
    const keys = new Set();
    qm.scene.traverse((o) => {
      const u = o.userData || {};
      const a = u.qm_anim;
      if (!a || a === 'none') return;
      byAnim[a] = byAnim[a] || [];
      for (const k of Object.keys(u)) if (k.indexOf('qm_') === 0) keys.add(k);
      // 这一件是不是 CharacterPool 克隆出来的实例?祖先里有没有「actor实体_姿态」。
      // 判断必须**往上走一整条祖先链**:克隆的名字留在根节点上,它下面的网格
      // 还叫模板时的名字(char_walk),只查自己的名字查不出来。
      //
      // ⚠️ 这段注释住在模板字面量里面,**一个反引号都不能有** —— 写「名字带引号」
      //    那种强调会把 page.evaluate 的模板字面量从中间截断,而 node --check
      //    对这类缺陷直接放行(反引号成对,截断后仍配平)。刚才就踩了一次。
      //
      // ⚠️ 这里**故意不用正则**,改用逐字符比较。原因是双反斜杠陷阱:
      //    在这段模板字面量里写两个反斜杠加 d,页面收到的是"反斜杠 + d"(对);
      //    但**只写一个反斜杠加 d**,会被 JS 当成无效转义**悄悄吞成字母 d** ——
      //    页面收到的正则退化成「actor_ 后面跟一串 d」,一次都匹配不上,
      //    却照样打印出一份看着很合理的读数(「克隆实例:无」)。
      //    第一版就是这么错的:**它不是一个错误答案,是一个装作量过的答案**。
      //    逐字符比较不经过转义这一层,没有这个失败模式。
      const isActorCloneName = (n) => {
        if (typeof n !== 'string' || n.indexOf('actor_') !== 0) return false;
        let i = 6;
        while (i < n.length && n[i] >= '0' && n[i] <= '9') i++;
        return i > 6 && n[i] === '_';
      };
      let cloneRoot = null;
      for (let p = o; p; p = p.parent) {
        if (isActorCloneName(p.name)) { cloneRoot = p.name; break; }
      }
      byAnim[a].push({
        name: o.name,
        type: o.type,
        skinned: !!o.isSkinnedMesh,
        cloneRoot,
        ud: Object.fromEntries(Object.entries(u).filter((e) => e[0].indexOf('qm_') === 0)),
        parent: o.parent ? o.parent.name : null,
      });
    });
    return { byAnim, keys: [...keys].sort() };
  })()`);

  console.log('出现过的 qm_* 键:', out.keys.join(', '));
  for (const [a, list] of Object.entries(out.byAnim)) {
    console.log(`\n===== qm_anim=${a} (${list.length} 个) =====`);
    for (const o of list) {
      const u = o.ud;
      console.log(
        `  ${o.name.padEnd(22)} ${o.type.padEnd(11)} skin=${o.skinned ? 'Y' : 'n'} ` +
          `part=${String(u.qm_part ?? '-').padEnd(9)} folded=${String(u.qm_folded ?? '-').padEnd(2)} ` +
          `pivot=${String(u.qm_pivot ?? '-').padEnd(22)} axis=${String(u.qm_axis ?? '-').padEnd(20)} ` +
          `flex=${String(u.qm_flex ?? '-')}`,
      );
    }
  }
  // ── 同一个 qm_id 出现在多个对象上,是两件完全不同的事 ──────────────────
  //
  // ⚠️ 这一段的第一版把两者合成了一张表,于是它的读数是**错的**。实跑
  //    `?q=high` 打出来的是: acc_punt_pole×6、char_carry_rig×12、char_walk×13 …
  //    而"×13"里的 12 个是 CharacterPool 用 `SkeletonUtils.clone()` 出来的
  //    **实例**,不是导出器把一件东西拆成了多个图元。
  //
  //    那句注释("驱动时每个图元都要转")于是变成了一条照着错误解释行事的指令:
  //    照做就是让 13 个人一起转。而它读起来完全合理 —— 这正是本项目反复吃亏的
  //    那类缺陷:**不是算错,是把一个没量过的解释当成了读数**。
  //
  // 分法只差一件事:克隆实例的祖先里有 `<actorId>_<pose>`(见上面 cloneRoot)。
  //   · 克隆实例 → 驱动时要**认准目标那一个**,不是每个都转;
  //   · 拆分图元 → 同一 qm_id、同一父对象下有多个网格,这些**才**要一起转。
  const clones = {};
  const splits = {};
  for (const list of Object.values(out.byAnim)) {
    for (const o of list) {
      const id = o.ud.qm_id;
      if (o.cloneRoot) {
        clones[id] = (clones[id] || 0) + 1;
      } else {
        const k = `${id} @ ${o.parent}`;
        splits[k] = (splits[k] || 0) + 1;
      }
    }
  }
  const fmt = (m) => {
    const multi = Object.entries(m).filter(([, n]) => n > 1);
    return multi.length ? multi.map(([k, n]) => `${k}×${n}`).join(', ') : '无';
  };
  console.log(`\n克隆实例(同一 qm_id 被复制多份 —— 驱动时认准目标那一个):${fmt(clones)}`);
  console.log(`导出拆分的图元(同一 qm_id、同一父对象下的多个网格 —— 这些要一起转):${fmt(splits)}`);
} finally {
  await close();
}
