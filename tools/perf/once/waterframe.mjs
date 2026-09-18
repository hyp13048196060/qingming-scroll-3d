// 一次性探针:水面那块几何的**局部坐标系到底朝哪**。
//
// 起因:three 的 `Reflector` 把反射面法线写死成**局部 +Z**
// (`normal.set(0, 0, 1); normal.applyMatrix4(rotationMatrix)`),
// 它不是从几何算出来的。所以能不能直接拿现有水面网格去做反射,
// 取决于"局部 +Z 在世界空间里是不是朝上"。猜错的话反射会整体错位,
// 而且**不会报错** —— 画面看着像"水面有点怪",查起来极费劲。
//
// 另外还要看:几何是不是水平面(bbox 的 Y 跨度接近 0)、
// 单位法线在世界空间的实际朝向、以及它是不是单面三角形。
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/';
const { page, close } = await launch({ width: 1280, height: 720 });

const PROBE = `(() => {
  const THREE = window.__QM__.THREE;
  const scene = window.__QM__.scene;
  const hits = [];
  scene.traverse((o) => {
    if (o.userData && o.userData.qm_kind === 'water') hits.push(o);
  });
  return hits.map((o) => {
    o.updateWorldMatrix(true, false);
    const g = o.geometry;
    g.computeBoundingBox();
    const bb = g.boundingBox;
    // 局部 +Z 在世界空间的朝向 —— Reflector 用的就是它
    const zAxisWorld = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
    // 几何自己的面法线(首个三角形),看它和 +Z 的关系
    const pos = g.attributes.position;
    const idx = g.index;
    const ia = idx ? idx.getX(0) : 0, ib = idx ? idx.getX(1) : 1, ic = idx ? idx.getX(2) : 2;
    const A = new THREE.Vector3().fromBufferAttribute(pos, ia);
    const B = new THREE.Vector3().fromBufferAttribute(pos, ib);
    const C = new THREE.Vector3().fromBufferAttribute(pos, ic);
    const geoNormal = new THREE.Vector3().subVectors(C, B).cross(new THREE.Vector3().subVectors(A, B)).normalize();
    const geoNormalWorld = geoNormal.clone()
      .applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion())).normalize();

    // 材质现状:现在是哪个材质、有哪些贴图
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    return {
      name: o.name,
      visible: o.visible,
      pos: o.position.toArray().map((v) => +v.toFixed(3)),
      quat: o.quaternion.toArray().map((v) => +v.toFixed(4)),
      eulerDeg: [o.rotation.x, o.rotation.y, o.rotation.z].map((v) => +(v * 180 / Math.PI).toFixed(2)),
      scale: o.scale.toArray().map((v) => +v.toFixed(3)),
      verts: pos.count,
      indexed: Boolean(idx),
      bboxSize: [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].map((v) => +v.toFixed(3)),
      bboxY: [+bb.min.y.toFixed(3), +bb.max.y.toFixed(3)],
      localZWorld: zAxisWorld.toArray().map((v) => +v.toFixed(4)),
      geoNormalLocal: geoNormal.toArray().map((v) => +v.toFixed(4)),
      geoNormalWorld: geoNormalWorld.toArray().map((v) => +v.toFixed(4)),
      side: mats[0] ? mats[0].side : null,
      mats: mats.map((m) => ({
        name: m.name, type: m.type,
        map: Boolean(m.map), normalMap: Boolean(m.normalMap),
        rough: m.roughness, metal: m.metalness,
        color: m.color ? '#' + m.color.getHexString() : null,
      })),
    };
  });
})()`;

try {
  await page.send('Page.navigate', { url: URL });
  await page.waitForReady({ timeout: 120000 });
  await sleep(1000);
  const r = await page.evaluate(PROBE);
  if (!r.length) console.log('没找到 qm_kind=water 的对象');
  for (const w of r) console.log(JSON.stringify(w, null, 1));
  console.log('\n判读:+Z 在世界空间若是 (0,1,0) → Reflector 可直接用;');
  console.log('      若是 (0,0,1) 或别的 → 必须先转父节点,或自己算反射矩阵。');
} finally {
  await close();
}
