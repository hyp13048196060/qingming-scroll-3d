// 一次性探针:那 N 个 drawcall **分别是哪个 pass 花的**?
//
// 当初要回答的问题:阶段 4 收尾时 `shot.mjs` 报出 high 档 506 个 drawcall,
// 而计划书的门限是「主 pass ≤220、上限 400」。看上去超了 ——
// 但 `renderer.info.render.calls` 是**所有 pass 的累加**,它把主 pass、
// 阴影 pass、反射 pass 全记在一个数里。拿一个累加值去比一个只针对主 pass
// 的门限,比出来的是假的超支。
//
// ⚠️ 写这个探针时先撞上了一个**仪器本身的毛病**,记在这里免得下次再踩:
//
//   `shot.mjs` 读的 drawCalls 来自 `sampleCanvas()`,而它只渲染**一帧**。
//   反射 pass 是每 N 帧一次的(mid/low 档 N=3),所以这一帧**可能正好被跳过**。
//   实测:`?q=low&reflect=1` 与 `?q=low` 都报 151 —— 前者正在跑反射
//   (已渲染 287 次),却和关掉时一模一样。差值不是 0,是**这一帧没轮上**。
//
//   所以这里不用单帧读数:**连渲 6 帧取最大与最小**。
//   N=3 时 6 帧里反射至少命中 2 次,最大 = 含反射、最小 = 不含。
//   一个会随采样时机漂移的仪表,读数不能拿来下结论。
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=high&reflect=1&hud=0';

const { page, close } = await launch({ width: 1600, height: 900 });

// ⚠️ 这段整个塞在模板字符串里,**注释里不能出现反引号** —— 会截断字符串。
//    这个坑在本项目已经踩到第四次了。要提某个名字就直接写字,别加反引号。
const SCRIPT = `(() => {
  const qm = window.__QM__;
  const R = qm.renderer, S = qm.scene, C = qm.camera;

  // 反射体的引用:从场景里按名字找,不依赖 RiverReflector 的内部实现。
  // 探针要知道的是"画面上有没有它",不是"它是谁造的"。
  const refl = [], flat = [];
  S.traverse((o) => {
    const k = (o.userData || {}).qm_kind;
    if (k === 'water_reflector') refl.push(o);
    if (k === 'water_fallback') flat.push(o);
  });
  // 兜底:标签没写就用名字匹配,免得探针因为一个标签缺失而静默量到 0。
  if (!refl.length) {
    S.traverse((o) => { if (/reflect/i.test(o.name) && o.isMesh) refl.push(o); });
  }

  const renderOnce = () => {
    R.info.reset();
    R.render(S, C);
    return { calls: R.info.render.calls, tris: R.info.render.triangles };
  };

  // —— A:全开。连渲 6 帧,因为反射可能每 N 帧才跑一次 ——
  const a = [];
  for (let i = 0; i < 6; i++) a.push(renderOnce());
  const aMax = a.reduce((m, v) => (v.calls > m.calls ? v : m));
  const aMin = a.reduce((m, v) => (v.calls < m.calls ? v : m));

  // —— B:藏掉反射面 = 主 pass + 阴影 pass ——
  //    藏掉之后 Reflector.onBeforeRender 不会触发(它自己不 visible 就不画),
  //    所以这一读数里不含反射 pass。
  const hidden = [];
  for (const o of refl.concat(flat)) { hidden.push([o, o.visible]); o.visible = false; }
  const b = renderOnce();
  for (const [o, v] of hidden) o.visible = v;

  // —— C:再停掉阴影贴图的更新 = 只剩主 pass ——
  //    ⚠️ 用 autoUpdate=false 而不是 shadowMap.enabled=false:
  //       后者会要求所有材质 needsUpdate,一次开关就是一场着色器重编译,
  //       探针本身会变成被测对象的一部分。autoUpdate 不改材质。
  const wasAuto = R.shadowMap.autoUpdate;
  R.shadowMap.autoUpdate = false;
  R.shadowMap.needsUpdate = false;
  const c = renderOnce();
  R.shadowMap.autoUpdate = wasAuto;

  // —— 复检:恢复之后 A 的特征还在不在 ——
  //    如果 restore 没做干净,后面所有读数都是在一个被我改坏的状态上量的。
  const after = [];
  for (let i = 0; i < 6; i++) after.push(renderOnce());
  const afterMax = after.reduce((m, v) => (v.calls > m.calls ? v : m));

  // —— 材质分组:要减 drawcall 得知道往哪儿减 ——
  //    同一个材质被 N 个 mesh 用 = 合并几何能省 N-1 个 drawcall。
  //    这是"能减多少"的量纲,比"现在多少"更有用。
  const frustumMat = new (qm.THREE.Frustum)();
  const projScreen = new (qm.THREE.Matrix4)()
    .multiplyMatrices(C.projectionMatrix, C.matrixWorldInverse);
  frustumMat.setFromProjectionMatrix(projScreen);

  const byMat = {}, byGeom = {};
  let drawables = 0, visibleDrawables = 0, inFrustum = 0, instanced = 0;
  const box = new (qm.THREE.Box3)();
  S.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine && !o.isInstancedMesh) return;
    drawables++;
    if (o.isInstancedMesh) instanced++;
    if (!o.visible) return;
    let p = o, vis = true;
    while (p) { if (!p.visible) { vis = false; break; } p = p.parent; }
    if (!vis) return;
    visibleDrawables++;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const key = (m && m.name) ? m.name : '(无名材质)';
    const e = byMat[key] || (byMat[key] = { meshes: 0, tris: 0, inFrustum: 0 });
    e.meshes++;
    const g = o.geometry;
    if (g && g.index) e.tris += g.index.count * (o.isInstancedMesh ? o.count : 1) / 3;
    else if (g && g.attributes.position) e.tris += g.attributes.position.count * (o.isInstancedMesh ? o.count : 1) / 3;
    box.setFromObject(o);
    if (frustumMat.intersectsBox(box)) { e.inFrustum++; inFrustum++; }
    const gk = (g && g.name) ? g.name : '(无名几何)';
    const ge = byGeom[gk] || (byGeom[gk] = { meshes: 0 });
    ge.meshes++;
  });

  const topMat = Object.entries(byMat)
    .sort((x, y) => y[1].meshes - x[1].meshes).slice(0, 22)
    .map(([k, v]) => ({ name: k, meshes: v.meshes, inFrustum: v.inFrustum, tris: Math.round(v.tris) }));
  const topGeom = Object.entries(byGeom)
    .sort((x, y) => y[1].meshes - x[1].meshes).slice(0, 12)
    .map(([k, v]) => ({ name: k, meshes: v.meshes }));

  return {
    gpu: qm.gpu.renderer,
    quality: qm.store.read().quality,
    all: { max: aMax, min: aMin, frames: a.map((v) => v.calls) },
    noReflection: b,
    mainOnly: c,
    afterRestoreMax: afterMax,
    waterFaces: { reflector: refl.length, fallback: flat.length, fallbackVisible: flat.filter((o) => o.visible).length },
    inventory: { drawables, visibleDrawables, inFrustum, instanced, materials: Object.keys(byMat).length, geometries: Object.keys(byGeom).length },
    topMat, topGeom,
    riverRuntime: qm.riverRuntime ? qm.riverRuntime() : null,
  };
})()`;

