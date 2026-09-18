#!/usr/bin/env node
/**
 * 量地平线:地面在 300m 处戛然而止,那道硬边到底是哪两种颜色撞在一起?
 *
 * 沙盘的地坪是 600×600m(X/Z 各 ±300),再往外就是天。截图里能看到
 * 一条清清楚楚的水平硬边 —— 地到此为止。要把这条边化掉,办法是雾,
 * 可**雾的颜色该取什么、浓度该多大**,不能凭感觉填:
 *
 *   雾的颜色若与地平线附近的天色不一致,地是被雾成了另一种颜色,
 *   边只会从"地/天"变成"雾/天",照样看得见。所以先得知道天是什么色。
 *
 * 做法:沿几根竖线从上往下扫像素,找**相邻两行色差最大**的那一行 ——
 * 那就是地平线,并把它上下各若干像素的平均色报出来。数字有了,雾的
 * 颜色与浓度才是算出来的。
 *
 * ⚠️ 行序按 readPixels 惯例**自下而上**;本脚本对外一律换算成
 *    「从上往下数」的图像坐标再打印,免得再读反一次。
 *
 * 用法: node tools/perf/probe_horizon.mjs [--url http://127.0.0.1:4173/]
 */
import { launch, sleep } from './lib/cdp.mjs';

const args = { url: 'http://127.0.0.1:4173/', sweep: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url') args.url = argv[++i];
  // --sweep 0.002,0.0035,0.005 :同一机位、只改雾浓度,各存一张图,供肉眼比对。
  // 「雾浓到把中景的铺面也洗白了没有」是**看图**才能回答的问题,数答不了,
  // 但可以把几种浓度摆成一组图让人一眼比出来。
  else if (argv[i] === '--sweep') args.sweep = argv[++i].split(',').map(Number);
}

const script = `(async () => {
  const qm = window.__QM__;
  const renderer = qm.renderer, scene = qm.scene, camera = qm.camera, sky = qm.skyTime;
  const gl = renderer.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;

  const frame = async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    renderer.render(scene, camera);
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  };

  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  // 量一个时辰:沿竖线给出**颜色剖面**与最强的几处跳变。
  //
  // ⚠️ 这个函数返过两次工,两次都是"想用一个数字回答一个有歧义的问题":
  //
  //    v1 「全列相邻两行色差最大的一行 = 地平线」
  //        ⇒ 化掉地边之后,全列最大色差往往变成**楼脊或城墙顶**。
  //          同一个数字在改前改后指的不是同一条边,拿它比"改善了多少"是错的。
  //
  //    v2 「第一行偏离顶部天色超过 12 的 = 天际线」
  //        ⇒ 天空本身是**竖直渐变**的。偏离量是慢慢涨上去的,不是跳上去的,
  //          于是它在半空中就超过了阈值,报出一条强度只有 1 的"天际线"。
  //          拿一个平滑渐变当边,等于没有边。
  //
  // 两次都错在同一处:**场景里本来就没有一条唯一的地平线** ——
  // 天与地之间站着一堵墙、一排屋顶、几棵树。硬要压成一个数,选到谁
  // 全看谁的色差大,而那正是会变的东西。
  //
  // 所以现在不挑了:直接把剖面和最强的几处跳变都报出来,**由看图的人
  // 判断哪一处是地边**。数不能替人做这个决定,但可以把它摆清楚。
  const measure = (buf, x) => {
    // readPixels 行序自下而上,这里统一换算成"从上往下"
    const px = (yDown) => {
      const i = ((H - 1 - yDown) * W + x) * 4;
      return [buf[i], buf[i + 1], buf[i + 2]];
    };
    const avg = (y0, y1) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) { const c = px(y); r += c[0]; g += c[1]; b += c[2]; n++; }
      return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
    };

    // 局部跳变:相邻两行的色差之和
    const jumps = [];
    for (let y = 2; y < H - 1; y++) {
      const a = px(y - 1), b = px(y);
      jumps.push({ y, d: Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]) });
    }
    // 取最强的三处,且彼此至少隔 30 行(否则同一道边会被算三次)
    const top = [];
    for (const j of [...jumps].sort((a, b) => b.d - a.d)) {
      if (top.some((t) => Math.abs(t.y - j.y) < 30)) continue;
      top.push(j);
      if (top.length >= 3) break;
    }

    // 每 40 行采一个色,给出自上而下的剖面
    const profile = [];
    for (let y = 0; y < H; y += 40) profile.push({ y, c: avg(y, Math.min(H, y + 6)) });

    return { x, top, profile };
  };

  const cols = [0.25, 0.5, 0.75].map((f) => Math.round(f * W));
  const presets = [];
  for (const name of ['dawn', 'day', 'dusk']) {
    sky.setPreset(name);
    const buf = await frame();
    presets.push({ name, columns: cols.map((x) => measure(buf, x)) });
  }
  sky.setPreset('day');  // 还原

  const fog = scene.fog;
  const fogAt = (d) => (fog && fog.isFogExp2
    ? 1 - Math.exp(-Math.pow(fog.density * d, 2)) : null);

  return {
    canvas: [W, H],
    presets,
    fog: fog ? {
      type: fog.constructor.name,
      // ⚠️ 只能从 getHexString() 取 8 位值。three 的 Color 内部按工作色彩
      //    空间存,**直接读 .r/.g/.b 拿到的是线性值**,乘 255 报出去会暗一大截
      //    (#b9ad93 会被报成 rgb(124,107,74))—— 同一类错在另一个探针里
      //    也犯过一次,别再写第三遍。
      color: '#' + fog.color.getHexString(),
      hex: fog.color.getHexString(),
      density: fog.density,
    } : null,
    fogCurve: [30, 60, 120, 200, 300].map((d) => ({
      d, pct: fogAt(d) === null ? null : Math.round(fogAt(d) * 1000) / 10,
    })),
  };
})()`;

