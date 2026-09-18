#!/usr/bin/env node
/**
 * 场景诊断探针。
 *
 * shot.mjs 回答"画面是不是空的";本脚本回答"画面为什么长这样"。
 * 它把光照、材质、阴影相机、环境贴图的实际生效值全部读出来,
 * 并做**单变量对照采样** —— 逐个关掉太阳/半球光/环境贴图后采样画面,
 * 从而把"发白"这类问题定位到具体是哪一路光贡献的。
 *
 * 这比反复改参数重截图快得多,也是 "性能与还原度数据必须真实" 的工具化:
 * 判断依据是采出来的数,不是看着像。
 *
 * 用法:
 *   node tools/perf/diag.mjs --url http://127.0.0.1:4173/
 */
import { launch, sleep } from './lib/cdp.mjs';

function parseArgs(argv) {
  const a = { url: 'http://127.0.0.1:4173/', out: 'screenshots/web/diag.json' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') a.url = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const { page, close } = await launch({ width: 1600, height: 900 });

try {
  await page.goto(args.url);
  await page.waitForReady({ timeout: 120000 });
  await sleep(3000);

  const report = await page.evaluate(`(() => {
    const qm = window.__QM__;
    const THREE = qm.THREE;
    const scene = qm.scene;
    const out = {};

    // ⚠️ 必须提到最外层作用域:灯光的 traverse 与材质的 traverse 都要用。
    //    另外不能假设对象有 .color —— Sky 的 ShaderMaterial 与 LightProbe 都没有。
    const hex = (c) => (c && typeof c.getHexString === 'function' ? '#' + c.getHexString() : null);

    // —— 光照 ——
    const lights = [];
    scene.traverse((o) => {
      if (!o.isLight) return;
      const L = { type: o.type, name: o.name, intensity: o.intensity, color: hex(o.color) };
      if (o.isDirectionalLight) {
        L.position = o.position.toArray().map(n => +n.toFixed(3));
        L.target = o.target.position.toArray().map(n => +n.toFixed(3));
        L.distanceToTarget = +o.position.distanceTo(o.target.position).toFixed(3);
        if (o.castShadow) {
          const c = o.shadow.camera;
          L.shadow = {
            mapSize: [o.shadow.mapSize.x, o.shadow.mapSize.y],
            bias: o.shadow.bias,
            normalBias: o.shadow.normalBias,
            ortho: { left: c.left, right: c.right, top: c.top, bottom: c.bottom, near: c.near, far: c.far },
            // 投影矩阵里真正生效的值。若与上面的 left/right 不一致,
            // 说明改了参数却没调 updateProjectionMatrix()。
            projElements: Array.from(c.projectionMatrix.elements).map(n => +n.toFixed(5)),
            shadowMapAllocated: Boolean(o.shadow.map),
          };
        }
      } else if (o.isHemisphereLight) {
        L.groundColor = hex(o.groundColor);
      }
      lights.push(L);
    });
    out.lights = lights;

    // —— 环境 ——
    out.environment = {
      hasEnv: Boolean(scene.environment),
      intensity: scene.environmentIntensity,
      mapping: scene.environment ? scene.environment.mapping : null,
      colorSpace: scene.environment ? scene.environment.colorSpace : null,
    };
    out.fog = scene.fog
      ? { type: scene.fog.constructor.name, color: '#' + scene.fog.color.getHexString(), density: scene.fog.density }
      : null;
    out.renderer = {
      toneMapping: qm.renderer.toneMapping,
      exposure: qm.renderer.toneMappingExposure,
      outputColorSpace: qm.renderer.outputColorSpace,
      shadowMapEnabled: qm.renderer.shadowMap.enabled,
      shadowMapType: qm.renderer.shadowMap.type,
    };

    // —— 材质:实际加载进来的颜色 ——
    const mats = new Map();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (!m || mats.has(m.uuid)) continue;
        // ⚠️ 同样不能假设有 .color:Sky 用的是 ShaderMaterial,没有这个字段。
        mats.set(m.uuid, {
          name: m.name,
          type: m.type,
          color: hex(m.color),
          // 线性数值。与 Blender baseColorFactor 对应。
          colorLinear: m.color ? [m.color.r, m.color.g, m.color.b].map(n => +n.toFixed(4)) : null,
          roughness: typeof m.roughness === 'number' ? m.roughness : null,
          metalness: typeof m.metalness === 'number' ? m.metalness : null,
          vertexColors: m.vertexColors,
          side: m.side,
        });
      }
    });
    out.materials = Array.from(mats.values());

    // —— 单变量对照采样 ——
    // 逐个关掉光源再采样,看画面亮度到底由哪一路主导。
    const sample = () => qm.sampleCanvas();
    const base = { sun: null, hemi: null, env: 0 };
    scene.traverse((o) => {
      if (o.isDirectionalLight) base.sun = o;
      else if (o.isHemisphereLight) base.hemi = o;
    });
    const envIntensity0 = scene.environmentIntensity;
    const envTex0 = scene.environment;

    const savedSun = base.sun ? base.sun.intensity : 0;
    const savedHemi = base.hemi ? base.hemi.intensity : 0;

    const variants = {};
    const measure = (label) => {
      const s = sample();
      variants[label] = { meanColor: s.meanColor, stdDev: s.stdDev, drawCalls: s.drawCalls };
    };

    measure('all');
    if (base.sun) base.sun.intensity = 0; measure('noSun'); if (base.sun) base.sun.intensity = savedSun;
    if (base.hemi) base.hemi.intensity = 0; measure('noHemi'); if (base.hemi) base.hemi.intensity = savedHemi;
    scene.environment = null; measure('noEnv');
    scene.environment = envTex0; scene.environmentIntensity = envIntensity0;

    // 全关:应当只剩纯黑
    if (base.sun) base.sun.intensity = 0;
    if (base.hemi) base.hemi.intensity = 0;
    scene.environment = null;
    measure('none');
    if (base.sun) base.sun.intensity = savedSun;
    if (base.hemi) base.hemi.intensity = savedHemi;
    scene.environment = envTex0; scene.environmentIntensity = envIntensity0;

    out.variants = variants;

    // —— 相机与场景概况 ——
    out.camera = qm.cameraSnapshot();
    let meshes = 0, tris = 0;
    scene.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry;
      tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    });
    out.sceneStats = { meshes, triangles: Math.round(tris) };

    return out;
  })()`);

  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const outPath = resolve(process.cwd(), args.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));
  console.log(`\n诊断数据已写入 ${outPath}`);

  await close();
} catch (err) {
  console.error('❌ 诊断失败:', err.message);
  await close();
  process.exit(1);
}
