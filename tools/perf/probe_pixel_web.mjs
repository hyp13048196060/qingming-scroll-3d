#!/usr/bin/env node
/**
 * 网页侧的「这个像素上是什么物体」—— `blender/tasks/probe_pixel.py` 的对应物。
 *
 * 为什么需要它
 * ------------
 * 图像能给出怀疑,给不出结论。截图里"那条船像是搁在岸上"是一个**关于
 * 几何的判断**,而人眼分不清"船在岸上"和"船在水上、只是水在这个俯角下
 * 反射弱、露出了土黄基色"。这两种情况的像素长得一样,结论却完全相反。
 * 唯一能分开它们的是一次射线:问**这个像素底下是谁**。
 *
 * 顺带解决另一个问题:预览图与网页是两个渲染器,颜色对不上是常态。
 * 与其比颜色,不如比**物体名** —— 名字来自 `qm_id`,两端同源,可以逐字比。
 *
 * 打两束射线
 * ----------
 *   ① 从相机过像素打出去  → 回答「我看到的是什么」
 *   ② 从命中点**竖直向下** → 回答「它脚下踩的是谁」
 * 第二束是关键的:船身与岸面在屏幕上是挨着的两个色块,只有向下打才能
 * 知道船底下面是不是水。
 *
 * 用法:
 *   node tools/perf/probe_pixel_web.mjs --at 300,700 800,500
 *   node tools/perf/probe_pixel_web.mjs --at 300,700 --url http://127.0.0.1:4173/
 *
 * ⚠️ 坐标是**图像坐标**(左上角为原点、y 向下),与截图软件一致。
 *    `readPixels` 是自下而上的,这里统一换算掉,免得再读反一次。
 */
import { launch, sleep } from './lib/cdp.mjs';

const args = {
  url: 'http://127.0.0.1:4173/',
  at: [],
  depth: 3,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url') args.url = argv[++i];
  else if (argv[i] === '--depth') args.depth = Number(argv[++i]);
  else if (argv[i] === '--at') {
    while (argv[i + 1] && /^\d+,\d+$/.test(argv[i + 1])) {
      args.at.push(argv[++i].split(',').map(Number));
    }
  }
}

if (args.at.length === 0) {
  console.error('用法: node tools/perf/probe_pixel_web.mjs --at 列,行 [列,行 ...]');
  process.exit(2);
}

const pts = JSON.stringify(args.at);