const { page, close } = await launch({ width: 1600, height: 900 });
try {
  await page.goto(args.url);
  await page.waitForReady({ timeout: 120000 });
  await sleep(2500);

  if (args.sweep) {
    // 同一机位、只改雾浓度,各存一张 —— 中景细节被洗掉多少,看图说话
    console.log('雾浓度扫描(只改 density,机位/时辰/画质一律不动)');
    const fogAt = (k, d) => (1 - Math.exp(-Math.pow(k * d, 2))) * 100;
    for (const k of args.sweep) {
      await page.evaluate(`(() => {
        const f = window.__QM__.scene.fog;
        f.density = ${k};
        return f.density;
      })()`);
      await sleep(700);
      const out = `screenshots/web/fog_sweep_${String(k).replace('.', 'p')}.png`;
      await page.screenshot(out);
      console.log(
        `  density ${String(k).padStart(6)}   60m ${fogAt(k, 60).toFixed(1).padStart(5)}%` +
          `   120m ${fogAt(k, 120).toFixed(1).padStart(5)}%` +
          `   300m ${fogAt(k, 300).toFixed(1).padStart(5)}%   → ${out}`,
      );
    }
    console.log();
    console.log('看图判断:中景铺面/彩楼欢门的细节在哪一档开始糊掉,地边在哪一档化开。');
    await close();
    process.exit(0);
  }

  const res = await page.evaluate(script);
  const B = '─'.repeat(78);
  console.log(B);
  console.log(`画布 ${res.canvas[0]}×${res.canvas[1]}(坐标一律"从上往下数")`);
  console.log(B);
  for (const ps of res.presets) {
    console.log(`【${ps.name}】`);
    for (const col of ps.columns) {
      console.log(`  x = ${col.x}   最强的三处跳变(色差强度):`);
      for (const t of col.top) {
        const what = t.d > 90 ? '硬边' : t.d > 40 ? '较明显' : t.d > 18 ? '轻微' : '几乎看不出';
        console.log(`      y=${String(t.y).padStart(4)}   强度 ${String(t.d).padStart(4)}   ${what}`);
      }
      console.log(`      颜色剖面(自上而下,每 40 行):`);
      console.log('      ' + col.profile.map((p) => `y${p.y}:${p.c.join(',')}`).join('  '));
    }
    console.log();
  }
  console.log(B);
  if (res.fog) {
    const frgb = [0, 2, 4].map((i) => parseInt(res.fog.hex.slice(i, i + 2), 16));
    console.log(`当前雾:${res.fog.type}  颜色 ${res.fog.color} = rgb(${frgb.join(',')})  浓度 ${res.fog.density}`);
    console.log('它在各距离上的浓度:');
    for (const f of res.fogCurve) {
      console.log(`   ${String(f.d).padStart(4)} m → ${String(f.pct).padStart(5)}%`);
    }
  } else {
    console.log('⚠️ scene.fog 为空 —— 场景里根本没有雾。');
  }
  console.log();
  console.log('要读的两件事:');
  console.log('  1) 地上色 vs 天上色差多少 —— 差得越多,这条边越显眼;');
  console.log('  2) 300m 处的雾浓度 —— 太低则地面在尽头仍是原色,化不掉边。');
  await page.screenshot('screenshots/web/probe_horizon.png');
  console.log('截图: screenshots/web/probe_horizon.png');
} finally {
  await close();
}
