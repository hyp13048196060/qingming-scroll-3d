#!/usr/bin/env node
/**
 * 逐个景点验「机位看得见它」。
 *
 * 为什么需要这个工具
 * ------------------
 * `tools/make_spots.mjs` 的取景计算只回答了一个问题:**相机站多远能把
 * 这个东西装进画面**。它不知道中间还隔着别的物体。
 *
 * 漕船那个机位就是这么错的:按包围盒算,站在 12.56m 外、方位 0.95rad
 * 正好装下整条船 —— 可那个位置**落在虹桥里**,镜头距桥板不到一米。
 * 截图是一片木纹,围栏占了左上角。参数全对,画面全错。
 *
 * 这件事用算术是补不上的:取景是"相机与目标的二人关系",遮挡是"相机、
 * 目标与**场景里其它 227 个物体**的关系"。所以必须去问真实几何 ——
 * 也就是必须开浏览器打射线,而不是在 node 里读包围盒。
 * (包围盒判遮挡会把地形算进去,那个盒子罩着整个场地。)
 *
 * 判据
 * ----
 * 从相机向 target 打一束射线,取第一个命中 H。同时用**锚点的包围盒**
 * 做一个解析的 slab 求交,算出射线进入锚点盒子的距离 D_entry。
 *
 *   · `H.distance >= D_entry - 容差`  → 通过:在够到锚点之前没有别的东西
 *   · 否则                            → 挡住:报告第一个挡路的是谁
 *
 * 为什么不直接比 `H.distance ≈ 相机到目标的距离`:锚点是"盒心"时,射线
 * 常常在**到达盒心之前**就先打中锚点自己的前表面(茶肆那种薄墙尤其明显)。
 * 这样比会把正常情况判成遮挡。
 *
 * 用法:
 *   node tools/perf/verify_spots.mjs
 *   node tools/perf/verify_spots.mjs --url http://127.0.0.1:4173/ --tol 0.35
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch, sleep } from './lib/cdp.mjs';

const args = { url: 'http://127.0.0.1:4173/', tol: 0.35 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url') args.url = argv[++i];
  else if (argv[i] === '--tol') args.tol = Number(argv[++i]);
}

const ROOT = resolve(import.meta.dirname, '../..');
const doc = JSON.parse(await readFile(resolve(ROOT, 'src/data/spots.json'), 'utf8'));

/** 待验的机位:每个景点的全景与近观。 */
const targets = [];
for (const s of doc.spots) {
  targets.push({ spot: s.id, name: s.name, kind: 'view', cam: s.view, look: s.target, anchor: s.anchor });
  targets.push({ spot: s.id, name: s.name, kind: 'near', cam: s.near, look: s.target, anchor: s.anchor });
}

let pass = 0;
let fail = 0;
const rows = [];

