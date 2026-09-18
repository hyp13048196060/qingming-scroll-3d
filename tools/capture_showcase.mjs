#!/usr/bin/env node
/**
 * 采集 README / docs 里引用的那套**展示图**。
 *
 * 与 `tools/perf/shot.mjs` 的分工:
 *   · shot.mjs    —— 一次一张,给**测量**用。它卡 GPU 型号、卡 URL 参数是否落地,
 *                    失败即退出,产出的图是"证据"。
 *   · 本脚本      —— 一次一组,给**展示**用。它同样核对参数是否落地(理由见下),
 *                    但一张失败不会中断整组,而是记进 manifest 让人看见。
 *
 * ⚠️ 为什么展示图也要核对 URL 参数:
 *    因为踩过。`readUrlState()` 曾经解析了 `q/tod` 却没有消费方,于是所有带
 *    `?q=high` 的截图**其实都是 mid 档**的,而文件名和快照都写着 high。
 *    图本身"看着挺好",没人会发现。展示图比测量图更危险 —— 它会被放进
 *    README,成为对外的说法。所以每张图都记下**拍的时候真实生效的状态**。
 *
 * 用法(和别的探针一样,不自己起服务):
 *     node scripts/serve-dist.mjs --dir dist --port 4173 &
 *     node tools/capture_showcase.mjs http://127.0.0.1:4173/
 */
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launch, sleep } from './perf/lib/cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:4173/';
const OUT_DIR = resolve(process.cwd(), 'screenshots/showcase');
const W = 1600;
const H = 900;

/**
 * 每组镜头。
 *
 * `ui` 是面板按钮的 `data-panel` 值 —— 用**属性选择器**点它,不按文字点。
 * 按文字点的话,哪天把「舆图」改成「地图」,脚本就静默地点不到东西,
 * 拍出来的还是一张没有面板的"正常"图。
 */
const SHOTS = [
  // —— 五个景点,高画质 ——
  { file: '01-hongqiao', spot: 'bridge', q: 'high', note: '虹桥。全卷的视觉中心,桥面行人、桥下漕船、两岸摊贩在同一画面里。' },
  { file: '02-caochuan', spot: 'boat', q: 'high', note: '漕船。船体、桅杆、篷索与水面反射。' },
  { file: '03-chasi', spot: 'teahouse', q: 'high', note: '茶肆。沿河商铺的立面与幌子。' },
  { file: '04-chengmen', spot: 'gate', q: 'high', note: '城门。城楼、门洞与进出人流。' },
  { file: '05-jieshi', spot: 'market', q: 'high', note: '街市。街巷两侧的屋舍与摊位。' },

  // —— 同一景点,四个时辰 ——
  // 时辰用同一个 spot 与同一个画质,变量只有一个。换景点或换画质的话,
  // 两张图的差异里混着"机位/档位不同",就看不出光照改了没有。
  //
  // ⚠️ 说明文字只写**这套系统真的做了的事**。本作品的时辰是在
  //    `dawn / day / dusk` **三个**预设之间线性插值(见 world/skyTime.ts),
  //    没有夜晚:tod=1 是"太阳仰角 3° 的暮色",不是"月色 + 灯烛"。
  //    早先这张图的说明写的是"夜。月色为主光,灯烛为点光源" ——
  //    两样东西都不存在。图看着暗就顺手写成夜,是**照着观感编机制**。
  { file: '06-chen', spot: 'bridge', q: 'high', tod: '0.05', note: '清晨侧。太阳低、光色偏暖,影子拉长。' },
  { file: '07-wu', spot: 'bridge', q: 'high', tod: '0.50', note: '白昼。太阳最高,阴影收短而深。' },
  { file: '08-hun', spot: 'bridge', q: 'high', tod: '0.80', note: '暮色侧。太阳西斜,屋脊受暖色斜射光。' },
  // 文件名用 `mu`(暮)不用 `ye`(夜)—— 文件名也会被当成说明读,
  // 而这张图不是夜。同一个理由,不给自己留一个"看着像夜"的名字。
  { file: '09-mu', spot: 'bridge', q: 'high', tod: '1.00', note: '暮色最深的一档(太阳仰角 3°)。这是本作品最暗的时刻,仍不是夜晚 —— 没有月光与灯烛。' },

  // —— 画质档位对照 ——
  // 同一个机位、同一个时辰,只改 q。这是 README 里"三档画质"那句话的凭据。
  { file: '10-di', spot: 'bridge', q: 'low', tod: '0.5', note: 'low 档。关阴影、关水面反射、远景 LOD 降级。' },
  { file: '11-zhong', spot: 'bridge', q: 'mid', tod: '0.5', note: 'mid 档。开阴影,水面反射降频。' },
  { file: '12-gao', spot: 'bridge', q: 'high', tod: '0.5', note: 'high 档。全量阴影与实时水面反射。' },

  // —— 界面面板 ——
  { file: '13-yutu', spot: 'bridge', q: 'high', ui: 'map', note: '「舆图」面板:全卷缩略图与当前机位标记。' },
  { file: '14-yuanjuan', spot: 'bridge', q: 'high', ui: 'scroll', note: '「原卷」面板:高清原作对照,可缩放平移到当前景点。' },
  { file: '15-yiju', spot: 'bridge', q: 'high', ui: 'basis', note: '「依据」面板:每个构件的推定依据与不确定度,直接写在界面里。' },
  { file: '16-shezhi', spot: 'bridge', q: 'high', ui: 'settings', note: '「设置」面板:画质、时辰、标签、线框、HUD。' },

  // —— 移动端 ——
  { file: '17-yidong', spot: 'bridge', q: 'mid', mobile: true, w: 390, h: 844, note: '移动端竖屏。工具栏折行、面板改为全宽。' },
];

