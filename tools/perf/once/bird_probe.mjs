#!/usr/bin/env node
/**
 * 飞鸟单独开着的时候,**到底有没有像素落到画面上**?
 *
 * 起因:`fx_ab.mjs` 拆开两族开关之后量出——
 *   "只开烟" 4673 个像素在变,而 **"只开鸟" 一个像素都没变**(birds=9 确实在画)。
 * 但同一支探针在**没拆开**的旧版里,鸟那一帧明明出现过一块 Δ169 的像素。
 * 两版的差别只有一处:旧版的"鸟"那帧**烟也开着**。
 *
 * 于是有两种可能,而它们的修法差着十万八千里:
 *   A 鸟是真的不可见(视锥外 / 被剔除 / 尺寸退化)→ 修航线或修几何
 *   B 鸟只在**烟也开着**的时候才出现 → 这是两个 mesh 之间的耦合,是渲染状态被
 *     一个不该影响它的开关影响了,修的地方完全不同
 * 静帧分不出这两者,所以这里把四种组合全拍一遍:
 *   Z(全关) B(只鸟) S(只烟) SB(都开)
 * 判据是 **S vs SB** 这一对:烟一样多、只差鸟。它若非空 → 是 A(鸟自己会画,
 * 只是"只开鸟"那次没画出来);它若为零而旧版有 → 是 B(耦合)。
 *
 * 同时把 flock 的内部状态打出来(frustumCulled / boundingSphere / render calls),
 * 因为"没画"的可能原因里,**被视锥剔除**是最常见也最容易被忽略的一个 ——
 * 它在画面上和在代码里都完全无声。
 *
 * 用法: node tools/perf/once/bird_probe.mjs [URL]
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?spot=boat&q=high&hud=0';

const { page, close, browserVersion } = await launch({ width: 1280, height: 720 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(6000);
  await page.evaluate(`(() => { window.__QM__.loop.stop(window.__QM__.renderer); return true; })()`);
  await sleep(200);

  await page.evaluate(`(() => {
    const qm = window.__QM__;
    const gl = qm.renderer.getContext();
    window.__BP__ = {
      w: gl.drawingBufferWidth, h: gl.drawingBufferHeight, S: {},
      sample(name) {
        qm.renderer.info.reset();
        qm.renderer.render(qm.scene, qm.camera);
        const buf = new Uint8Array(this.w * this.h * 4);
        gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        this.S[name] = { buf, calls: qm.renderer.info.render.calls,
                         tris: qm.renderer.info.render.triangles };
        return true;
      },
    };
    return true;
  })()`);

  const setFx = async (smoke, birds) => {
    await page.evaluate(`window.__QM__.setFxOverride(${smoke}, 'smoke')`);
    return page.evaluate(`(() => { const x = window.__QM__.setFxOverride(${birds}, 'birds');
      return { puffs: x.puffs, birds: x.birds }; })()`);
  };

  const states = {};
  for (const [name, s, b] of [['Z', 0, 0], ['B', 0, 1], ['S', 1, 0], ['SB', 1, 1]]) {
    states[name] = await setFx(s, b);
    await page.evaluate(`window.__BP__.sample('${name}')`);
  }
  await setFx(1, 1);

  // flock 的内部状态 —— "没画"的各种成因各对应哪个字段,这里一次看全。
  const flock = await page.evaluate(`(() => {
    const qm = window.__QM__;
    let flock = null;
    qm.scene.traverse((o) => { if (o.isInstancedMesh || o.isMesh) {
      const g = o.geometry;
      if (g && g.isInstancedBufferGeometry && g.instanceCount === 9 && !flock) flock = o;
    }});
    if (!flock) return { found: false };
    flock.updateMatrixWorld(true);
    const cam = qm.camera;
    cam.updateMatrixWorld();
    const proj = new qm.THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const fr = new qm.THREE.Frustum().setFromProjectionMatrix(proj);
    const bs = flock.geometry.boundingSphere;
    const sphere = bs ? { center: [bs.center.x, bs.center.y, bs.center.z], radius: bs.radius } : null;
    const inFrustum = bs ? fr.intersectsSphere(bs) : null;
    return {
      found: true, name: flock.name, visible: flock.visible,
      instanceCount: flock.geometry.instanceCount,
      frustumCulled: flock.frustumCulled,
      matrixWorldPos: [flock.matrixWorld.elements[12], flock.matrixWorld.elements[13], flock.matrixWorld.elements[14]],
      worldScale: flock.matrixWorld.getMaxScaleOnAxis(),
      boundingSphere: sphere, sphereInFrustum: inFrustum,
      matTransparent: flock.material.transparent, matOpacity: flock.material.opacity,
      matDepthTest: flock.material.depthTest, matSide: flock.material.side,
      camPos: [cam.position.x, cam.position.y, cam.position.z],
    };
  })()`);

  const res = await page.evaluate(`(() => {
    const S = window.__BP__.S, w = window.__BP__.w, h = window.__BP__.h;
    const cmp = (a, b) => {
      let changed = 0, maxD = 0, sum = 0;
      const A = S[a].buf, B = S[b].buf;
      for (let i = 0; i < A.length; i += 4) {
        const m = Math.max(Math.abs(A[i]-B[i]), Math.abs(A[i+1]-B[i+1]), Math.abs(A[i+2]-B[i+2]));
        if (m > 0) { changed++; sum += m; }
        if (m > maxD) maxD = m;
      }
      return { changed, maxD, meanD: changed ? +(sum / changed).toFixed(2) : 0 };
    };
    return {
      ZB: cmp('Z','B'), ZS: cmp('Z','S'), ZSB: cmp('Z','SB'), SSB: cmp('S','SB'),
      meta: Object.fromEntries(Object.entries(S).map(([k, v]) => [k, { calls: v.calls, tris: v.tris }])),
    };
  })()`);

  console.log(`浏览器 ${browserVersion}`);
  console.log(`URL      ${URL}`);
  console.log('');
  console.log('── 四种组合真的在画什么 ──');
  for (const k of ['Z', 'B', 'S', 'SB']) {
    console.log(`  ${k.padEnd(3)} puffs=${states[k].puffs} birds=${states[k].birds}` +
      `   drawcall=${res.meta[k].calls}  三角面=${res.meta[k].tris}`);
  }
  console.log('');
  console.log('── 两两差值(变化像素 / 峰值 / 变化像素平均)──');
  console.log(`  Z vs B   (只差鸟)        ${res.ZB.changed} px  峰值Δ${res.ZB.maxD}  均${res.ZB.meanD}`);
  console.log(`  Z vs S   (只差烟)        ${res.ZS.changed} px  峰值Δ${res.ZS.maxD}  均${res.ZS.meanD}`);
  console.log(`  Z vs SB  (差烟也差鸟)    ${res.ZSB.changed} px  峰值Δ${res.ZSB.maxD}  均${res.ZSB.meanD}`);
  console.log(`  S vs SB  (烟一样,只差鸟) ${res.SSB.changed} px  峰值Δ${res.SSB.maxD}  均${res.SSB.meanD}`);
  console.log('');
  console.log('── flock 内部状态 ──');
  console.log(JSON.stringify(flock, null, 2));
  console.log('');
  console.log(res.ZB.changed === 0 && res.SSB.changed === 0
    ? '判定:两种组合下鸟都不产生任何像素 —— 鸟**根本没被画出来**(不是太淡)'
    : res.ZB.changed === 0 && res.SSB.changed > 0
      ? '判定:鸟只在"烟也开着"时出现 —— 两个 mesh 之间存在耦合,先查共享的渲染状态'
      : '判定:鸟自己会画,"只开鸟"那帧的问题另有原因(见下面 flock 状态)');
} finally {
  await close();
}