try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(5000);

  const r = await page.evaluate(SCRIPT);

  const pad = (s, n) => String(s).padEnd(n, ' ');
  const num = (n) => String(n).padStart(8);

  console.log('─'.repeat(78));
  console.log(`URL       : ${URL}`);
  console.log(`GPU       : ${r.gpu}`);
  console.log(`画质      : ${r.quality}`);
  console.log('');
  console.log('—— pass 分解(单次 renderer.render 的 drawcall 数)——');
  console.log(`  A 全部开启        : 最大 ${num(r.all.max.calls)}   最小 ${num(r.all.min.calls)}   三角面 ${r.all.max.tris.toLocaleString()}`);
  console.log(`    6 帧逐帧读数    : ${r.all.frames.join(', ')}`);
  console.log(`  B 藏掉反射面      :        ${num(r.noReflection.calls)}         三角面 ${r.noReflection.tris.toLocaleString()}`);
  console.log(`  C 再停阴影更新    :        ${num(r.mainOnly.calls)}         三角面 ${r.mainOnly.tris.toLocaleString()}`);
  console.log('  ─────────────────────────────────────────');
  const main = r.mainOnly.calls;
  const shadow = r.noReflection.calls - r.mainOnly.calls;
  const reflMax = r.all.max.calls - r.noReflection.calls;
  const reflMin = r.all.min.calls - r.noReflection.calls;
  console.log(`  主 pass           :        ${num(main)}`);
  console.log(`  阴影 pass         :        ${num(shadow)}`);
  console.log(`  反射 pass         :        ${num(reflMin)} ~ ${num(reflMax)}   (随每 N 帧节流而变)`);
  console.log('');
  console.log(`  复检(恢复后 6 帧最大): ${r.afterRestoreMax.calls}  —— 与 A 相同则说明探针恢复干净`);

  console.log('');
  console.log('—— 可绘制对象 ——');
  const iv = r.inventory;
  console.log(`  网格/点/线总数 ${iv.drawables}(可见 ${iv.visibleDrawables},视锥内 ${iv.inFrustum},实例化 ${iv.instanced})`);
  console.log(`  材质 ${iv.materials} 种,几何 ${iv.geometries} 种`);
  const mergeable = r.topMat.filter((m) => m.meshes > 1).reduce((s, m) => s + m.meshes - 1, 0);
  console.log(`  按材质粗算可合并量: 顶 22 个材质若各自合并,省 ${mergeable} 个 drawcall`);

  console.log('');
  console.log('—— 材质占用(合并几何的收益正比于 meshes 列)——');
  console.log(`  ${pad('材质', 34)} ${pad('网格数', 7)} ${pad('视锥内', 7)} 三角面`);
  for (const m of r.topMat) {
    console.log(`  ${pad(m.name, 34)} ${pad(m.meshes, 7)} ${pad(m.inFrustum, 7)} ${m.tris.toLocaleString()}`);
  }

  console.log('');
  console.log('—— 几何被复用最多的(>1 = 实例化的候选)——');
  for (const g of r.topGeom) console.log(`  ${pad(g.name, 44)} ${g.meshes}`);

  console.log('');
  console.log(`水面: 反射体 ${r.waterFaces.reflector} 个,替代面 ${r.waterFaces.fallback} 个(可见 ${r.waterFaces.fallbackVisible})`);
  if (r.riverRuntime) {
    console.log(`反射读数: ${r.riverRuntime.enabled ? '开' : '关'}  RT ${r.riverRuntime.rtSize.join('×')}  每 ${r.riverRuntime.everyNFrames} 帧  渲染 ${r.riverRuntime.reflectionPasses} 次`);
  }
  console.log('─'.repeat(78));
} finally {
  await close();
}