const problems = [];
const manifest = [];

/**
 * 把 URL 里声明的期望值与页面**真实生效**的状态对一遍。
 * 与 shot.mjs 里那段是同一个理由,但这里不中断整组 —— 记下来继续拍,
 * 最后统一报。整组中断的话,后半段的图会缺,而缺图容易被当成"没拍"。
 *
 * ⚠️ 2026-09-18:这个函数第一版只对了 `store` 的读数,于是
 *    `?tod=0.2 / 0.78 / 0.95` 四张**全是白天**的图被判为"参数已落地"。
 *    store 有值不等于渲染动了 —— 这一条现在写进判据里:
 *    凡是声称改了画面的参数,都要在**消费者那一侧**再核一次。
 */
function auditState(url, applied) {
  const want = new URL(url).searchParams;
  const rs = applied.rendererSide;
  const bad = [];
  const expectQ = want.get('q');
  if (expectQ && applied.quality !== expectQ) {
    bad.push(`URL 要 q=${expectQ},实际 store 里是 ${applied.quality}`);
  }
  const expectTod = want.get('tod');
  if (expectTod !== null) {
    if (Math.abs(applied.tod - Number(expectTod)) > 0.02) {
      bad.push(`URL 要 tod=${expectTod},实际 store 里是 ${applied.tod}`);
    } else if (rs && !(rs.sunY > 0)) {
      // store 对上了,但光照参数没落到光源上 —— 正是上面说的那种情况
      bad.push(`store 的 tod 是 ${applied.tod},但太阳高度读数为 ${rs.sunY} —— 没落到渲染侧`);
    }
  }
  return bad;
}

const { page, close, browserVersion } = await launch({ width: W, height: H });
console.log(`浏览器: ${browserVersion}`);
console.log(`服务:   ${BASE}`);
console.log(`输出:   ${OUT_DIR}\n`);

// 每次跑都清掉上次的产物。
//
// 不清的话,改名/删掉一个镜头之后,旧文件会**留在目录里**并继续被 git 跟踪 ——
// manifest 里没有它,README 也不引用它,但它就是在那儿,没人说得清是怎么来的。
await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

