#!/usr/bin/env node
/**
 * 选烟囱之前先看**实际有哪些建筑、各自多大、在哪儿**。
 *
 * 为什么不是照着计划书上的名字写死一串炊烟位置:计划书写的是设计意图,
 * 导出后的 `qm_id` / 尺寸 / 世界坐标才是事实,两者历史上已经对不上过
 * (见 `blender/build/04_buildings.py` 里那段"建筑群 vs buildings")。
 * 烟要冒在**真实存在的屋顶上**,所以先把屋顶的位置量出来。
 *
 * 输出三张表:
 *   buildings —— 每个 building/celebration 的 id、世界包围盒、脊高
 *   trees     —— 柳树(飞鸟要落在它们与河面上方)
 *   extent    —— 全场景范围(飞鸟的盘旋半径不能超出它)
 *
 * 用法: node tools/perf/once/emitters.mjs [URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=low&hud=0';

const { page, close } = await launch({ width: 900, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(2000);

  const out = await page.evaluate(`(() => {
    const qm = window.__QM__;
    const THREE = qm.THREE;
    const rows = [];
    const extent = new THREE.Box3();
    qm.scene.traverse((o) => {
      const u = o.userData || {};
      const kind = u.qm_kind;
      if (!kind) return;
      const box = new THREE.Box3().setFromObject(o);
      if (box.isEmpty()) return;
      extent.union(box);
      const s = box.getSize(new THREE.Vector3());
      const c = box.getCenter(new THREE.Vector3());
      rows.push({
        id: u.qm_id || o.name, kind, zone: u.qm_zone || '',
        label: u.qm_label || '', lod: u.qm_lod || '',
        min: [+box.min.x.toFixed(2), +box.min.y.toFixed(2), +box.min.z.toFixed(2)],
        max: [+box.max.x.toFixed(2), +box.max.y.toFixed(2), +box.max.z.toFixed(2)],
        c: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
        size: [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)],
        ch: o.children.length,
      });
    });
    return {
      rows,
      extent: {
        min: [+extent.min.x.toFixed(1), +extent.min.y.toFixed(1), +extent.min.z.toFixed(1)],
        max: [+extent.max.x.toFixed(1), +extent.max.y.toFixed(1), +extent.max.z.toFixed(1)],
      },
    };
  })()`);

  const { rows, extent } = out;
  console.log(`全场景范围 min=${extent.min}  max=${extent.max}`);
  console.log('');

  // ⚠️ 分量下标要写死成"哪个是哪个":场景是 **Y 朝上**,于是
  //    `[0]=x`(横向)、`[1]=y`(**高度**)、`[2]=z`(沿河纵向)。
  //    但 `Box3.getSize()` 给的三个数**不带语义**,而人看 `尺寸=(19.72,3.65,191.73)`
  //    时的第一反应是"最大的那个是长度" —— 于是很容易把 `[2]` 当成高度印出来。
  //    第一版就是这么印的:表头写着 `脊z`,印的却是沿河长度(96 米),
  //    一张 8 米进深的铺面被印成"跨 191 米"。**表头的名字错了比数错了更毒**:
  //    数错了会有人怀疑,名字错了所有人都照着它理解。
  //    这里改成全部走具名函数,不再出现裸下标。
  const f = (n) => (n >= 0 ? ' ' : '') + n.toFixed(2);
  const xyz = (v) => `x${f(v[0])} y${f(v[1])} z${f(v[2])}`;

  const groups = {};
  for (const r of rows) (groups[r.kind] ||= []).push(r);

  for (const kind of ['building', 'celebration', 'tree']) {
    const list = groups[kind] || [];
    console.log(`── ${kind} (${list.length}) ──  按屋脊高度 y 降序`);
    for (const r of list.sort((a, b) => b.max[1] - a.max[1])) {
      console.log(
        `  ${r.id.padEnd(26)} ${(r.zone || '-').padEnd(4)} ` +
          `脊y=${f(r.max[1]).padStart(6)} 底y=${f(r.min[1]).padStart(6)} ` +
          `中心(${xyz(r.c)}) 尺寸(${xyz(r.size)})`,
      );
    }
    console.log('');
  }
} finally {
  await close();
}
