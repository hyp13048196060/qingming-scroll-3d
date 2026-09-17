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
  }
  console.log('─'.repeat(64));

  if (problems.length) {
    console.error('\n❌ 校验未通过:');
    for (const p of problems) console.error(`   · ${p}`);
    await close();
    process.exit(1);
  }

  console.log('✅ 校验通过:真实 GPU、画面非空白、无控制台异常');
  await close();
  process.exit(0);
} catch (err) {
  console.error('❌ 截图失败:', err.message);
  if (problems.length) for (const p of problems) console.error(`   · ${p}`);
  await close();
  process.exit(1);
}