try {
  for (const [i, shot] of SHOTS.entries()) {
    const w = shot.w ?? W;
    const h = shot.h ?? H;
    const p = new URLSearchParams({ spot: shot.spot, q: shot.q });
    if (shot.tod) p.set('tod', shot.tod);
    const url = `${BASE}?${p}`;

    const label = `[${String(i + 1).padStart(2, '0')}/${SHOTS.length}] ${shot.file}`;
    try {
      await page.setViewport({ width: w, height: h, mobile: Boolean(shot.mobile) });
      await page.goto(url);
      await page.waitForReady({ timeout: 120000 });
      // 热身:等 PMREM、阴影贴图、LOD 稳定。不热身的话第一帧的开销
      // 会污染下面记进 manifest 的帧时读数。
      await sleep(4500);

      if (shot.ui) {
        // 面板靠点击打开。点完再等一小会儿 —— 面板有入场动画,
        // 动画没走完就截,拍到的是半透明的中间态。
        const clicked = await page.evaluate(
          `(() => { const b = document.querySelector('[data-panel=${JSON.stringify(shot.ui)}]');` +
            ` if (!b) return 'missing'; b.click(); return 'ok'; })()`,
        );
        if (clicked !== 'ok') {
          problems.push(`${shot.file}: 找不到 data-panel=${shot.ui} 的按钮,面板没打开`);
        }
        await sleep(1400);
      }

      const sample = await page.evaluate(`(() => {
        const qm = window.__QM__;
        if (!qm) return { error: '页面上没有 window.__QM__' };
        const st = qm.store.read();
        // ⚠️ 三角面/drawcall 取 passStats 的**分解值**,不取 renderer.info.render。
        //    后者是主 pass + 阴影 pass + 反射 pass 的**累加**;直接引它会把
        //    "主 pass 12 万面"说成 40 万面,或者反过来让人以为主 pass 有 40 万。
        //    见 docs/05-性能测量报告.md 第 6 节。
        const ps = qm.passStats();
        return {
          quality: st.quality,
          tod: +st.tod.toFixed(3),
          camera: (() => { const v = qm.camera.position; return [+v.x.toFixed(1), +v.y.toFixed(1), +v.z.toFixed(1)]; })(),
          // 消费者那一侧的读数。store 说改了什么不算数,这里才是。
          rendererSide: {
            sunY: +qm.skyTime.sun.position.y.toFixed(2),
            sunColor: '#' + qm.skyTime.sun.color.getHexString(),
            shadowMapSize: qm.quality.report().shadowMapSize,
            puffs: (qm.fxRuntime() || {}).puffs ?? null,
          },
          passes: {
            mainCalls: ps.main.calls,
            mainTris: ps.main.triangles,
            shadowTris: ps.shadow.triangles,
            shadowRenders: ps.shadowRenders,
            reflectionTris: ps.reflection.triangles,
            reflectionRenders: ps.reflectionRenders,
          },
          frame: qm.loop.stats(),
          // 顶栏文字的**几何与颜色**,取自 DOM 本身,交给 tools/check_contrast.py
          // 去量 WCAG 对比度。
          //
          // ⚠️ 从 DOM 读,不要在量具里写死坐标:哪天 CSS 挪了位置,写死的框
          //    会指着旁边一块空背景继续量,而量出来的数照样"像那么回事" ——
          //    这正是本项目记过的"取景框不对,读数却很好看"。
          //    display:none 时 rect 全为 0,这里直接返回 null,由量具跳过。
          textProbe: (() => {
            const pick = (sel) => {
              const el = document.querySelector(sel);
              if (!el) return null;
              const r = el.getBoundingClientRect();
              if (r.width < 1 || r.height < 1) return null;
              const cs = getComputedStyle(el);
              return {
                sel,
                x: Math.round(r.x), y: Math.round(r.y),
                w: Math.round(r.width), h: Math.round(r.height),
                color: cs.color,                       // "rgb(230, 220, 195)"
                fontSize: parseFloat(cs.fontSize),
                fontWeight: cs.fontWeight,
              };
            };
            return { title: pick('.qm-brand__title'), sub: pick('.qm-brand__sub') };
          })(),
        };
      })()`);

      const out = join(OUT_DIR, `${shot.file}.png`);
      await page.screenshot(out);

      if (sample.error) {
        problems.push(`${shot.file}: ${sample.error}`);
      } else {
        const bad = auditState(url, sample);
        if (bad.length) problems.push(`${shot.file}: ${bad.join('; ')} —— URL 参数没落地`);
      }

      const ok = !sample.error && auditState(url, sample).length === 0;
      manifest.push({
        // 记 .webp —— 那才是仓库里实际存在、README 实际引用的文件。
        // PNG 只是中间产物,转完就被删了(见下方 to_webp.py 那一段)。
        file: `${shot.file}.webp`,
        url,
        viewport: { w, h, mobile: Boolean(shot.mobile) },
        note: shot.note,
        // 顶栏文字的位置/字号/声明色。tools/check_contrast.py 拿它 + 同名的
        // **PNG**(不是转完的 webp,量对比度不能用有损图)算 WCAG 对比度。
        textProbe: sample.textProbe ?? null,
        applied: sample.error
          ? { error: sample.error }
          : {
              quality: sample.quality,
              tod: sample.tod,
              camera: sample.camera,
              // 太阳高度/光色/阴影尺寸/粒子数 —— 拍摄当时**消费者**那一侧的状态。
              // 用来回答"这张图真的是黄昏吗",而不只是"URL 里写了 tod=0.78"。
              rendererSide: sample.rendererSide,
              passes: sample.passes,
              // ⚠️ 这三个字段**不是性能结论**,见文件末尾 frameCaveat 与 docs/05 第 3、8 节。
              //    无头 Chrome 的 rAF 自己就有约 6.1ms 的地板,量到的
              //    绝大多数帧就是那个地板(或其整数倍)。把它们当"作品跑多少帧"
              //    读,正是本报告第一版犯过的错 —— 量了一个部件,拿它代表整帧。
              rAF: { avgFps: sample.frame.avgFps, p95ms: sample.frame.p95, frames: sample.frame.frames },
            },
      });

      const ps = sample.passes;
      console.log(
        `${ok ? '✓' : '✗'} ${label}  ${shot.spot}/${sample.quality ?? '?'} tod=${sample.tod ?? '?'}` +
          (ps
            ? `  主pass ${ps.mainCalls} draw / ${ps.mainTris.toLocaleString()} 面` +
              `  反射 ${ps.reflectionTris.toLocaleString()} 面 ×${ps.reflectionRenders}` +
              `  阴影 ${ps.shadowTris.toLocaleString()} 面 ×${ps.shadowRenders}`
            : ''),
      );
    } catch (err) {
      problems.push(`${shot.file}: ${err.message}`);
      console.error(`✗ ${label}  失败: ${err.message}`);
    }
  }
} finally {
  await close();
}

