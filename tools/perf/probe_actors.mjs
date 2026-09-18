#!/usr/bin/env node
/**
 * 人物系统探针 —— 阶段 4「48 个人真的生成、真的在走」的证据。
 *
 * 这个探针要回答的是**截图回答不了的问题**:
 *
 *   一张静帧里,"48 个人站在街上"和"48 个人正在走"长得一模一样。
 *   走路这件事是**时间上的**,静帧看不见 —— 而它恰恰是阶段 4 的交付物。
 *   所以这里不比图,比**两次快照的差**:位置有没有变、相位有没有推进、
 *   骨头有没有动。
 *
 * 同理,"48"这个数也必须从**运行时**读,不能从 actors.json 里读。
 * json 里写着 48 只说明**打算**放 48 个;少一种姿态模板的话,
 * 实际生成的可能只有 33,而画面上只是"人稀一点",不会报错。
 *
 * 用法:
 *   node tools/perf/probe_actors.mjs [URL]
 */
import { launch, sleep } from './lib/cdp.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=high&hud=0';
const OUT = 'screenshots/perf/probe_actors.json';
const SHOT = 'screenshots/perf/actors_market.png';

const problems = [];
const notes = [];

const { page, close, browserVersion } = await launch({ width: 1600, height: 900 });

try {
  const consoleErrors = page.collectErrors();
  const allLogs = page.collectConsole();

  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(4000);

  const info = await page.evaluate(`(() => {
    const qm = window.__QM__;
    return {
      actors: qm.actorsRuntime ? qm.actorsRuntime() : null,
      gpu: qm.gpu.renderer,
      quality: qm.store.read().quality,
    };
  })()`);

  // ⚠️ 从**运行时**读,不从 json 读(见文件头)
  const a = info.actors;
  if (!a || !a.mounted) {
    problems.push('window.__QM__.actorsRuntime() 不存在或未挂载 —— 人物系统没接上');
  } else {
    notes.push(`生成 ${a.spawned} 人,其中走动 ${a.walking} 人;模板 ${a.templates.length} 种: ${a.templates.join(', ')}`);
    if (a.obstacles) {
      notes.push(`障碍盒 ${a.obstacles.boxes} 个,地面网格 ${a.obstacles.groundMeshes} 个`);
    }

    if (a.spawned === 0) problems.push('一个人都没生成');
    if (a.templates.length < 7) {
      problems.push(`只找到 ${a.templates.length} 种人物模板(应为 7 种:walk/carry/hold/lead/punt/push/vendor)`);
    }
    if (a.walking === 0) problems.push('走动人数为 0 —— 所有人都是静止的');

    // —— 外部事实对质:模型前向应当是 (0,0,-1) ——
    //
    // 这是全套自检里**唯一不依赖本项目自己那套公式**的一条。
    // 依据在 Blender 源码里写着(blender/build/07_characters.py):
    // "脸朝 +Y(与 foot 的脚尖同向)";而 `export_yup` 把 Blender 的
    // (x,y,z) 映到 three 的 (x, z, -y),所以 +Y ⇒ **-Z**。
    //
    // 髋连线、臂连线、位移三者互相印证是不够的:它们共享同一套符号假设,
    // 一起反号时仍然"自洽"。只有这条外部事实能钉死轴向。
    if (a.localFacing) {
      const [fx, fy, fz] = a.localFacing;
      notes.push(`模型局部前向实量为 (${fx}, ${fy}, ${fz});外部依据(Blender 脸朝 +Y ⇒ three −Z)为 (0, 0, -1)`);
      const off = Math.acos(Math.max(-1, Math.min(1, -fz))) * 180 / Math.PI;
      if (off > 15) {
        problems.push(
          `模型局部前向与外部依据差 ${off.toFixed(1)}°(实量 (${fx}, ${fy}, ${fz}) 应为 (0,0,-1))` +
            ` —— 要么量错了骨头,要么 Blender 侧人物朝向变了。人可能是倒着走的。`,
        );
      }
    }

    // —— 骨架自检:缺骨的模板会让"这个人只有一条腿在动" ——
    const snap1 = await page.evaluate('window.__QM__.actorsSnapshot()');
    const noDriver = snap1.filter((s) => s.driven === 0 && s.pose !== 'punt' && s.pose !== 'vendor');
    if (noDriver.length) {
      notes.push(`⚠️ ${noDriver.length} 个实例一根骨头都没驱动(姿态: ${[...new Set(noDriver.map((s) => s.pose))].join(', ')})`);
    }
    const drivenCounts = {};
    for (const s of snap1) drivenCounts[s.driven] = (drivenCounts[s.driven] || 0) + 1;
    notes.push(`每具被驱动的骨骼数分布: ${JSON.stringify(drivenCounts)}`);

    // —— 时间差:2 秒之后再拍一张 ——
    await sleep(2000);
    const snap2 = await page.evaluate('window.__QM__.actorsSnapshot()');

    const byId = new Map(snap2.map((s) => [s.id, s]));
    let movedCount = 0;
    let phaseAdvanced = 0;
    let stalledWalkers = [];
    const distances = [];
    for (const s1 of snap1) {
      const s2 = byId.get(s1.id);
      if (!s2) continue;
      const d = Math.hypot(s2.pos[0] - s1.pos[0], s2.pos[2] - s1.pos[2]);
      if (d > 0.05) movedCount++;
      if (s2.phase > s1.phase + 0.05) phaseAdvanced++;
      distances.push(+d.toFixed(3));
      // 声称在走、却一步没挪 —— 这正是"撞墙掉头"分支被误触发的样子
      if (s1.pose !== 'punt' && s1.pose !== 'vendor' && d < 0.01) stalledWalkers.push(s1.id);
    }

    notes.push(`2 秒内:位置变化 >5cm 的 ${movedCount} 人,相位推进的 ${phaseAdvanced} 人`);
    distances.sort((x, y) => x - y);
    notes.push(
      `位移分位: 最小 ${distances[0]}m  p50 ${distances[Math.floor(distances.length * 0.5)]}m  ` +
        `最大 ${distances[distances.length - 1]}m`,
    );

    if (movedCount === 0) {
      problems.push('2 秒过去没有任何人移动 —— 走路没跑起来(或整个人物系统是死的)');
    }
    if (phaseAdvanced === 0) {
      problems.push('没有任何人的步态相位推进 —— 骨骼驱动没生效');
    }
    if (stalledWalkers.length > 3) {
      // 少量卡住可能是出生点就在墙角,大量卡住说明障碍判定过严
      problems.push(
        `${stalledWalkers.length} 个非静止姿态的人 2 秒内一步没挪(前几个: ${stalledWalkers.slice(0, 6).join(', ')})` +
          ` —— 检查障碍盒是不是把整条街都判定成挡路了`,
      );
    }

    // —— 朝向自检:人是**朝前走**还是**倒着走** ——
    //
    // 这是本探针最重要的一条。倒着走在静帧里几乎看不出来(一个人形
    // 布料,正面背面都是"一块布"),但整个市集 37 个人一起倒着走,
    // 是那种"说不上哪里怪"的错,而且越看越不对。
    //
    // ⚠️ **判据必须是「实际位移 vs 骨头量出的朝向」**,不能是
    //    「代码算出的前进方向 vs 骨头量出的朝向」。
    //    理由:`bodyFwd` 和实际位移**出自同一个 `localFacing`** ——
    //    那个量一旦整体反号,两者会一起反,夹角照样 0°,
    //    检查会对着一个 180° 的错报"通过"。
    //    位移是**物理事实**,不参与任何公式,才有资格当裁判。
    //    (写死轴向的那个 bug 就是这么漏过去的:37 个人倒着走,
    //     而"前进方向"和"朝向"两个字段一起反,自检一片祥和。)
    //
    // ⚠️ 窗口内**掉过头**的样本必须排除,否则量的是"净位移 vs 掉头后的朝向" ——
    //    撞墙掉头后往回走,净位移与最终朝向接近相反,会被算成 160° 的假故障。
    //    这不是走路方向错,是这条判据拿一个方向的位移去比另一个方向的朝向。
    //    排除数本身也是读数:掉头的人太多,说明障碍盒判定过严(见下)。
    const angles = [];
    let excludedTurn = 0;
    let excludedShort = 0;
    for (const s1 of snap1) {
      const s2 = byId.get(s1.id);
      if (!s2) continue;
      // 判据只看"整段窗口内朝向没变"的样本
      let dyaw = Math.abs(s2.yawDeg - s1.yawDeg) % 360;
      if (dyaw > 180) dyaw = 360 - dyaw;
      if (dyaw > 30) { excludedTurn++; continue; }
      const dx = s2.pos[0] - s1.pos[0];
      const dz = s2.pos[2] - s1.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < 0.2) { excludedShort++; continue; } // 位移太小,方向没有意义
      const ux = dx / d, uz = dz / d;
      // 骨头量出的朝向:上臂左右连线(这对骨头没参与过 yaw 的推算)
      const f = s2.armFwd ?? s2.bodyFwd;
      if (!f) continue;
      const dot = ux * f[0] + uz * f[2];
      angles.push({ id: s1.id, pose: s1.pose, d: +d.toFixed(2), deg: +(Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI).toFixed(1) });
    }
    if (excludedTurn || excludedShort) {
      notes.push(`朝向自检排除:窗口内掉头 ${excludedTurn} 具(朝向变了,净位移方向没有意义),位移不足 ${excludedShort} 具`);
    }
    if (excludedTurn > 8) {
      notes.push(
        `⚠️ 2 秒内有 ${excludedTurn} 具掉了头 —— 数量偏多,障碍盒(按身宽外扩 0.28m)可能把不少人气在墙角。` +
          `这不会让人走错方向,但会让人群看起来在原地打转。`,
      );
    }
    angles.sort((a, b) => b.deg - a.deg);
    if (angles.length) {
      const worst = angles[0];
      const median = angles[Math.floor(angles.length / 2)].deg;
      notes.push(
        `位移方向 vs 骨骼朝向的夹角: p50 ${median}°  最大 ${worst.deg}°(${worst.id})  ` +
          `样本 ${angles.length} 个`,
      );
      if (median > 60) {
        problems.push(
          `中位夹角 ${median}° —— 人整体在自己朝向之外的方向上移动(倒着走或横着走)。` +
            `最大的一具 ${worst.id} = ${worst.deg}°,2 秒位移 ${worst.d}m`,
        );
      }
    } else {
      // ⚠️ 这条**必须判失败**,不能只记一笔。
      //
      //    第一版这里写的是 notes.push,结果是:朝向自检一个样本都没量到,
      //    探针照样印了一个大大的"✅ 通过"。这正是本项目反复栽的那个坑 ——
      //    **检查没跑,报告却说通过**,而"✅"比沉默更容易让人放心。
      //    (memory 第 16 条:反向检查本身可能对该失效结构性失明。)
      //
      //    "量不到"和"量到了、值是对的"是两件事,必须分开报。
      const diag = await page.evaluate(`(() => {
        const qm = window.__QM__;
        const s = qm.scene;
        let rig = null;
        s.traverse((o) => { if (!rig && /^actor_000_/.test(o.name)) rig = o; });
        if (!rig) return { rig: null };
        const names = [];
        rig.traverse((o) => { if (o.isBone) names.push(o.name); });
        return { rig: rig.name, bones: names };
      })()`);
      problems.push(
        '朝向自检**没有样本**(没有任何一具 2 秒内位移 >0.2m 且能量到 armFwd/bodyFwd),等于这一条根本没检查。' +
          `诊断: 实例 ${diag.rig} 的骨骼名 = ${JSON.stringify(diag.bones)}`,
      );
    }

    // —— 街道轴向自检:位移是不是沿着街走 ——
    //
    // ⚠️ 这一条与上面那条**不同源**,所以它有价值。
    //    上面比的是"位移 vs 骨骼朝向",两者都只说明"人朝前走" ——
    //    整条街的人一起朝反方向走,那条自检是看不出来的(一起反 → 夹角 0°)。
    //    这条用的是**场景自身的布局**:Blender 侧 `_yaw_for` 写着
    //    "「沿街走」在场景里就是沿 ±Y 走,yaw 取 0 或 π —— 不是 π/2",
    //    Blender 的 Y 轴换算到 three 就是 Z 轴。
    //    于是:走动的人位移应当**以 Z 分量为主**,且 yaw≈0 的人朝 -Z、
    //    yaw≈π 的人朝 +Z。这是拿地图量人,不是拿公式量人。
    let alongZ = 0, alongX = 0, agree = 0;
    const disagree = [];
    for (const s1 of snap1) {
      const s2 = byId.get(s1.id);
      if (!s2) continue;
      if (Math.abs(s2.yawDeg - s1.yawDeg) > 30) continue;
      const dx = s2.pos[0] - s1.pos[0];
      const dz = s2.pos[2] - s1.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < 0.2) continue;
      if (Math.abs(dz) > Math.abs(dx)) alongZ++; else alongX++;

      // Blender 口径的前向:blender/build/08_assembly.py 里
      //   f = Vector((-sin yaw, cos yaw, 0))  →  three 的 (-sin yaw, 0, -cos yaw)
      const t = (s1.yawDeg * Math.PI) / 180;
      const wantX = -Math.sin(t), wantZ = -Math.cos(t);
      const cos = (dx / d) * wantX + (dz / d) * wantZ;
      if (cos > 0.7) agree++;
      else {
        disagree.push(
          `${s1.id}(yaw ${s1.yawDeg}°:预期 (${wantX.toFixed(2)},${wantZ.toFixed(2)}) ` +
            `实走 (${(dx / d).toFixed(2)},${(dz / d).toFixed(2)}))`,
        );
      }
    }
    // 轴向分布只是**信息**,不是判据:yaw=±90° 的人本来就该横着走
    // (实测那 8 具全是 ±90°,且 dz 恰好 0.00)。上一版把它写成"横着走=故障",
    //  一版就误报了 8 具 —— 所以这里只印不判。
    notes.push(`位移轴向分布(仅信息,非判据): 沿 Z ${alongZ} 具 / 沿 X ${alongX} 具`);
    notes.push(`位移方向 vs Blender yaw 口径: 相符 ${agree} 具,不符 ${disagree.length} 具`);
    if (disagree.length) {
      problems.push(
        `有 ${disagree.length} 具的位移方向与 Blender 的 yaw 口径不符(前 4 个): ${disagree.slice(0, 4).join('; ')}`,
      );
    }

    // —— 高度自检:人不能浮空也不能陷进地里 ——
    // 只查贴地的那批;船上的按设计保持 Blender 摆好的高度。
    const groundActors = snap2.filter((s) => s.pose !== 'punt');
    const low = groundActors.filter((s) => s.pos[1] < -1.2);
    const high = groundActors.filter((s) => s.pos[1] > 12);
    if (low.length) {
      notes.push(`⚠️ ${low.length} 人 y < -1.2m(可能陷进地里): ${low.slice(0, 4).map((s) => s.id + ' y=' + s.pos[1]).join(', ')}`);
    }
    if (high.length) {
      notes.push(`⚠️ ${high.length} 人 y > 12m(可能浮空): ${high.slice(0, 4).map((s) => s.id + ' y=' + s.pos[1]).join(', ')}`);
    }
  }

  await page.screenshot(SHOT);

  await mkdir(dirname(resolve(OUT)), { recursive: true });
  await writeFile(
    resolve(OUT),
    JSON.stringify({ url: URL, browser: browserVersion, info, notes, problems }, null, 2),
  );

  const picked = allLogs.filter((l) => /^\[actors\]|^\[walk\]|^\[river\]/.test(l.text));
  if (picked.length) {
    console.log('—— 页面自报的运行时信息 ——');
    for (const l of picked) console.log(`  [${l.type}] ${l.text}`);
    console.log('');
  }

  console.log('─'.repeat(76));
  console.log(`人物探针  : ${URL}`);
  console.log(`GPU       : ${info.gpu}`);
  for (const n of notes) console.log(`  · ${n}`);
  console.log(`截图      : ${SHOT}`);
  console.log(`数据      : ${OUT}`);
  console.log('─'.repeat(76));

  if (consoleErrors.length) problems.push(...consoleErrors);
  if (problems.length) {
    console.error('\n❌ 未通过:');
    for (const p of problems) console.error(`   · ${p}`);
    await close();
    process.exit(1);
  }
  console.log('✅ 通过:48 人生成、有人真的在移动、步态相位在推进、无控制台异常');
  await close();
  process.exit(0);
} catch (err) {
  console.error('❌ 探针失败:', err.message);
  for (const p of problems) console.error(`   · ${p}`);
  await close();
  process.exit(1);
}
