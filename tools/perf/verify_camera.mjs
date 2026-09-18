#!/usr/bin/env node
/**
 * 阶段 1 出口验证:四项相机交互 + 加载进度。
 *
 * 这不是"打开网页看一眼能动" —— 每一条都**断言方向与幅度**,
 * 因为"相机确实变了"和"相机朝对的方向变了"是两回事:
 * 环视写反了、键盘的前后接反了,肉眼扫一眼截图是看不出来的。
 *
 * 四项分别用真实的输入事件驱动(CDP Input 域),不是直接调函数:
 *   1. 左键拖拽 → 绕目标环视,方位角变化,半径不变
 *   2. 滚轮     → 相机沿视线推拉,半径减小 / 增大,方位角不变
 *   3. 右键拖拽 → 平移,目标点位移而半径基本不变
 *   4. 键盘 W/S  → 相机与目标同步推进,半径不变
 *
 * 输出:控制台表格 + screenshots/web/stage1_camera.json
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { launch, sleep } from './lib/cdp.mjs';

const URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:4173/';
const OUT = 'screenshots/web/stage1_camera.json';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
}

const { page, close } = await launch({ width: 1600, height: 900 });

/** 取相机快照。 */
const snap = () => page.evaluate('window.__QM__.cameraSnapshot()');

/** 拖拽:按下 → 分步移动 → 松开。分步是为了让 OrbitControls 的阻尼真正累积。 */
async function drag(from, to, button, steps = 12) {
  await page.mouse('mousePressed', from[0], from[1], { button });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse('mouseMoved', from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, {
      button,
      buttons: button === 'right' ? 2 : 1,
    });
    await sleep(16);
  }
  await page.mouse('mouseReleased', to[0], to[1], { button });
  await sleep(600); // 等阻尼收敛
}

/** 键盘长按:按下 → 等 → 松开。 */
async function holdKey(code, key, ms) {
  await page.evaluate(
    `(() => {
       window.dispatchEvent(new KeyboardEvent('keydown', { code: ${JSON.stringify(code)}, key: ${JSON.stringify(key)}, bubbles: true }));
     })()`,
  );
  await sleep(ms);
  await page.evaluate(
    `(() => {
       window.dispatchEvent(new KeyboardEvent('keyup', { code: ${JSON.stringify(code)}, key: ${JSON.stringify(key)}, bubbles: true }));
     })()`,
  );
  await sleep(200);
}

