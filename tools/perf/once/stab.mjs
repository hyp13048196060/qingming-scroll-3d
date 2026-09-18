// 一次性探针:把 ⑧A 里"速度 max 4.008 / p50 2.182"那根尖刺的**原始样本**打出来。
// 猜是采样相位问题(记录的 dt 比那一帧实际走的 dt 小),但那是猜;
// 这里直接把 (dt, 位移) 成对打出来,看尖刺那一对到底是什么。
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/';
const { page, close } = await launch({ width: 1600, height: 900 });

const RECORDER = `
window.__QT__ = (function () {
  var cam = window.__QM__.camera;
  var s = []; var running = true; var t0 = performance.now();
  function tick(ts) {
    if (!running) return;
    s.push([performance.now() - t0, ts, cam.position.x, cam.position.y, cam.position.z]);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return { stop: function () { running = false; return s; } };
})();
`;

try {
  await page.send('Page.navigate', { url: URL });
  for (let i = 0; i < 400; i++) {
    const ph = await page.evaluate(
      'window.__QM__ ? window.__QM__.store.read().load.phase : "noQm"',
    );
    if (ph === 'ready') break;
    await sleep(100);
  }
  await page.evaluate('window.__QM__.director.place([26,14,30],[0,4,0]);');
  await sleep(200);
  await page.evaluate('window.__QM__.startRoam()');
  await page.evaluate(RECORDER);
  await sleep(10000);
  const s = await page.evaluate('window.__QT__.stop()');
  await page.evaluate('window.__QM__.stopRoam && window.__QM__.stopRoam();');

  // 逐样本算 dt / 位移 / 速度
  const rows = [];
  for (let i = 1; i < s.length; i++) {
    const dt = (s[i][0] - s[i - 1][0]) / 1000;
    const dtTs = (s[i][1] - s[i - 1][1]) / 1000; // 用 rAF 时间戳算的 dt
    const dx = s[i][2] - s[i - 1][2];
    const dy = s[i][3] - s[i - 1][3];
    const dz = s[i][4] - s[i - 1][4];
    const d = Math.hypot(dx, dy, dz);
    if (dt <= 1e-4) continue;
    rows.push({ i, dt, dtTs, d, v: d / dt, vTs: dtTs > 1e-4 ? d / dtTs : null });
  }
  const q = (a, p) => {
    const b = [...a].sort((x, y) => x - y);
    return b[Math.min(b.length - 1, Math.floor(b.length * p))];
  };
  const vs = rows.map((r) => r.v);
  const dts = rows.map((r) => r.dt);
  console.log(
    `样本 ${s.length} 帧,有效步 ${rows.length}\n` +
      `速度 p50 ${q(vs, 0.5).toFixed(3)} / p95 ${q(vs, 0.95).toFixed(3)} / max ${q(vs, 1).toFixed(3)}\n` +
      `dt   p50 ${(q(dts, 0.5) * 1000).toFixed(2)} / min ${(q(dts, 0) * 1000).toFixed(2)} / max ${(q(dts, 1) * 1000).toFixed(2)} ms`,
  );
  console.log('\n--- 速度最快的 8 步(含前后邻居) ---');
  const top = [...rows].sort((a, b) => b.v - a.v).slice(0, 8);
  for (const t of top) {
    const nb = rows.filter((r) => Math.abs(r.i - t.i) <= 2);
    console.log(
      `#${t.i} v=${t.v.toFixed(3)} m/s  d=${t.d.toFixed(5)}m  dt=${(t.dt * 1000).toFixed(2)}ms  ` +
        `(用rAF戳 dt=${t.dtTs ? (t.dtTs * 1000).toFixed(2) : 'n/a'}ms)  邻居dt=` +
        nb.map((r) => (r.dt * 1000).toFixed(2)).join(','),
    );
  }
  console.log('\n--- dt 最小 / 最大的各 5 步 ---');
  const byDt = [...rows].sort((a, b) => a.dt - b.dt);
  for (const r of [...byDt.slice(0, 5), ...byDt.slice(-5)]) {
    console.log(
      `#${r.i} dt=${(r.dt * 1000).toFixed(2)}ms d=${r.d.toFixed(5)} v=${r.v.toFixed(3)}`,
    );
  }
} finally {
  await close();
}
