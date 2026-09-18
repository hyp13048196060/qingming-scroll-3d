// 一次性探针:新建的反射水面**在世界空间里到底是横的还是竖的**。
//
// 起因:`Reflector` 把反射面法线写死成**局部 +Z**
// (`normal.set(0, 0, 1); normal.applyMatrix4(rotationMatrix)`,Reflector.js:133 附近),
// 而 Blender 导出的 `河道_水面` 是一个躺在**局部 XZ 平面**上的网格,
// 它自己的面法线是局部 +Y。两者差一个 90°,所以必须补一次旋转。
//
// ⚠️ 但补旋转有**两种补法,只有一种对**:
//      · 给**网格**转 −90°(局部 +Z → 世界 +Y)—— 反射数学对了,
//        可几何也跟着转了:**水面从躺着变成站着**,成了一道 600 m 高的墙。
//        这个错不报任何异常,画面上只表现为"河不见了/反射位置很怪"。
//      · 给**几何**烘 +90°、再给网格 −90°(两者相消)—— 反射数学对了,
//        水面还待在原处。
//    两者在"反射法线方向"上完全一样,只差几何的世界朝向 —— 所以只查法线
//    是查不出问题的,**必须查几何顶点在世界空间的实际范围**。
//
// 判据:
//   · 水平的水面 → 世界 bbox 尺寸 ≈ [16.5, ~0, 600](宽、薄、长)
//   · 竖起来的水面 → 世界 bbox 尺寸 ≈ [16.5, 600, ~0](宽、高、薄)
// 同时也报一下"局部 +Z 在世界空间指向哪",那是 Reflector 真正用的东西。
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/';
const { page, close } = await launch({ width: 1280, height: 720 });

const PROBE = `(() => {
  const THREE = window.__QM__.THREE;
  const scene = window.__QM__.scene;

  // 场景里的水面有两种形态:原始网格(被隐藏)与阶段 4 的 RiverWater 组
  // (反射体 + 关反射时的替代面)。两种都要量 —— 替代面的旋转写错了的话,
  // 它会在 reflect=0 那一组里单独把画面搞坏,而 A/B 的结论正好要拿它当对照。
  const out = [];

  const measure = (o, tag) => {
    o.updateWorldMatrix(true, false);
    const g = o.geometry;
    if (!g) return;
    g.computeBoundingBox();
    const bb = g.boundingBox.clone();

    // 几何顶点在世界空间的实际包围盒 —— 这是判"横还是竖"的唯一依据
    const wb = bb.clone().applyMatrix4(o.matrixWorld);
    const size = new THREE.Vector3();
    wb.getSize(size);

    // Reflector 真正用的:局部 +Z 在世界空间的朝向
    const zWorld = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();

    // 几何自身面法线(首个三角形)在世界空间的朝向
    const pos = g.attributes.position;
    const idx = g.index;
    const ia = idx ? idx.getX(0) : 0, ib = idx ? idx.getX(1) : 1, ic = idx ? idx.getX(2) : 2;
    const A = new THREE.Vector3().fromBufferAttribute(pos, ia);
    const B = new THREE.Vector3().fromBufferAttribute(pos, ib);
    const C = new THREE.Vector3().fromBufferAttribute(pos, ic);
    const nLocal = new THREE.Vector3().subVectors(C, B).cross(new THREE.Vector3().subVectors(A, B)).normalize();
    const nWorld = nLocal.clone()
      .applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion())).normalize();

    out.push({
      tag,
      name: o.name,
      visible: o.visible,
      eulerDeg: [o.rotation.x, o.rotation.y, o.rotation.z].map((v) => +(v * 180 / Math.PI).toFixed(1)),
      worldBBoxSize: size.toArray().map((v) => +v.toFixed(2)),
      worldY: [+wb.min.y.toFixed(2), +wb.max.y.toFixed(2)],
      localZWorld: zWorld.toArray().map((v) => +v.toFixed(3)),
      geoNormalWorld: nWorld.toArray().map((v) => +v.toFixed(3)),
    });
  };

  scene.traverse((o) => {
    const u = o.userData || {};
    if (u.qm_kind === 'water') measure(o, '原始水面网格');
    if (o.name === 'RiverReflector') measure(o, '反射体');
    if (o.name === 'RiverFlatFallback') measure(o, '替代面(reflect=0)');
  });

  // 光"几何摆对了"还不够:摆对了但**反射一次都没跑**是完全可能的
  // (Reflector 里有一条 isFacingAway 提前返回,相机在水面以下就会命中),
  // 而画面只是"河面颜色有点怪",不报错。所以读数要成对给:
  // 只报包围盒的探针会在功能整个死掉时报"一切正常"。
  // ⚠️ 这段在模板字符串里,注释里**不能出现反引号** —— 会直接把字符串截断。
  const q = window.__QM__;
  const rr = q.riverRuntime ? q.riverRuntime() : { mounted: false };
  const cam = q.camera.position;
  out.push({
    tag: '运行计数',
    name: 'riverRuntime',
    cam: [cam.x, cam.y, cam.z].map((v) => +v.toFixed(2)),
    ...rr,
  });
  out.push({ tag: 'URL', name: location.search || '(无参数)' });
  return out;
})()`;

try {
  await page.send('Page.navigate', { url: URL });
  await page.waitForReady({ timeout: 120000 });
  await sleep(1500);
  const r = await page.evaluate(PROBE);
  for (const w of r) console.log(JSON.stringify(w));
  console.log('\n判读:worldBBoxSize 的 Y 分量 ≈0 → 水面是**横**的(对);');
  console.log('      Y 分量 ≈600 → 水面**竖起来了**(网格转了、几何没跟着烘)。');
  console.log('      两个候选(cam 值)的 localZWorld 都应是 (0,1,0) —— 只看法线分不出对错。');
  console.log('      运行计数:reflectionPasses 若停在 0,说明反射 pass 一次都没跑 ——');
  console.log('      多半是相机在水面以下命中了 `isFacingAway` 提前返回(不报错)。');
} finally {
  await close();
}
