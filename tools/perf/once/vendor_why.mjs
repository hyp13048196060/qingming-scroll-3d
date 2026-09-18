#!/usr/bin/env node
/** vendor 为什么抬起来 30.6cm —— 静态姿势差,还是被驱动着? */
import { launch, sleep } from '../lib/cdp.mjs';
const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=high&hud=0';
const { page, close } = await launch({ width: 900, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(3000);
  const out = await page.evaluate(`(async () => {
    const qm = window.__QM__, THREE = qm.THREE;
    const reps = {};
    qm.scene.traverse((o) => {
      // ⚠️ 用 [0-9] 不用反斜杠d:这一段是模板字符串的**内容**,
      //    反斜杠d 在模板字符串里是"未识别的转义",反斜杠被吃掉,
      //    页面收到的是 /^actor_d+_.../ —— 永不匹配,而且**不报错**,
      //    整段诊断只是安静地什么都不印。
      const m = /^actor_[0-9]+_(vendor|hold|walk)$/.exec(o.name);
      if (m && !reps[m[1]]) reps[m[1]] = o;
    });
    const minOf = (rig) => {
      let mesh = null;
      rig.traverse((o) => { if (!mesh && o.isSkinnedMesh && /^char_/.test(o.name)) mesh = o; });
      const pos = mesh.geometry.attributes.position, v = new THREE.Vector3();
      let mn = Infinity;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        mesh.applyBoneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        if (v.y < mn) mn = v.y;
      }
      return +(mn - rig.position.y).toFixed(4);
    };
    const snap = Object.fromEntries(qm.actorsSnapshot().map((s) => [s.id, s]));
    const row = (p) => {
      const rig = reps[p];
      if (!rig) return null;
      const id = rig.name.split('_').slice(0, 2).join('_');
      const s = snap[id] || {};
      return { pose: p, id, a: minOf(rig), driven: s.driven, phase: s.phase, speed: s.speed,
               bones: (() => { const b = []; rig.traverse((o) => { if (o.isBone) b.push(o); }); return b.length; })() };
    };
    const t0 = ['vendor','hold','walk'].map(row);
    await new Promise((r) => setTimeout(r, 1200));
    const t1 = ['vendor','hold','walk'].map(row);
    return { t0, t1 };
  })()`);
  for (let i = 0; i < out.t0.length; i++) {
    const a = out.t0[i], b = out.t1[i];
    if (!a) continue;
    console.log(`${a.pose.padEnd(7)} ${a.id.padEnd(12)} 最低−原: ${String(a.a).padStart(8)} → ${String(b.a).padStart(8)}  ` +
      `变化 ${(b.a - a.a).toFixed(4)}  driven=${a.driven}  phase ${a.phase} → ${b.phase}  speed=${a.speed} 骨骼=${a.bones}`);
  }
} finally { await close(); }
