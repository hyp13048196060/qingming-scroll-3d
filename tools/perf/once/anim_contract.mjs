#!/usr/bin/env node
/**
 * 驱动接口契约核对 —— 写 propsAnim.ts **之前**先问:每一个被标成动态的对象,
 * 驱动它需要的东西是不是真的都在?
 *
 * 为什么要先做这件事:
 *   标签是"意图",userData 是"事实"。一个对象被标了 `qm_anim=sway` 但没带权重属性,
 *   写代码的人不会收到任何报错 —— 上线后表现是"那根缆绳一动不动",
 *   而在**一张静帧里,"今天没风"和"权重丢了"完全一样**。
 *   这类"沉默的失败"只能靠事前逐条核对暴露。
 *
 * 判据(每一类各自成立才叫 ready):
 *   mast_fold / oar / rudder  需要 qm_pivot 与 qm_axis 都能解析出三个浮点数,
 *                             且**不是** SkinnedMesh(蒙皮件的动作归骨骼管,
 *                             再给它叠一层刚体旋转会打架)。
 *   wind / sway               需要几何体上真有 `color` 属性当权重。
 *
 * 同时量权重与高度的相关性:如果权重和 Y 完全无关,那它多半不是"顶端权"，
 * 用它做风动会把整片叶子当刚体推走。
 *
 * 用法: node tools/perf/once/anim_contract.mjs [URL]
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
    const RIGID = { mast_fold: 1, oar: 1, rudder: 1, rotate: 1 };
    const FLEX = { wind: 1, sway: 1 };

    const rows = [];
    qm.scene.traverse((o) => {
      const u = o.userData || {};
      const a = u.qm_anim;
      if (!a || a === 'none') return;

      const nums = (s) => {
        if (typeof s !== 'string') return null;
        const p = s.split(',').map(Number);
        return p.length === 3 && p.every((v) => Number.isFinite(v)) ? p : null;
      };

      const r = {
        name: o.name, anim: a, type: o.type, skinned: !!o.isSkinnedMesh,
        id: u.qm_id, part: u.qm_part, folded: u.qm_folded,
        pivot: nums(u.qm_pivot), axis: nums(u.qm_axis),
        parent: o.parent ? o.parent.name : null,
        verts: o.geometry ? o.geometry.attributes.position.count : 0,
      };

      if (FLEX[a]) {
        const ca = o.geometry ? o.geometry.attributes.color : null;
        r.flexAttr = !!ca;
        if (ca) {
          // 权重与**局部 Y** 的相关:权重该是"越靠梢头越大"的量。
          const pos = o.geometry.attributes.position;
          const n = ca.count;
          const idx = [];
          for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 400))) idx.push(i);
          const ws = idx.map((i) => ca.getX(i));
          const ys = idx.map((i) => pos.getY(i));
          const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
          const mw = mean(ws), my = mean(ys);
          let cov = 0, vw = 0, vy = 0;
          for (let k = 0; k < idx.length; k++) {
            const dw = ws[k] - mw, dy = ys[k] - my;
            cov += dw * dy; vw += dw * dw; vy += dy * dy;
          }
          r.wCorr = vw > 0 && vy > 0 ? +(cov / Math.sqrt(vw * vy)).toFixed(3) : null;
          const sorted = ws.slice().sort((x, y) => x - y);
          r.wMin = +sorted[0].toFixed(3);
          r.wMax = +sorted[sorted.length - 1].toFixed(3);
          r.wMed = +sorted[Math.floor(sorted.length / 2)].toFixed(3);
          // 全 0 或全 1 都等于没有梯度,风动会退化成整体平移
          r.wFlat = sorted[sorted.length - 1] - sorted[0] < 0.05;
          r.wItem = ca.itemSize;
          r.wNorm = !!ca.normalized;
        }
      }

      if (RIGID[a]) {
        // pivot/axis 是**世界**坐标(Blender 世界 → three 世界)。
        // 父级若有变换,驱动时要换算到父级空间;这里记录父级变换是否为单位阵,
        // 免得后面以为"直接就能用"。
        const pm = o.parent ? o.parent.matrixWorld : null;
        r.parentIdentity = pm ? pm.equals(new qm.THREE.Matrix4()) : true;
      }

      // ---- 判据 ----
      if (RIGID[a]) {
        if (r.skinned) r.verdict = '蒙皮件不能刚体转';
        else if (!r.pivot) r.verdict = '缺 qm_pivot';
        else if (!r.axis) r.verdict = '缺 qm_axis';
        else r.verdict = 'ready';
      } else if (FLEX[a]) {
        if (!r.flexAttr) r.verdict = '无权重属性';
        else if (r.wFlat) r.verdict = '权重无梯度';
        else r.verdict = 'ready';
      } else {
        r.verdict = '未实现的类别';
      }
      rows.push(r);
    });

    // 按 qm_id 聚合 —— 导出会把一个对象拆成多个图元,驱动要覆盖每一个
    const byId = {};
    for (const r of rows) {
      const k = r.anim + '|' + (r.id || r.name);
      (byId[k] = byId[k] || []).push(r.verdict);
    }
    const multi = Object.entries(byId).filter(([, v]) => v.length > 1);
    return { rows, multi: multi.map(([k, v]) => k + ' → ' + v.length + ' 图元 ' +
      (v.every((x) => x === 'ready') ? '全 ready' : '[' + [...new Set(v)].join(',') + ']')) };
  })()`);

  const byAnim = {};
  for (const r of out.rows) (byAnim[r.anim] = byAnim[r.anim] || []).push(r);

  for (const [a, list] of Object.entries(byAnim)) {
    const bad = list.filter((r) => r.verdict !== 'ready');
    console.log(`\n===== ${a}  ${list.length} 个,ready ${list.length - bad.length},有问题 ${bad.length} =====`);
    for (const r of list) {
      let line = `  ${r.name.padEnd(22)} ${r.type.padEnd(11)} skin=${r.skinned ? 'Y' : 'n'} `;
      if (r.pivot || r.axis) {
        line += `pivot=${r.pivot ? r.pivot.join(',') : '-'} axis=${r.axis ? r.axis.join(',') : '-'} `;
      }
      if (r.flexAttr !== undefined) {
        line += r.flexAttr
          ? `权重[R ${r.wMin}..${r.wMax} 中位 ${r.wMed}] item=${r.wItem} norm=${r.wNorm ? 'Y' : 'n'} 与Y相关=${r.wCorr} `
          : `**无 color 属性** `;
      }
      line += `→ ${r.verdict}`;
      console.log(line);
    }
  }

  const allBad = out.rows.filter((r) => r.verdict !== 'ready');
  console.log(`\n被拆成多图元的对象(${out.multi.length} 个 qm_id):`);
  for (const m of out.multi) console.log('  ' + m);

  const ready = out.rows.length - allBad.length;
  console.log(`\n合计 ${out.rows.length} 个动态对象,ready ${ready},有问题 ${allBad.length}`);
  if (allBad.length) {
    console.log('有问题的清单:');
    for (const r of allBad) console.log(`  ${r.anim.padEnd(10)} ${r.name.padEnd(22)} ${r.verdict}`);
  }
} finally {
  await close();
}