for (const t of targets) {
  const url =
    `${args.url}?cam=${t.cam.join(',')}&look=${t.look.join(',')}`;

  const browser = await launch({ width: 1280, height: 720 });
  try {
    const page = browser.page;
    await page.goto(url);
    await page.waitForReady({ timeout: 120000 });
    await sleep(300);

    const r = await page.evaluate(`(() => {
      const qm = window.__QM__;
      if (!qm) return { error: '页面里没有 window.__QM__' };
      const THREE = qm.THREE;

      const cam = new THREE.Vector3(${t.cam.join(',')});
      const look = new THREE.Vector3(${t.look.join(',')});
      const dir = look.clone().sub(cam);
      const camToTarget = dir.length();
      dir.normalize();

      // —— 真实几何的第一次命中 ——
      const meshes = [];
      qm.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
      const rc = new THREE.Raycaster(cam, dir);
      rc.far = camToTarget + 5;
      const hits = rc.intersectObjects(meshes, false);
      const h = hits[0] || null;

      // —— 锚点包围盒的 slab 求交,算出 D_entry ——
      const b = ${JSON.stringify(t.anchor.bboxThree)};
      const lo = new THREE.Vector3(b[0], b[1], b[2]);
      const hi = new THREE.Vector3(b[3], b[4], b[5]);
      let t0 = 0, t1 = camToTarget + 5, ok = true;
      for (const ax of ['x','y','z']) {
        const inv = 1 / dir[ax];
        let n = (lo[ax] - cam[ax]) * inv;
        let f = (hi[ax] - cam[ax]) * inv;
        if (n > f) { const s = n; n = f; f = s; }
        t0 = Math.max(t0, n);
        t1 = Math.min(t1, f);
        if (t0 > t1) { ok = false; break; }
      }
      const entry = ok ? t0 : null;

      return {
        camToTarget: +camToTarget.toFixed(3),
        anchorQmId: ${JSON.stringify(t.anchor.qmId)},
        entry: entry === null ? null : +entry.toFixed(3),
        hit: h ? {
          id: h.object.userData?.qm_id ?? h.object.name,
          kind: h.object.userData?.qm_kind ?? null,
          distance: +h.distance.toFixed(3),
        } : null,
      };
    })()`);

    if (r.error) {
      fail++;
      rows.push({ ...t, verdict: 'ERROR', detail: r.error });
      continue;
    }

    // 判据:在够到锚点之前,不许有**别的东西**挡着。
    //
    // ⚠️ "别的东西"要把**同一个建筑的其它部件**排除掉。
    //    第一版没排除,于是茶肆被判成遮挡 —— 挡路的是
    //    `shop_e0_1_cha_awning`,就是这间铺子自己的凉棚。
    //    凉棚挑在立面前面,挡住立面是**对的**,不是故障。
    //    (Blender 侧栽过同一个坑:虹桥自己的索绑被当成障碍物,
    //     由 `_is_bridge_fabric()` 按 qm_id 前缀排除。同一个教训的第二遍。)
    // ⚠️ 前缀要拿 **qm_id** 去比,不能拿 Blender 物体名。
    //    第一版用的是 `虹桥_桥面`,而网页里返回的是 `bridge_deck` ——
    //    两套命名,前缀永远不匹配,于是虹桥被判成"射线从构件空当穿过"。
    //    真正的原因是**判据拿错了名字**,不是几何有问题。
    const cluster = (id) => {
      const i = String(id).lastIndexOf('_');
      return i > 0 ? String(id).slice(0, i) : String(id);
    };
    const anchorCluster = cluster(r.anchorQmId);

    let verdict;
    let detail;
    const same = r.hit && String(r.hit.id).startsWith(anchorCluster);

    if (r.entry === null) {
      // 射线够不到锚点盒子。这说明**机位根本没朝它**,是最严重的一种。
      verdict = 'MISS';
      detail =
        `射线打不到锚点包围盒` +
        (r.hit ? `;第一个命中是 ${r.hit.id}[${r.hit.kind}]@${r.hit.distance}m` : `;什么都没打中`);
    } else if (!r.hit) {
      verdict = 'CLEAR';
      detail = `到锚点入口 ${r.entry}m 的射程内没有命中任何网格`;
    } else if (same) {
      verdict = 'OK';
      detail =
        `锚点入口 ${r.entry}m;命中其自身部件 ${r.hit.id}@${r.hit.distance}m` +
        `(同一建筑,不算遮挡)`;
    } else if (r.hit.distance >= r.entry - args.tol) {
      // 到了锚点却没打中它本体 —— 说明锚点是镂空的(彩楼欢门那种架子),
      // 射线从构件之间的空当穿了过去。这不是故障,但要**单独报出来**:
      // "没被挡住"和"真的看见了锚点"是两件事。
      verdict = 'THROUGH';
      detail =
        `锚点入口 ${r.entry}m,射线从构件空当穿过(首个命中 ` +
        `${r.hit.id}@${r.hit.distance}m 在目标之后)`;
    } else {
      verdict = 'BLOCKED';
      detail = `锚点入口在 ${r.entry}m,但 ${r.hit.id}[${r.hit.kind}]@${r.hit.distance}m 挡在前面`;
    }

    if (verdict === 'OK' || verdict === 'CLEAR' || verdict === 'THROUGH') pass++;
    else fail++;

    rows.push({ ...t, verdict, detail, r });
  } finally {
    await browser.close();
  }
}

console.log('═'.repeat(88));
console.log('景点机位遮挡验证 —— 从相机向 target 打射线,看有没有东西挡在锚点前面');
console.log('═'.repeat(88));
console.log(
  '景点'.padEnd(6) + '机位'.padEnd(6) + '判定'.padEnd(9) + '相机到目标',
);
console.log('─'.repeat(88));
// ⚠️ 打勾的判定必须与上面计 pass 的判定**用同一份清单**。
//    第一版这里漏了 THROUGH(计数算了通过,却打叉),于是出现
//    "✗ 虹桥 ... 通过 10 / 失败 0" —— 一个自己和自己矛盾的报告。
//    报告工具报出矛盾的数字,比报错更糟:读的人会先怀疑数据。
const PASSING = new Set(['OK', 'CLEAR', 'THROUGH']);
for (const row of rows) {
  const ok = PASSING.has(row.verdict);
  console.log(
    `${ok ? '✓' : '✗'} ${row.name.padEnd(4)} ${row.kind.padEnd(6)} ${row.verdict.padEnd(9)} ${row.detail}`,
  );
  console.log(
    `   锚点 ${row.anchor.object} (qm_id ${row.anchor.qmId})  相机 (${row.cam.join(', ')})`,
  );
}
console.log('─'.repeat(88));
console.log(`通过 ${pass} / 失败 ${fail}`);
if (rows.length !== pass + fail) {
  // 行数与计数对不上,说明有分支既没算通过也没算失败。宁可自己报错,
  // 也不要让一份"通过了"的报告把漏判的分支藏起来。
  console.error(
    `❌ 报告自身不一致:${rows.length} 行,但只计了 ${pass + fail} 条。`,
  );
  process.exit(2);
}
console.log('═'.repeat(88));

process.exit(fail === 0 ? 0 : 1);
