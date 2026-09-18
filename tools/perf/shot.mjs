#!/usr/bin/env node
/**
 * 无头截图工具。
 *
 * 它不只是"拍张图",而是同时做三件校验 —— 这是本作品"数据必须真实"
 * 这条约束在工具层的落点:
 *   1. 渲染器必须是真 GPU(ANGLE/NVIDIA),退到 SwiftShader 就直接失败退出;
 *   2. 画面必须非空白(像素统计,不靠肉眼);
 *   3. 控制台不能有未捕获异常。
 *
 * 用法:
 *   node tools/perf/shot.mjs --url http://127.0.0.1:4173/ --out screenshots/web/p0.png
 *   node tools/perf/shot.mjs --url ... --out ... --w 390 --h 844 --mobile
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { launch, sleep } from './lib/cdp.mjs';

function parseArgs(argv) {
  const a = {
    url: 'http://127.0.0.1:4173/',
    out: 'screenshots/web/shot.png',
    w: 1600,
    h: 900,
    dsf: 1,
    warmup: 4000,
    mobile: false,
    allowSoftware: false,
    noBlankCheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--url') a.url = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--w') a.w = Number(argv[++i]);
    else if (k === '--h') a.h = Number(argv[++i]);
    else if (k === '--dsf') a.dsf = Number(argv[++i]);
    else if (k === '--warmup') a.warmup = Number(argv[++i]);
    else if (k === '--mobile') a.mobile = true;
    else if (k === '--allow-software') a.allowSoftware = true;
    else if (k === '--no-blank-check') a.noBlankCheck = true;
    else if (k === '--help' || k === '-h') {
      console.log(
        '用法: node tools/perf/shot.mjs --url <URL> --out <PNG> [--w 1600] [--h 900]\n' +
          '                                [--dsf 1] [--warmup 4000] [--mobile]',
      );
      process.exit(0);
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const outPath = resolve(process.cwd(), args.out);

const problems = [];

const { page, close, browserVersion } = await launch({
  width: args.w,
  height: args.h,
  deviceScaleFactor: args.dsf,
  mobile: args.mobile,
  allowSoftware: args.allowSoftware,
});

try {
  const consoleErrors = page.collectErrors();

  await page.goto(args.url);
  await page.waitForReady({ timeout: 120000 });

  // 热身:等 PMREM、阴影贴图、LOD 稳定下来再取数,
  // 否则第一帧的开销会污染结果
  await sleep(args.warmup);

  const sample = await page.evaluate(`(() => {
    const qm = window.__QM__;
    if (!qm) return { error: '页面上没有 window.__QM__ 调试接口' };
    const s = qm.sampleCanvas();
    s.gpu = qm.gpu.renderer;
    s.gpuVendor = qm.gpu.vendor;
    s.drawCalls = qm.renderer.info.render.calls;
    s.triangles = qm.renderer.info.render.triangles;
    s.programs = qm.renderer.info.programs ? qm.renderer.info.programs.length : -1;
    s.textures = qm.renderer.info.memory.textures;
    s.geometries = qm.renderer.info.memory.geometries;
    s.frameStats = qm.loop.stats();

    // ⚠️ 记录**实际生效**的状态,而不只是 URL 里写了什么。
    //
    // 这里曾经只记 url 字段,于是"URL 写了 q=high 但页面根本没应用"
    // 这种错查不出来 —— 快照里白纸黑字写着 q=high,读的人(包括我自己)
    // 会当成 high 档的证据。这跟项目里那条"仪表谎报成功比没有仪表更坏"
    // 是同一类错误:记录必须来自**被测物当前的真实状态**,不能来自请求。
    //
    // reflect 目前只能是"画质档位"或"URL 覆盖"二选一的结果,
    // 所以直接读反射器的运行时读数 —— 那是它真正在执行的东西。
    //
    // ⚠️ 这段在模板字符串里,注释里不能出现反引号 —— 会截断字符串。
    const st = qm.store.read();
    // ⚠️ store 的值只说明**状态改没改**,不说明**渲染动没动**。
    //    2026-09-18 踩过:「?tod=」与「?wire=」两个网址参数从来没生效过
    //    (store 里有值、太阳一直停在 day 预设、材质一个没变线框),
    //    而本文件当时只核对了 store,于是每一张带「?tod=」的图都判了通过。
    //    所以下面另取一组**消费者那一侧**的读数,核对时以它为准。
    s.rendererSide = {
      // 太阳高度由仰角算出,是光照参数真的被应用了的最直接证据
      sunY: +qm.skyTime.sun.position.y.toFixed(2),
      sunColor: '#' + qm.skyTime.sun.color.getHexString(),
      // 自己遍历数线框材质,不用 quality.report().wireframeMaterials ——
      // 那个字段在内部分支为假时直接返回 0,分不出"没生效"与"本来就关着"
      wireframeMats: (() => {
        let n = 0;
        qm.scene.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          for (const m of [].concat(o.material)) if (m && m.wireframe) n++;
        });
        return n;
      })(),
      // 画质三档之间的差别落在这些量上(阴影尺寸/人物名额/粒子密度),
      // 光看 pixelRatio 与 drawingBuffer 分不开 mid 与 high
      shadowMapSize: qm.quality.report().shadowMapSize,
      charShadows: qm.quality.report().charactersCastingShadow,
      puffs: (qm.fxRuntime() || {}).puffs ?? null,
    };
    s.appliedState = {
      quality: st.quality,
      tod: +st.tod.toFixed(3),
      labels: st.ui.labels,
      hud: st.ui.hud,
      wireframe: st.ui.wireframe,
      // 反射的真实档位:rtSize / everyNFrames / 开关,全取自反射器自己
      river: qm.riverRuntime ? qm.riverRuntime() : null,
      camera: (() => { const p = qm.camera.position; return [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)]; })(),
    };
    return s;
  })()`);

  await page.screenshot(outPath);

  // 状态快照:便于事后核对「这张图是在什么状态下拍的」
  const statePath = outPath.replace(/\.png$/i, '.state.json');
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify(
      { url: args.url, viewport: { w: args.w, h: args.h, dsf: args.dsf, mobile: args.mobile }, sample },
      null,
      2,
    ),
  );

  // —— 校验 ——
  if (sample.error) {
    problems.push(sample.error);
  } else {
    if (sample.isSoftwareRenderer) {
      problems.push(
        `拿到的是软件渲染器(${sample.gpu}),性能数据无效。` +
          `请检查 --use-angle=d3d11 / 驱动是否可用。`,
      );
    }
    if (!/ANGLE|NVIDIA|AMD|Intel|Direct3D/i.test(String(sample.gpu))) {
      problems.push(`GPU 标识串异常: ${sample.gpu}`);
    }
    if (!args.noBlankCheck && sample.nonUniformRatio < 0.3) {
      problems.push(
        `画面疑似空白:非背景像素占比仅 ${(sample.nonUniformRatio * 100).toFixed(1)}%` +
          `(阈值 30%),标准差 ${sample.stdDev}`,
      );
    }

    // —— URL 参数**真的落地了吗** ——
    //
    // 光把实际状态记进快照还不够:快照要人去看。这里直接拿 URL 里声明的
    // 期望值与页面当前的真实状态对一遍,**对不上就判失败**。
    // 起因是真实踩过的坑:`readUrlState()` 解析了 `q/tod/tags/hud/wire`
    // 但没有任何地方消费,于是所有带 `?q=high` 的截图都是 mid 档的,
    // 而快照里 `url` 字段写着 `q=high` —— 一个会撒谎的仪表。
    const want = new URL(args.url).searchParams;
    const got = sample.appliedState;
    if (got) {
      const expectQ = want.get('q');
      if (expectQ && got.quality !== expectQ) {
        problems.push(`URL 要求 q=${expectQ},实际生效 quality=${got.quality} —— 参数没被应用`);
      }
      const expectTod = want.get('tod');
      if (expectTod !== null) {
        if (Math.abs(got.tod - Number(expectTod)) > 0.02) {
          problems.push(`URL 要求 tod=${expectTod},实际生效 tod=${got.tod} —— 参数没被应用`);
        }
        // 再核一遍**渲染侧**:太阳高度必须就是个被应用过的值。
        // 光看 store 正是本项目栽过的那个坑(见上方 rendererSide 的说明)。
        const rs = sample.rendererSide;
        if (!rs || !(rs.sunY > 0)) {
          problems.push(`太阳高度读数为 ${rs ? rs.sunY : '(未取到)'} —— 光照参数没落到光源上`);
        }
      }
      for (const [k, field] of [['tags', 'labels'], ['hud', 'hud'], ['wire', 'wireframe']]) {
        const v = want.get(k);
        if (v === null) continue;
        const exp = v === '1' || v === 'true';
        if (got[field] !== exp) {
          problems.push(`URL 要求 ${k}=${v},实际生效 ${field}=${got[field]} —— 参数没被应用`);
        }
        // 线框另核渲染侧:store 说开了、材质一个都没变,就是没生效
        const rs = sample.rendererSide;
        if (k === 'wire' && rs) {
          if (exp && rs.wireframeMats === 0) {
            problems.push(`URL 要求 wire=1,但场景里一个线框材质都没有 —— 开关没落到材质上`);
          }
          if (!exp && rs.wireframeMats > 0) {
            problems.push(`URL 要求 wire=0,但仍有 ${rs.wireframeMats} 个线框材质`);
          }
        }
      }
      // 画质:三档之间的差别不在像素比上,在阴影尺寸与粒子密度上。
      // 这里只做一次**档位自洽**核对,不硬编码期望值(那会变成第二个真相源)。
      const rs = sample.rendererSide;
      if (rs && got.quality === 'low' && rs.shadowMapSize !== 0) {
        problems.push(`low 档应当没有阴影贴图,实测 shadowMapSize=${rs.shadowMapSize}`);
      }
      if (rs && want.get('q') === 'high' && rs.puffs === 0) {
        problems.push(`high 档的炊烟应当有在画的,实测 0 团 —— 画质没落到子系统上`);
      }
      // 反射:URL 覆盖与"画质档位"必须一致,否则 `?reflect=` 是空转的
      const expectRefl = want.get('reflect');
      if (expectRefl !== null && got.river && got.river.mounted) {
        const exp = expectRefl === '1' || expectRefl === 'true';
        if (got.river.enabled !== exp) {
          problems.push(
            `URL 要求 reflect=${expectRefl},实际反射 enabled=${got.river.enabled} —— 覆盖没生效`,
          );
        }
      }
    } else {
      problems.push('页面没有暴露 appliedState,无法核对 URL 参数是否生效');
    }
  }
  if (consoleErrors.length) {
    problems.push(...consoleErrors);
  }

  // —— 报告 ——
  console.log('─'.repeat(64));
  console.log(`截图      : ${outPath}`);
  console.log(`状态快照  : ${statePath}`);
  console.log(`浏览器    : ${browserVersion}`);
  console.log(`视口      : ${args.w}×${args.h} @${args.dsf}x${args.mobile ? ' (移动模拟)' : ''}`);
  if (!sample.error) {
    console.log(`GPU       : ${sample.gpu}`);
    console.log(`GPU 厂商  : ${sample.gpuVendor}`);
    console.log(
      `画面      : ${sample.width}×${sample.height}  均色 rgb(${sample.meanColor.join(',')})` +
        `  标准差 ${sample.stdDev}  非背景占比 ${(sample.nonUniformRatio * 100).toFixed(1)}%`,
    );
    console.log(
      `DrawCall  : ${sample.drawCalls}   三角面: ${sample.triangles.toLocaleString()}` +
        `   着色器程序: ${sample.programs}   贴图: ${sample.textures}   几何: ${sample.geometries}`,
    );
    const fs = sample.frameStats;
    console.log(
      `帧时      : p50 ${fs.p50}ms  p95 ${fs.p95}ms  max ${fs.max}ms  平均 ${fs.avgFps}fps` +
        `  (共 ${fs.frames} 帧)`,
    );
    // 实际生效的状态 —— 这张图是在什么档位下拍的,一眼可查
    const g = sample.appliedState;
    if (g) {
      console.log(
        `生效状态  : 画质 ${g.quality}  时辰 ${g.tod}  标签 ${g.labels ? 1 : 0}` +
          `  HUD ${g.hud ? 1 : 0}  线框 ${g.wireframe ? 1 : 0}  机位 ${g.camera.join(', ')}`,
      );
      if (g.river) {
        // 关着的时候**不要**打 RT 尺寸。
        //
        // 早先无条件打,于是 `?q=high&reflect=0` 会印出
        // "关  RT 512×256  每 1 帧" —— 尺寸是 mid 档留下的旧值、帧距是
        // high 档的,两个档位的读数拼在一行里,看着像 high 用的是 512。
        // 关掉时那张 RT 是残留物,不是配置;要报就报"没在用"。
        const size = g.river.enabled
          ? `RT ${g.river.rtSize.join('×')}`
          : 'RT 未使用(反射关闭,残余尺寸不具意义)';
        console.log(
          g.river.mounted
            ? `水面反射  : ${g.river.enabled ? '开' : '关'}  ${size}` +
              `  每 ${g.river.everyNFrames} 帧  已渲染 ${g.river.reflectionPasses} 次` +
              `  跳过 ${g.river.skippedPasses} 次  入反射 ${g.river.reflectLayerObjects} 个`
            : '水面反射  : 未挂载(场景里没有 qm_kind=water 的网格)',
        );
      }
    }
  }
  console.log('─'.repeat(64));

  if (problems.length) {
    console.error('\n❌ 校验未通过:');
    for (const p of problems) console.error(`   · ${p}`);
    await close();
    process.exit(1);
  }

  console.log('✅ 校验通过:真实 GPU、画面非空白、URL 参数已落地、无控制台异常');
  await close();
  process.exit(0);
} catch (err) {
  console.error('❌ 截图失败:', err.message);
  if (problems.length) for (const p of problems) console.error(`   · ${p}`);
  await close();
  process.exit(1);
}
