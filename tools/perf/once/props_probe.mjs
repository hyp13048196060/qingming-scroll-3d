#!/usr/bin/env node
/**
 * 道具动态是否**真的在动**。
 *
 * 一张静帧分不清"橹在划"和"橹卡住了" —— 两者都只是一根斜插在水里的木头。
 * 所以这里不看图,看**顶点世界坐标的位移**:连拍两次,算每个被驱动对象
 * 的世界矩阵差多少角度/多少米。
 *
 * 判据:
 *   · 刚体件:两次采样之间必须有**非零转角**(绕它自己的轴);
 *   · 风动件:必须有**非零顶点位移**,且位移应当随权重大的点更大 ——
 *     全都位移一样大 = 整片布在平移,不是风动。
 *
 * 顺带把 `propsRuntime()` 的计数印出来。"跳过了几个"和"驱动了几个"
 * 同等重要:一件被标了动态却因缺权重没动的东西,只在计数里露面。
 *
 * 用法: node tools/perf/once/props_probe.mjs [URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=low&hud=0&spot=boat';

const { page, close } = await launch({ width: 900, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(3000);

  const out = await page.evaluate(`(async () => {
    const qm = window.__QM__, THREE = qm.THREE;
    const rt = qm.propsRuntime();
    if (!rt || rt.mounted !== true) return { error: 'propsAnim 未挂载' };

    // 收集被驱动的对象:刚体看 qm_anim + 有 pivot;风动看几何体上有 qmFlex
    const rigid = [], flex = [];
    qm.scene.traverse((o) => {
      const u = o.userData || {};
      if (o.isSkinnedMesh) return;
      if (o.isSkinnedMesh) return;
      if (u.qm_anim && u.qm_anim !== 'none' && u.qm_pivot) rigid.push(o);
      const gu = o.material && o.material.userData && o.material.userData.qmFlexUniforms;
      if (gu) flex.push({ o, gu });
    });

    const worldQuat = (o) => {
      o.updateWorldMatrix(true, false);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      o.matrixWorld.decompose(p, q, s);
      return q;
    };
    const q0 = new Map(), t0 = new Map(), w0 = new Map();
    for (const o of rigid) q0.set(o, worldQuat(o));
    for (const f of flex) {
      t0.set(f.o, f.gu.uQmTime.value);
      w0.set(f.o, f.gu.uQmWind.value.clone());
    }

    await new Promise((r) => setTimeout(r, 1400));

    const rigidRows = [];
    for (const o of rigid) {
      const q1 = worldQuat(o);
      // 两次世界朝向的夹角 = 这个对象这段时间转过的角度
      const dot = Math.min(1, Math.abs(q0.get(o).dot(q1)));
      const deg = (2 * Math.acos(dot) * 180 / Math.PI);
      rigidRows.push({ name: o.name, anim: o.userData.qm_anim, deg: +deg.toFixed(4) });
    }
    // 风动**不能**用顶点位移来验:位移在顶点着色器里,着色器不写回
    // CPU 端的 position 数组。上一版就是读 position 判断的,读数恒为 0,
    // 它给出的是"零",错在尺子不在被测物。
    // 能验的是**输入**:时间推进了没有、风向算得对不对、权重的梯度在不在。
    const flexRows = [];
    for (const f of flex) {
      const t1v = f.gu.uQmTime.value;
      const w1 = f.gu.uQmWind.value;
      const geo = f.o.geometry;
      const wAttr = geo.getAttribute('qmFlex');
      let wMin = 1, wMax = 0;
      if (wAttr) {
        for (let i = 0; i < wAttr.count; i++) {
          const w = wAttr.getX(i);
          if (w < wMin) wMin = w;
          if (w > wMax) wMax = w;
        }
      }
      flexRows.push({
        name: f.o.name, anim: f.o.userData.qm_anim,
        dt: +(t1v - t0.get(f.o)).toFixed(3),
        windObj: [+w1.x.toFixed(3), +w1.y.toFixed(3), +w1.z.toFixed(3)],
        windLen: +w1.length().toFixed(4),
        windTurn: +w0.get(f.o).angleTo(w1).toFixed(4),
        amp: f.gu.uQmAmp.value,
        wMin: +wMin.toFixed(3), wMax: +wMax.toFixed(3),
      });
    }

    rigidRows.sort((a, b) => a.deg - b.deg);
    flexRows.sort((a, b) => a.dt - b.dt);
    return { rt, rigidRows, flexRows };
  })()`);

  if (out.error) {
    console.log('❌ ' + out.error);
    process.exit(1);
  }

  const rt = out.rt;
  console.log('===== propsRuntime =====');
  console.log('刚体驱动:', JSON.stringify(rt.rigid));
  console.log('风动驱动:', JSON.stringify(rt.flex));
  console.log('权重来源:', JSON.stringify(rt.flexWeightSource));
  console.log('跳过原因:', JSON.stringify(rt.skipped));
  console.log('风向(世界):', rt.wind.map((v) => v.toFixed(3)).join(', '));

  console.log(`\n===== 刚体件转角(1.4s 内,共 ${out.rigidRows.length} 个)=====`);
  for (const r of out.rigidRows) {
    console.log(`  ${r.name.padEnd(16)} ${String(r.anim).padEnd(10)} 转过 ${String(r.deg).padStart(8)}°`);
  }
  const stuckR = out.rigidRows.filter((r) => r.deg < 1e-4);
  console.log(stuckR.length ? `  ⚠️ ${stuckR.length} 个刚体件**一度都没转**` : '  全部在转 ✅');

  console.log(`\n===== 风动件的**输入**(共 ${out.flexRows.length} 个)=====`);
  console.log('  (位移在顶点着色器里算,CPU 侧读不到;能验的是喂进去的量)');
  for (const r of out.flexRows.slice(0, 8)) {
    console.log(`  ${r.name.padEnd(22)} ${String(r.anim).padEnd(6)} Δt=${String(r.dt).padStart(6)}s  幅度=${r.amp}  ` +
      `权重[${r.wMin}..${r.wMax}]  物体空间风向=[${r.windObj.join(', ')}] |w|=${r.windLen}`);
  }
  if (out.flexRows.length > 8) console.log(`  …其余 ${out.flexRows.length - 8} 个`);

  const dts = out.flexRows.map((r) => r.dt);
  const frozen = out.flexRows.filter((r) => r.dt < 0.5);
  console.log(`  Δt 区间: 最小 ${Math.min(...dts)}s  最大 ${Math.max(...dts)}s`);
  console.log(frozen.length ? `  ⚠️ ${frozen.length} 个风动件的时间没在推进` : '  时间全部在推进 ✅');
  const badLen = out.flexRows.filter((r) => Math.abs(r.windLen - 1) > 1e-3);
  console.log(badLen.length ? `  ⚠️ ${badLen.length} 个风向不是单位向量` : '  风向全部归一 ✅');
  const flat = out.flexRows.filter((r) => r.wMax - r.wMin < 0.05);
  console.log(flat.length ? `  ⚠️ ${flat.length} 个权重没有梯度(风动会退化成整体平移)` : '  权重都有梯度 ✅');
  const turned = out.flexRows.filter((r) => r.windTurn > 1e-6);
  console.log(turned.length
    ? `  ⚠️ ${turned.length} 个物体的风向在 1.4s 内变了 —— 父级本应静止,说明父级动了`
    : '  风向稳定:父级在这段时间里没有转动 ✅');
} finally {
  await close();
}