// —— manifest:这些读数是**拍摄当时**实测的,不是标称值 ——
//
// ⚠️ 这一段必须写在**所有判定之前**。
//    原来的顺序是「先跑对比度关卡、再写 manifest」,而关卡判失败时直接
//    `process.exit(1)` —— 于是 manifest 根本没落盘。偏偏 check_contrast.py
//    就是靠 manifest 里的 textProbe 才量得出对比度:它要读的那个文件,
//    被它自己引发的那次失败拦掉了。最后剩一堆没有任何记录的 PNG,
//    谁也说不清是什么。**记录要先于判定落下来;判不判得过是之后的事。**
await writeFile(
  join(OUT_DIR, 'manifest.json'),
  JSON.stringify(
    {
      note:
        '由 tools/capture_showcase.mjs 生成。applied 是拍摄当时页面真实生效的状态与实测读数,' +
        '不是 URL 里写了什么 —— 两者对不上时该图会被记进 problems 并在此表中留下 error。',
      // 这一段是**故意**放在数据旁边的。README 会引 manifest 里的
      // 面数/drawcall,读者顺路就会看到 rAF 那三个数;不在这里说清它们
      // 是什么,它们就会被当成性能结论。
      frameCaveat:
        'applied.rAF 里的 avgFps / p95ms **不是作品的开销**,是无头 Chrome 的 rAF 节拍。' +
        '本机空页面的 rAF 地板实测为 6.10ms(重复 8 次读数全同,见 docs/05-性能测量报告.md 第 3 节),' +
        '因此约 164fps 只是"这一帧恰好落在节拍上",与场景轻重无关;' +
        '140~155fps 则多半是偶尔多等了一拍。' +
        '作品的帧开销请看 docs/05 的 bothCost 一列(逻辑+绘制合计,p95 最坏 16.66ms)。' +
        'applied.passes 是 passStats 的**分解值**(主/阴影/反射各自),可用;' +
        'renderer.info.render 那种累加值在本文件里不出现,以免把三个 pass 的和说成一个。',
      // passes 里几个 ×N 是**计数**不是配置:反射每 N 帧才重画一次,
      // 到采样那一刻画过几次取决于等待期间过了多少帧。同一份配置两次跑
      // 会得到不同的数(实测 mid 档一次是 ×1 一次是 ×0),这不是参数变
      // 了 —— 要问档位就看 rtSize 与 everyNFrames,别拿 ×N 比。
      countCaveat:
        'applied.passes 里的 reflectionRenders / shadowRenders 是"到采样那一刻为止' +
        '渲染过几次"的累计计数,随等待时长浮动,不是配置值。跨两次运行比它们没有意义。',
      units: { mainTris: '三角面', mainCalls: 'drawcall', 'applied.rAF.p95ms': '毫秒' },
      browser: browserVersion,
      base: BASE,
      generatedBy: 'node tools/capture_showcase.mjs <URL>',
      shots: manifest,
    },
    null,
    2,
  ),
);

