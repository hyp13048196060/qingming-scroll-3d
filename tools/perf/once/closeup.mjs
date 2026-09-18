#!/usr/bin/env node
/**
 * 人物近景 —— 回答**截图才能回答**的那部分问题。
 *
 * 探针能回答"人在不在动、朝哪走";它回答不了:
 *   · 脚是不是踩在地上(悬空/陷进地里);
 *   · 程序化摆动有没有把肢体拧成麻花;
 *   · 近看有没有可观察的细节(计划书的"近景要看得清")。
 *
 * 这三条都只能**看**。远观截图里人只有几个像素,看不出这些 ——
 * 所以专门把相机飞到某一具人物跟前拍一张。
 *
 * 用 `director.flyTo()` 而不是直接改 `camera.position`:相机归
 * CameraDirector 独占,每帧它都会重写位置,自己设的会被立刻盖掉。
 *
 * 用法:
 *   node tools/perf/once/closeup.mjs [姿态] [第几具]
 *   例: node tools/perf/once/closeup.mjs vendor 0
 */
import { launch, sleep } from '../lib/cdp.mjs';

const POSE = process.argv[2] || 'vendor';
const NTH = Number(process.argv[3] || 0);
const URL = process.argv[4] || 'http://127.0.0.1:4173/?q=high&hud=0';
const OUT = `screenshots/perf/closeup_${POSE}.png`;

const { page, close } = await launch({ width: 1400, height: 900 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(3000);

  const info = await page.evaluate(`(() => {
    const qm = window.__QM__;
    // ⚠️ 上一版直接按数组下标取人,取到 actor_003 —— 它在 x≈49 的场地边缘,
    //    相机飞过去正好落在**building 内部**,截图是一面墙的内壁。
    //    所以要按"离市集中心多远"排序:中心区才是人要看的近景,
    //    边缘那几具本来就在房子的夹缝里。排序而不是瞎试,试出来的
    //    "第几具能看"换个种子就变了。
    const snap = qm.actorsSnapshot()
      .filter((s) => s.pose === ${JSON.stringify(POSE)})
      .map((s) => ({ ...s, _d: Math.hypot(s.pos[0], s.pos[2]) }))
      .sort((a, b) => a._d - b._d);
    const s = snap[${NTH}];
    if (!s) return { err: '没有这种姿态的人物', poses: [...new Set(qm.actorsSnapshot().map((x) => x.pose))] };
    // 站到人物**前方偏右**约 3m、高 1.6m 处看他 —— 太正会正好被身体挡成一根柱子。
    // 用 bodyFwd 决定"前方";量不到就退到世界 +Z。
    const f = s.bodyFwd || [0, 0, 1];
    const rx = -f[2], rz = f[0];              // 前向的右法向
    const px = s.pos[0] + f[0] * 2.2 + rx * 1.8;
    const pz = s.pos[2] + f[2] * 2.2 + rz * 1.8;
    const py = s.pos[1] + 1.55;
    qm.director.flyTo({
      position: [px, py, pz],
      target: [s.pos[0], s.pos[1] + 0.95, s.pos[2]],
    });
    return { id: s.id, pose: s.pose, pos: s.pos, yawDeg: s.yawDeg, cam: [px, py, pz] };
  })()`);

  if (info.err) {
    console.error('❌', info.err, '现有姿态:', info.poses);
    await close();
    process.exit(1);
  }

  console.log('目标:', JSON.stringify(info));
  await sleep(3500); // 等 flyTo 走完
  await page.screenshot(OUT);
  console.log('截图:', OUT);
} finally {
  await close();
}