const script = `(async () => {
  const qm = window.__QM__;
  if (!qm) return { error: '页面里没有 window.__QM__' };

  const THREE = qm.THREE;
  const scene = qm.scene, camera = qm.camera, renderer = qm.renderer;
  const size = renderer.getSize(new THREE.Vector2());
  const W = size.x, H = size.y;

  // 收集**会上线的东西**:跳过预览件(网页里本来就不该有,有就是导出漏了)
  const meshes = [];
  scene.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });

  const rc = new THREE.Raycaster();
  rc.far = 5000;

  function label(o) {
    const ud = o.userData || {};
    return {
      name: o.name || '(无名)',
      qm_id: ud.qm_id ?? null,
      qm_kind: ud.qm_kind ?? null,
      qm_anim: ud.qm_anim ?? null,
    };
  }

  function short(o) {
    const l = label(o);
    return l.qm_id ? (l.qm_id + '[' + l.qm_kind + ']') : l.name;
  }

  const pts = ${pts};
  const out = [];

  for (const [col, row] of pts) {
    // 图像坐标 → NDC。左上角为原点,y 向下。
    const ndc = new THREE.Vector2((col / W) * 2 - 1, -((row / H) * 2 - 1));
    rc.setFromCamera(ndc, camera);
    const hits = rc.intersectObjects(meshes, false);

    const rec = { col, row, ndc: [Number(ndc.x.toFixed(4)), Number(ndc.y.toFixed(4))] };

    if (hits.length === 0) {
      rec.hit = null;
      rec.note = '这条射线什么都没打中 —— 那是天空,或者相机在场景外';
      out.push(rec);
      continue;
    }

    const h = hits[0];
    rec.hit = { ...label(h.object), distance: Number(h.distance.toFixed(3)),
                point: [+h.point.x.toFixed(3), +h.point.y.toFixed(3), +h.point.z.toFixed(3)] };
    rec.behind = hits.slice(1, ${args.depth}).map((x) => ({
      ...label(x.object), distance: Number(x.distance.toFixed(3)),
    }));

    // ② 从命中点**竖直向下**再打一束:它脚下踩的是谁?
    //    ⚠️ 起点抬高 1cm 再打,否则射线起点正好落在命中面上,会打到自己。
    const down = new THREE.Raycaster(
      new THREE.Vector3(h.point.x, h.point.y + 0.01, h.point.z),
      new THREE.Vector3(0, -1, 0),
    );
    down.far = 100;
    const below = down.intersectObjects(meshes, false);
    // 跳过那些"起点就在它内部/表面上"的自身命中
    const first = below.find((x) => x.distance > 0.02 && x.object !== h.object);
    rec.below = first
      ? { ...label(first.object), distance: Number(first.distance.toFixed(3)),
          // ⚠️ 打的是**竖直向下**的射线,所以有意义的坐标是 **y**(three 是 Y-up),
          //    不是 z。第一版这里印的是 point.z 却标成 z=,读出来像标高 ——
          //    而它其实是水平面里的一个轴,数字碰巧一样(向下射线两端 x/z 相同)
          //    才没露馅。字段名指着另一个轴,正是本项目反复栽的那种错。
          //
          // ⚠️⚠️ 本文件从 script 那一行到最后的右括号之间是一个 JS **模板
          //     字符串**。里面**不能出现反引号** —— 反引号会提前把它闭合掉。
          //     症状是 SyntaxError 指向注释中间("Unexpected identifier"),
          //     看着像注释里有语法错,而注释不可能有语法错;真正的原因是
          //     注释把字符串切断了。本文件里提到字段名一律用【方括号】。
          y: Number(first.point.y.toFixed(3)) }
      : null;
    if (!first) rec.below_note = '向下没打到别的物体(脚下是空或就是这个面自己)';

    out.push(rec);
  }

  return { viewport: [W, H], camera: qm.cameraSnapshot ? qm.cameraSnapshot() : null, results: out };
})()`;

const browser = await launch({ width: 1600, height: 900 });
try {
  const page = browser.page;
  await page.goto(args.url);
  await page.waitForReady({ timeout: 120000 });
  await sleep(500);

  const r = await page.evaluate(script);
  if (r.error) {
    console.error('✗', r.error);
    process.exit(1);
  }

  console.log('─'.repeat(78));
  console.log(`视口 ${r.viewport[0]}×${r.viewport[1]}`);
  console.log('─'.repeat(78));

  for (const rec of r.results) {
    const at = `(${rec.col}, ${rec.row})`;
    if (!rec.hit) {
      console.log(`${at.padEnd(14)} 未命中 — ${rec.note ?? ''}`);
      continue;
    }
    const h = rec.hit;
    const id = h.qm_id ? `${h.qm_id} [${h.qm_kind}]` : h.name;
    console.log(`${at.padEnd(14)} → ${id}`);
    console.log(`${''.padEnd(14)}   距离 ${h.distance} m   命中点 ` +
                `(${h.point.join(', ')})`);
    if (rec.below) {
      const b = rec.below;
      const bid = b.qm_id ? `${b.qm_id} [${b.qm_kind}]` : b.name;
      console.log(`${''.padEnd(14)}   脚下 ${b.distance} m 处是 **${bid}**` +
                  ` (y=${b.y},0 即水线)`);
    } else if (rec.below_note) {
      console.log(`${''.padEnd(14)}   ${rec.below_note}`);
    }
    if (rec.behind && rec.behind.length) {
      const list = rec.behind
        .map((x, i) => `${i + 2}.${x.qm_id ?? x.name}@${x.distance}`)
        .join('  ');
      console.log(`${''.padEnd(14)}   后面还有:${list}`);
    }
  }
  console.log('─'.repeat(78));
  console.log('⚠️ "脚下是谁"是竖直向下的那束射线给的 —— 它才回答'
              + '「这东西是浮在水上还是立在岸上」。');
  console.log('   只看第一条命中分不出这两种情况:两种情况在屏幕上就是两个挨着的色块。');
} finally {
  await browser.close();
}