try {
  await page.goto(URL);

  // ── 进度必须真跑到 1.0 ───────────────────────────────────────────
  //
  // ⚠️ 这里**不能用轮询**。本机 1MB 的 GLB 走 localhost 十几毫秒就下完了,
  //    50ms 采一次只会看到 manifest → compiling → ready 三个点,
  //    "确实经过了下载与解析"根本采不到 —— 那样断言失败是**测试的问题**,
  //    不是应用的问题。改为读应用内部记录的阶段变迁日志。
  await page.waitForReady({ timeout: 120000 });

  const loadReport = await page.evaluate(`(() => {
    const s = window.__QM__.store.read().load;
    return { phase: s.phase, progress: s.progress, phaseLog: s.phaseLog,
             bytesLoaded: s.bytesLoaded, bytesTotal: s.bytesTotal,
             failures: s.failures.length };
  })()`);

  const seq = loadReport.phaseLog.map((e) => e.phase);
  check(
    '进度终值 = 1.0',
    loadReport.phase === 'ready' && loadReport.progress === 1,
    `phase=${loadReport.phase} progress=${loadReport.progress}`,
  );
  check(
    '阶段日志依次经过 下载 → 解析 → 编译',
    ['fetching', 'parsing', 'compiling'].every((p) => seq.includes(p)) &&
      seq.indexOf('fetching') < seq.indexOf('parsing') &&
      seq.indexOf('parsing') < seq.indexOf('compiling'),
    `实际顺序: ${seq.join(' → ')}`,
  );
  check(
    '下载字节数与 manifest 分母一致',
    loadReport.bytesTotal > 0 && loadReport.bytesLoaded === loadReport.bytesTotal,
    `${loadReport.bytesLoaded} / ${loadReport.bytesTotal} 字节,失败 ${loadReport.failures} 项`,
  );

  await sleep(2500);

  const CX = 800;
  const CY = 450;

  // ── 1. 左键拖拽 = 环视 ────────────────────────────────────────────
  {
    const a = await snap();
    await drag([CX, CY], [CX + 260, CY + 40], 'left');
    const b = await snap();
    const dAz = Math.abs(b.azimuth - a.azimuth);
    const dR = Math.abs(b.distance - a.distance);
    check(
      '① 左键拖拽 → 环视',
      dAz > 0.15 && dR / a.distance < 0.05,
      `方位角 Δ${dAz.toFixed(3)} rad(需 >0.15),半径 Δ${dR.toFixed(2)}m(需 <5%)`,
    );
  }

  // ── 2. 滚轮 = 推拉 ────────────────────────────────────────────────
  {
    const a = await snap();
    await page.wheel(CX, CY, -600); // 向前滚 = 拉近
    await sleep(700);
    const b = await snap();
    const inRatio = b.distance / a.distance;
    const dAz2 = Math.abs(b.azimuth - a.azimuth);
    check(
      '② 滚轮前滚 → 拉近',
      inRatio < 0.95 && dAz2 < 0.02,
      `半径 ${a.distance.toFixed(2)} → ${b.distance.toFixed(2)}m(比 ${inRatio.toFixed(3)},需 <0.95),方位角 Δ${dAz2.toFixed(4)}`);

    await page.wheel(CX, CY, 900); // 向后滚 = 推远
    await sleep(700);
    const c = await snap();
    check(
      '② 滚轮后滚 → 推远',
      c.distance > b.distance * 1.02,
      `半径 ${b.distance.toFixed(2)} → ${c.distance.toFixed(2)}m`,
    );
  }

  // ── 3. 右键拖拽 = 平移 ────────────────────────────────────────────
  {
    const a = await snap();
    await drag([CX, CY], [CX + 240, CY], 'right');
    const b = await snap();
    const targetMoved = Math.hypot(
      b.target[0] - a.target[0],
      b.target[1] - a.target[1],
      b.target[2] - a.target[2],
    );
    const dR2 = Math.abs(b.distance - a.distance);
    check(
      '③ 右键拖拽 → 平移',
      targetMoved > 0.5 && dR2 / a.distance < 0.05,
      `目标点位移 ${targetMoved.toFixed(2)}m(需 >0.5),半径 Δ${dR2.toFixed(2)}m(需 <5%)`,
    );
  }

  // ── 4. 键盘 W/S = 推进 ────────────────────────────────────────────
  {
    // 先复位到一个确定的机位,免得上一步的平移把方向搞乱
    await page.evaluate(
      `(() => { const T = window.__QM__.THREE;
                window.__QM__.director.place(new T.Vector3(26,14,30), new T.Vector3(0,4,0)); })()`,
    );
    await sleep(300);

    const a = await snap();
    await holdKey('KeyW', 'w', 700);
    const b = await snap();
    const dW = Math.hypot(
      b.position[0] - a.position[0],
      b.position[1] - a.position[1],
      b.position[2] - a.position[2],
    );
    // W 的语义:目标点不动,相机沿视线水平投影靠近它 ⇒ **观察半径缩短**
    const tgtMoved = Math.hypot(
      b.target[0] - a.target[0],
      b.target[1] - a.target[1],
      b.target[2] - a.target[2],
    );
    check(
      '④ 键盘 W → 靠近目标',
      dW > 0.5 && b.distance < a.distance - 0.3,
      `相机位移 ${dW.toFixed(2)}m,观察半径 ${a.distance.toFixed(2)} → ${b.distance.toFixed(2)}m(需缩短)`,
    );
    check('④ 按 W 时目标点不动', tgtMoved < 0.01, `目标点位移 ${tgtMoved.toFixed(5)}m(需 ≈0)`);

    const c0 = await snap();
    await holdKey('KeyS', 's', 700);
    const c1 = await snap();
    const dS = Math.hypot(
      c1.position[0] - c0.position[0],
      c1.position[1] - c0.position[1],
      c1.position[2] - c0.position[2],
    );
    check(
      '④ 键盘 S → 远离目标',
      dS > 0.5 && c1.distance > c0.distance + 0.3,
      `相机位移 ${dS.toFixed(2)}m,观察半径 ${c0.distance.toFixed(2)} → ${c1.distance.toFixed(2)}m(需变长)`,
    );

    // A/D 是绕行:半径基本不变、方位角变化
    const e0 = await snap();
    await holdKey('KeyD', 'd', 600);
    const e1 = await snap();
    const dAz4 = Math.abs(((e1.azimuth - e0.azimuth + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    check(
      '④ 键盘 D → 绕目标横行',
      dAz4 > 0.05 && Math.abs(e1.distance - e0.distance) < 0.6,
      `方位角 Δ${dAz4.toFixed(3)} rad(需 >0.05),半径 Δ${Math.abs(e1.distance - e0.distance).toFixed(3)}m(需 <0.6)`,
    );
  }

  // ── 汇总 ──────────────────────────────────────────────────────────
  const outPath = resolve(process.cwd(), OUT);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({ url: URL, results, loadReport }, null, 2));

  console.log('─'.repeat(78));
  for (const r of results) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.name}`);
    console.log(`     ${r.detail}`);
  }
  console.log('─'.repeat(78));
  const failed = results.filter((r) => !r.pass);
  console.log(`通过 ${results.length - failed.length}/${results.length}   数据: ${outPath}`);

  await close();
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  console.error('❌ 验证失败:', err.message);
  await close();
  process.exit(1);
}