console.log('─'.repeat(64));
console.log(`共 ${manifest.length}/${SHOTS.length} 张,manifest: ${join(OUT_DIR, 'manifest.json')}`);
if (problems.length) {
  console.error('\n❌ 有问题的图:');
  for (const p of problems) console.error(`   · ${p}`);
}

// —— 图片还得过一遍质量关卡,再转 WebP ——
//
// 顺序**不能反**:对比度必须量 PNG。WebP 是有损的,重编码会把字的边缘
// 抹平,量出来的是编码器的误差而不是 UI 的颜色。所以这一步排在转换之前。
//
// 之所以把对比度做成一道**会判失败**的关卡而不是"有空看一眼":顶栏是
// 文字压在**变化的**天空上,同一行字在暮色图里清清楚楚、在正午那张就糊了,
// 而人眼总是先看见能看清的那张。2026-09-18 实测副标题只有 1.96:1
// (AA 门槛 4.5:1),就是这么漏掉的。详见 tools/check_contrast.py 的文件头。
// 判定结果只累积到 `failed`,不在这里退出 —— 退出方式见文件末尾那一小段。
let failed = false;

if (problems.length === 0) {
  const { spawnSync } = await import('node:child_process');
  // 不加 shell:true —— 那会触发 node 的 DEP0190(参数不转义直接拼命令)。
  // 这里不涉及用户输入,但一个要发布的仓库不该带着一条弃用警告跑。
  const c = spawnSync('python', ['tools/check_contrast.py', 'screenshots/showcase'], {
    stdio: 'inherit',
  });
  if (c.error || c.status !== 0) {
    failed = true;
    console.error(
      '\n❌ 顶栏文字对比度没过关。\n' +
        '   本组 PNG 已**保留**(没转 WebP),方便直接开图看是哪一张最糊。\n' +
        '   改的是 src/styles/panels.css 里 .qm-topbar 的遮罩,然后重跑。',
    );
  }

  // 对比度没过就**不要**转 WebP:转换会把 PNG 删掉,而你现在正要看的就是 PNG。
  if (!failed) {
    // —— 转 WebP ——
    //
    // 17 张 1600×900 的 PNG 有 19.3 MB,转完约 1.6 MB。展示图是给人看的,
    // 有损压缩的代价没人看得出来;而**证据图**不能这么干(要比像素),
    // 所以这一步只作用于 screenshots/showcase/。详见 tools/to_webp.py 的文件头。
    //
    // 转失败就把整组判为失败:留着 19 MB 的 PNG 而 README 引用的是 .webp,
    // 会得到一堆裂图 —— 那比"命令报错"难查得多。
    const r = spawnSync('python', ['tools/to_webp.py', 'screenshots/showcase'], {
      stdio: 'inherit',
    });
    if (r.error || r.status !== 0) {
      failed = true;
      console.error(
        '\n❌ 转 WebP 失败。README 引用的是 .webp —— 现在这些文件不存在或没转全。\n' +
          '   脚本不会替你删掉 PNG,修好再跑一次即可。',
      );
    }
  }
}

// 失败一律用 `process.exitCode`,不用 `process.exit(1)`:
//
// Node 往**管道**里写 stdout 是异步的,`process.exit()` 不等它写完 ——
// 上面的报告会被直接截掉,于是「工具失败了」和「工具什么都没说」看起来
// 一模一样。这一条是踩出来的:对比度关卡失败那次,连「共 17/17 张」那行
// 都不见了,只剩 Python 的语法错,害我先去查了几分钟的编码问题。
// 设 exitCode 让事件循环自然结束,输出才落得下来。
// (浏览器已经在 finally 里关掉,没有别的东西拖着进程。)
if (failed) {
  process.exitCode = 1;
} else {
  console.log('✅ 全部通过:每张图的 URL 参数都已落地,对比度达标,状态已记录');
}
