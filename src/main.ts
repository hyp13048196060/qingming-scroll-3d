import * as THREE from 'three';

import './styles/base.css';
import './styles/panels.css';
import './styles/responsive.css';
import { createRenderer, readGpuInfo } from './core/renderer';
import { installPassStats } from './core/passStats';
import { createFrameCost, type Stage } from './core/frameCost';
import { installContextGuard } from './core/contextGuard';
import { Loop } from './core/loop';
import { createQuality } from './core/quality';
import { loadAssets, warmUp, type LoadedAssets } from './core/assets';
import { SkyTime, CAMERA_FAR } from './world/skyTime';
import { createRiverReflector, type RiverReflector } from './world/RiverReflector';
import { createObstacles, type Obstacles } from './world/obstacles';
import { createCharacterPool, type CharacterPool } from './actors/CharacterPool';
import { createPropsAnim, type PropsAnim } from './actors/propsAnim';
import { createParticleFx, type ParticleFx, type EffectsFamily } from './actors/ParticleFx';
import { CameraDirector } from './camera/CameraDirector';
import { LoadingVeil } from './ui/LoadingVeil';
import { createUIRoot } from './ui/UIRoot';
import { store } from './ui/store';
import {
  setQuality,
  setTimeOfDay,
  setLabels,
  setHud,
  setWireframe,
} from './ui/actions';
import { readUrlState } from './core/urlState';
import { SPOTS, tourShots, viewShot, spotById, nearShot } from './data/spots';
import { AudioEngine } from './audio/AudioEngine';

/**
 * 应用外壳。
 *
 * 职责边界写清楚,免得越写越糊:
 *   · 本文件只负责**装配** —— 建渲染器、装场景、拉起加载、接上主循环。
 *   · 相机的一切行为归 CameraDirector。
 *   · 加载进度与失败归 core/assets.ts + ui/store.ts。
 *   · 场景内容归 Blender 导出的 GLB,本文件不做任何几何建模。
 */

function main(): void {
  const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
  const uiRoot = document.getElementById('ui-root');
  if (!canvas) throw new Error('找不到 #stage 画布元素');
  if (!uiRoot) throw new Error('找不到 #ui-root 挂载点');

  const renderer = createRenderer(canvas);
  // pass 分解探针。必须在任何 render 之前装好 —— 阴影夹子是在
  // `renderer.shadowMap.render` 上换方法,装晚了第一帧就没被夹到。
  const passStats = installPassStats(renderer);
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.2,
    CAMERA_FAR,
  );

  const skyTime = new SkyTime(renderer, scene);
  const director = new CameraDirector(camera, canvas);
  const veil = new LoadingVeil(uiRoot);

  // 画质协调器。相机由它持有,因为"人物阴影名额按离相机最近分配"要用到。
  const quality = createQuality({ renderer, scene, sun: skyTime.sun, camera });
  quality.apply(store.read().quality);

  // 初始机位:斜前方看虹桥全貌,与 Blender 侧的 three_quarter 预览机位同角度
  director.place(new THREE.Vector3(26, 14, 30), new THREE.Vector3(0, 4, 0));

  // —— URL 定位 ——
  //
  // 顺序是**刻意的**:先摆默认机位,再让 URL 覆盖。反过来的话,必须先判断
  // "URL 里有没有写"才能决定要不要摆默认值,于是每加一个参数就多一层判断。
  // 现在是"先有确定的状态,再覆盖",不需要任何判断。
  //
  // `cam`/`look` 优先于 `spot`:探针要能精确指定机位去复现一次怀疑,
  // 此时"哪个景点"无关紧要。
  // `url` 提到块外:`setupRiver()` 要用 `url.reflect` ——
  // 水面是在 GLB 装配完才建的,比这个块晚得多。**只读一次**,
  // 而不是在需要的地方各读一次:同一个拼错的参数被解析两次就警告两次,
  // 控制台里会看起来像两个不同的问题。
  const url = readUrlState();
  {
    if (url.cam && url.look) {
      director.place(
        new THREE.Vector3(...url.cam),
        new THREE.Vector3(...url.look),
      );
      console.info(`[url] 机位取自 ?cam=${url.cam.join(',')}&look=${url.look.join(',')}`);
    } else if (url.spot) {
      // ⚠️ 写错 id 直接抛错,**不退回默认机位**。
      //    退回的话 URL 里写的名字和画面上的景物对不上,而图看着"没问题" ——
      //    这类"看着没问题"的错最难查。
      const spot = spotById(url.spot);
      const s = viewShot(spot);
      director.place(new THREE.Vector3(...s.position), new THREE.Vector3(...s.target));
      console.info(`[url] 景点「${spot.name}」全景机位 (${s.position.join(', ')})`);
    }
    // 没写 spot 就保留上面的默认机位。默认机位是阶段 1/2 全部截图与
    // 性能基线的取景,**不做任何变动** —— 换了它,之前的图就都不能比了。

    // 巡游路线:五个景点的近观位姿。放在这里(而不是 CameraDirector 里)
    // 是为了让相机类**不认识景点概念** —— 它只认位姿,景点数据归 data/。
    director.setShots(tourShots());
  }

  // —— URL 状态 → store ——
  //
  // ⚠️ **这一段曾经整个不存在,而后果比"少个功能"严重得多。**
  //    `readUrlState()` 一直在解析 `tod / q / tags / hud / wire`,
  //    但**没有任何地方消费它们** —— 返回值被读出来就丢掉了。
  //    于是所有带 `?q=high` 的截图其实都拍在默认的 mid 档上,
  //    而截图工具记录的 `url` 字段里明明写着 `q=high`,
  //    看报告的人(包括我自己)会认为那是 high 档的图。
  //    一个"读数与实际不符"的仪表比没有仪表更坏 —— 这正是
  //    `docs/10` 里那条"仪表谎报成功"教训的同一类错误,只是换了层皮。
  //
  //    现在必须走 `ui/actions.ts` 的 action,而不是直接改 store:
  //    store 是唯一真相源,action 是唯一写入口,绕过去的话
  //    UI 的高亮状态不会跟着变(状态与界面不一致,又是同一类问题)。
  {
    const applied: string[] = [];
    if (url.quality) {
      setQuality(url.quality);
      applied.push(`q=${url.quality}`);
    }
    if (url.tod !== null) {
      setTimeOfDay(url.tod);
      applied.push(`tod=${url.tod}`);
    }
    if (url.tags !== null) {
      setLabels(url.tags);
      applied.push(`tags=${url.tags ? 1 : 0}`);
    }
    if (url.hud !== null) {
      setHud(url.hud);
      applied.push(`hud=${url.hud ? 1 : 0}`);
    }
    if (url.wire !== null) {
      setWireframe(url.wire);
      applied.push(`wire=${url.wire ? 1 : 0}`);
    }
    // 打一行汇总,而不是每个参数各打一行:探针脚本要靠这行**确认参数真的
    // 落地了**。没有这行的话,`?q=high` 没生效也只是"图看着还行"。
    if (applied.length) console.info(`[url] 已应用状态:${applied.join(' ')}`);
  }

  // —— 阴影 ——
  // ⚠️ 阴影相机的参数**一律由 SkyTime 拥有**,这里不要再改。
  //    曾经在这里覆盖成 far=220,而太阳离原点 250m ——
  //    阴影视锥在离场景 30m 的地方就截断了,全画面一道影子都没有。
  //    参数由光源位置推导,拆到两个文件里必然对不上。
  //    (诊断依据见 screenshots/web/diag.json 的 lights[0].shadow)

  // —— 地面与水面 ——
  //
  // 阶段 1 在这里摆过四块**占位面**(两块岸、一块水面、一块河床)。
  // 阶段 2 把它们全删了,原因是量出来的、不是感觉出来的 ——
  // 拿 GLB 的 accessors.POSITION 加节点变换算出世界范围:
  //
  //     岸线_地坪    X −300…300   Z −300…300   Y −1.48…3.85
  //     河道_水面    X −8.3…8.3    Z −300…300   Y −0.06…0.00
  //     河道_河床    X −8.1…8.1    Z −300…300   Y −2.10…−1.50
  //     河道_驳岸    X −10…10      Z −300…300   Y −2.40…0.12
  //
  // 也就是说**导出的几何本来就自带了 600×600m 的地面、600m 长的水面与
  // 河床**,占位面是纯粹多出来的。而且它们不是"多画了一笔"这么简单:
  // 占位水面压在 y=0、占位岸压在同一个高度,与真水面几乎共面 ——
  // 结果就是真河道被盖住,画面上一整块平色,河成了地上一道细缝。
  // (阶段 2 的截图 screenshots/web/texture_decode.png 里能看到这个症状:
  //  贴图都在,唯独河看不出来。)
  //
  // ⚠️ **朝向是在这里定死的,别再凭感觉摆**:拱跨沿 X、桥宽沿 Z,
  //    所以汴河沿 Z 流淌、宽度落在 X 上,虹桥横跨其上。
  //    早先摆成"70 沿 X × 17 沿 Z",河顺着桥走了,方向正好反了 90°。

  // —— 主循环 ——
  //
  // ⚠️ `loop` 必须**先于** `createUIRoot` 声明:UIRoot 的 HUD 要读
  //    `loop.stats()`。写成"先建界面再建循环"会撞上 TDZ
  //    (`Block-scoped variable 'loop' used before its declaration`)——
  //    这类错在类型检查时就会报,但只有真跑一次 tsc 才知道,
  //    因为 IDE 里两个声明看着挨得很近,顺序很容易忽略。
  const loop = new Loop();

  // 帧开销的独立量法(连渲 n 帧 + gl.finish),绕开 rAF 节拍地板。
  // 必须建在 loop / scene / camera 之后 —— 它三个都要用。
  const frameCost = createFrameCost(renderer, scene, camera, loop);

  // —— 配乐 ——
  //
  // ⚠️ 构造这里**不许出声**:`new AudioContext()` 在非用户手势里建出来就是
  //    suspended,之后再 resume 也容易出岔子(见 AudioEngine 构造函数注释)。
  //    所以构造只算乐句表(纯函数、确定性),真正建上下文推迟到第一次点「配乐」——
  //    那一下是货真价实的用户手势。
  //
  // ⚠️ **构造会抛**:乐句表为空时它直接抛错。这是刻意的(宁可开不了页面,
  //    也不要一个点了没反应的按钮),但代价是 main() 会整个挂掉。所以这里
  //    兜一层,坏掉就当作"没有音频引擎"——按钮不画,页面照常能用。
  let audio: AudioEngine | null = null;
  let audioInitError = '';
  try {
    audio = new AudioEngine();
  } catch (err) {
    audioInitError = err instanceof Error ? err.message : String(err);
    console.warn(`[audio] 引擎构造失败,「配乐」按钮将不出现:${audioInitError}`);
  }

  // —— 界面 ——
  //
  // ⚠️ 界面挂在 `#ui-root` 上,相机的一切动作由 director 注入进来 ——
  //    UIRoot 不认识相机类,它只调回调。
  const ui = createUIRoot({
    mount: uiRoot,
    loop,
    renderer,
    camera,
    gpu: readGpuInfo(renderer),
    goSpot: (id) => void director.flyTo(viewShot(spotById(id))),
    goNear: (id) => void director.flyTo(nearShot(spotById(id))),
    startTour: () => director.startTour(),
    stopTour: () => director.exitAuto('api'),
    tourActive: () => director.autoTour,
    /**
     * 动画层已接线,「动画」开关可以画出来了。
     *
     * ⚠️ 这是一句**声明**,本身不构成证据 —— 它之所以此刻为 `true`,
     *    是因为下面 `stages` 里有三个环节标了 `clock: 'anim'`
     *    (人物 / 道具风动 / 氛围粒子),而 `frameStep` 会给它们喂
     *    `animOn ? dt : 0`。改掉那三处而忘了改这一行,后果是
     *    **界面上多出一个按下去没反应的开关** —— 用户会以为动画坏了。
     *    所以 `tools/perf/probe_ui.mjs` 里有一条行为断言:拨这个开关,
     *    关掉时两张人物位置快照必须逐字节相同,打开时必须有位移。
     *    谁改坏了,那边会红。
     *
     * 写成必填(UIRootDeps 里没有 `?`)是故意的:忘了传会编译不过。
     */
    anim: true,
    // 有引擎才注入 —— 「不注入就等于没有这个引擎」是 UIRoot 的契约,
    // 也正是"不许有无响应的装饰性控件"的技术落点。
    ...(audio
      ? {
          audio: {
            /**
             * 切开关。返回**实际生效**的状态。
             *
             * ⚠️ **本函数不许抛**。调用点写的是 `void set(want).then(...)`,
             *    没有 catch —— 抛出会变成 unhandled rejection,而探针把
             *    "无未捕获异常"当作出口条件之一。失败在这里吞掉,但**不静默**:
             *    把原因 console.warn 出来,并如实返回 false,让界面按实际状态回写。
             */
            set: async (on: boolean): Promise<boolean> => {
              try {
                if (on) {
                  // 首次开启才建上下文;这一步必须发生在点击回调的调用栈里。
                  await audio!.init();
                }
                audio!.setEnabled(on);
              } catch (err) {
                const why = err instanceof Error ? err.message : String(err);
                console.warn(`[audio] 开启配乐失败:${why}`);
                return false;
              }
              // 以引擎**真实**状态为准回写,不拿请求值当结果。
              return audio!.enabled && audio!.state === 'running';
            },
            /** 状态短语。按钮次级文字直接显示它,所以用中文。 */
            state: (): string => {
              switch (audio!.state) {
                case 'running':
                  return '运行中';
                case 'suspended':
                  return '已挂起';
                case 'closed':
                  return '已关闭';
                default:
                  return '未启动';
              }
            },
          },
        }
      : {}),
  });

  /**
   * 动画时钟 —— 「动画」开关关掉时**冻结**,再打开时从冻结点续上。
   *
   * 为什么不是"关掉就不调 `update()`":那样一来相位在关着的时候仍在偷偷
   * 走远(`worldTime` 不停),再打开的瞬间幌子/柳枝/炊烟会**跳到**新相位上。
   * 这个项目在别处已经吃过同型的亏 —— 见 `loop.ts` 的 `MAX_DT` 与
   * `timer.connect(document)` 两处注释,都在讲同一件事:让时间本身停住,
   * 而不是让消费者各自去猜该不该动。
   *
   * 为什么另立一支钟、而不是把 `worldTime` 传 0:那会让水面、配乐、相机
   * 一起停摆 —— 它们不归这个开关管(边界见 `stages` 里的 `clock` 标注)。
   * 所以只给被开关管辖的那三层另开一支,由**同一个 dt** 累加:
   * 全作品仍然只有一个时间源,这里只是多了一道闸门。
   *
   * ⚠️ 这三个 `let` 必须在**订阅之前**声明:`store.subscribe()` 会立即
   *    同步推一次当前值(见 `ui/store.ts`),放到订阅下面就是 TDZ 报错。
   */
  let animTime = 0;
  /** 本帧给动画层的 dt。关掉时是 0 —— 走路那一层据此停在原地。 */
  let animDt = 0;
  let animOn = store.read().ui.anim;

  // —— 状态 → 消费者 ——
  //
  // ⚠️ 这里把每个 store 字段接到**真实的消费者**上。没有消费者的字段不接,
  //    对应的控件也不画(见 SettingsCapabilities / UIRootDeps.audio)。
  //    一张"声明了状态但没人读"的接线表会让人以为功能已经做完了。
  {
    let lastTod = store.read().tod;
    let lastQuality = store.read().quality;
    let lastWire = store.read().ui.wireframe;

    store.subscribe((s) => {
      // 时辰 → 天空/太阳/雾,并标记 PMREM 需要重建
      if (s.tod !== lastTod) {
        lastTod = s.tod;
        skyTime.setTimeOfDay(s.tod);
      }
      // 画质 → 分辨率 / 阴影 / 人物阴影名额 / 反射 RT
      if (s.quality !== lastQuality) {
        lastQuality = s.quality;
        quality.apply(s.quality);
      }
      // 线框 → 材质属性
      if (s.ui.wireframe !== lastWire) {
        lastWire = s.ui.wireframe;
        quality.setWireframe(s.ui.wireframe);
      }
      // 动画 → 动画时钟的闸门(见上方 `animOn` 的整段说明)。
      // 这里只记一个布尔 —— 真正冻结发生在 `frameStep` 里,
      // 因为要停住的是**时间**,不是某一次 `update()` 调用。
      if (s.ui.anim !== animOn) animOn = s.ui.anim;
    });
  }

  /**
   * 一帧的逻辑,按**执行顺序**排成一张表。
   *
   * 排成表而不是写成一串语句,是为了能逐个计时。理由是一次实测:
   * `measureLogicCost()` 量出每帧逻辑要 **~20ms**,而且 low/mid/high
   * 三档一模一样(20.34 / 20.15 / 19.66)——说明它跟画质无关,
   * 也就跟渲染无关。而 `measureFrameCost()` 量到的绘制只要 1~4ms。
   *
   * 也就是说:**在这之前,报告里写的"一帧 4ms"只说了五分之一。**
   * 拿一个只量了渲染的量具去下"离 60fps 还有 2.4 倍余量"的结论,
   * 是又一次拿量具的读数当作品的性质 —— 这个项目里的第 N 次。
   *
   * 有了这张表,20ms 具体落在哪一环就是量出来的,不用猜。
   */
  const stages: Stage[] = [
    { name: '天空/时辰', fn: () => skyTime.update() },
    { name: '相机', fn: (dt) => director.update(dt) },
    // 配乐调度。喂的是循环里那个**唯一**的 worldTime,不是 Date.now() ——
    // 音频有自己的时钟,两边一旦各读各的,切标签页回来就会整体错位
    // (引擎内部用漂移量做自愈,见 AudioEngine.update 的 resync 分支)。
    { name: '配乐', fn: (dt, wt) => audio?.update(wt, dt) },
    // 水面。顺序有讲究:必须在 `skyTime.update()` **之后** ——
    // 太阳的位置与颜色、以及场景雾都是 skyTime 每帧改的,水面渲染要用它们;
    // 反过来写的话,水面用的是上一帧的太阳,时辰切换时会出现"岸上已经是黄昏、
    // 河面还亮着"的一帧。也要在 `renderer.render` 之前,否则水面的
    // uniform 是本帧渲染完才更新的。
    { name: '水面', fn: (_dt, wt) => river?.update(wt) },
    // 人物。放在 river.update 之后:走路的位移会改 rig 的世界矩阵,
    // 而水面反射这一帧要渲染的是**本帧最终**的人影,不是上一帧的。
    // `clock:'anim'` —— 「动画」关掉时 dt 为 0,人停在原地而不是继续走。
    { name: '人物', fn: (dt) => actors?.update(dt), clock: 'anim' },
    // 道具动态(桅/橹/舵刚体转动 + 布幌柳枝顶点风动)。
    // 喂的是**绝对相位**而不是 `dt`:风动是周期函数,累积 dt 会在切标签页
    // 回来时把幌子甩到别的相位上,而且再也回不去。
    // `clock:'anim'` 喂的是 `animTime` —— 它同样是绝对相位(满足上面这条),
    // 但多一道闸门:「动画」关掉时它不再累加,幌子停在当时的相位上,
    // 再打开是从**冻结点**续上,而不是跳到 worldTime 那个新相位。
    // 位置同 `actors.update`:必须在 render 之前,否则这一帧渲染的是
    // 上一帧的幌子姿态 —— 静帧里看不出来,动起来才露馅。
    { name: '道具风动', fn: (_dt, wt) => props?.update(wt), clock: 'anim' },
    // 氛围粒子。**每帧只写一个 uniform** —— 位置、朝向、拍翅全在顶点着色器里
    // 按时间解析算出来,CPU 侧没有逐粒子循环(见 ParticleFx 文件头)。
    // 放在最后是因为它不产出任何别的东西要读;顺序错了也不会有观感差异。
    // `clock:'anim'` —— 炊烟与飞鸟同属"氛围性动画",跟着开关一起停。
    { name: '氛围粒子', fn: (_dt, wt) => fx?.update(wt), clock: 'anim' },
  ];

  /**
   * 一帧的全部内容。`doRender=false` 时跑的是纯粹的 CPU 逻辑,不含任何绘制。
   */
  function frameStep(dt: number, worldTime: number, doRender: boolean): void {
    // 动画时钟的闸门。必须在本帧任何一环跑之前算好 ——
    // 下面按 `st.clock` 择一喂给各环。
    animDt = animOn ? dt : 0;
    animTime += animDt;

    // 紧跟 loop.tick 里的 `renderer.info.reset()`:两者必须同一时刻清零,
    // 否则上一帧的 pass 计数会被算进这一帧。
    passStats.frameStart();
    // 择钟在**这里**做,而不是让各环自己读闭包(理由见 `Stage.clock` 的注释:
    // 逐环计时绕过主循环,闭包写法会让那一支量到空转)。
    for (let i = 0; i < stages.length; i++) {
      const st = stages[i]!;
      if (st.clock === 'anim') st.fn(animDt, animTime);
      else st.fn(dt, worldTime);
    }
    // 逻辑计时用:跳过绘制,只跑 CPU 侧。此时 renderer.info 里是本帧
    // **尚未绘制**的计数(只有 passStats.frameStart 清的那个零),
    // 所以 ui.update() 读到的 HUD 数字是无意义的 —— 逻辑计时不读它。
    if (doRender) renderer.render(scene, camera);
    // ⚠️ 界面在所有三维工作**之后**更新:
    //    ① 标签要拿本帧最终的相机位姿去投影,早一帧会看到标签"落后";
    //    ② HUD 读的是 `renderer.info`,必须等这一帧的 render 落定。
    //       放在 render 之前读到的就是上一帧的数 —— 而那是看不出来的。
    if (doRender) ui.update();
  }

  /**
   * 最近一帧的 dt(秒)。
   *
   * 只给诊断读 —— 上下文恢复后首帧的 dt 是"`loop.resetTimer()` 到底有没有
   * 生效"的**唯一直接证据**。不记它的话,那条断言只能退化成
   * "loop 又跑起来了",而循环起来了不代表 dt 对 —— 首帧 dt 是整个丢失时长
   * 这件事,不看这个数就看不出来(它会被 MAX_DT 钳到 50ms,画面不跳,
   * 只是动画白白慢半拍)。
   */
  let lastDt = 0;

  loop.add((dt, wt) => {
    lastDt = dt;
    frameStep(dt, wt, true);
  });

  const onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };
  window.addEventListener('resize', onResize);

  // —— 装配 GLB 的目标位 ——
  //
  // ⚠️ 这五个 `let` 提前到这里,是因为下面的上下文守卫要引用它们。
  //    提前只是把声明挪个位置,没有别的影响。
  let loaded: LoadedAssets | null = null;
  let river: RiverReflector | null = null;
  let actors: CharacterPool | null = null;
  let obstacles: Obstacles | null = null;
  let props: PropsAnim | null = null;
  let fx: ParticleFx | null = null;

  // —— 上下文守卫 ——
  //
  // ⚠️ 必须**先装守卫再启动循环**:反过来的话,守卫在丢失时调
  //    `loop.stop()` 是对的,但如果在 `loop.start()` 之前就丢了一次,
  //    start 会把停掉的循环又拉起来 —— 于是"丢失后画面还在提交"。
  //
  // 重建钩子只列**只有我们能重建**的东西。几何/贴图/材质不在此列:
  // three 的 `onContextRestore` 会在下一帧按 CPU 侧数据重新上传它们。
  // 渲染目标的**内容**则不会 —— 见 core/contextGuard.ts 文件头的 ③。
  const contextGuard = installContextGuard({
    canvas,
    renderer,
    loop,
    hooks: [
      {
        name: '环境贴图',
        // 不标脏的话,PMREM 那张贴图永远是空的,而画面上表现为
        // **整体发黑**、不报错 —— 见 SkyTime.invalidateEnvironment。
        run: () => skyTime.invalidateEnvironment(),
      },
      {
        name: '水面反射',
        // 反射 RT 会自愈(每帧/每 N 帧都在重画),这一项只是把 mid 档
        // 恢复后最长两帧的空白反射去掉。
        //
        // ⚠️ 与上面那一项不同,这一项**没有单独量过** —— 两帧的瞬态在
        //    测量里跟正常抖动分不开。留着它的理由是**代价确实为零**
        //    (`forceUpdate = true` 只是让下一次 `onBeforeRender` 不跳过),
        //    不是"量到了它有用"。所以报告与文档里不许把它写成"实测改善"。
        run: () => river?.invalidateReflection(),
      },
    ],
  });

  // 先启动循环再加载:遮罩期间也要出帧,否则 compileAsync 没机会跑,
  // 而且用户会看到一片死黑而不是进度条。
  loop.start(renderer);

  /**
   * 把 GLB 里那块 `qm_kind=water` 的网格换成反射水面。
   *
   * 必须在**所有分块都 add 进场景之后**才建:
   * `createRiverReflector` 会扫一遍场景给对象打反射层,分块还没进去的时候扫,
   * 反射图里就只有水没有岸 —— 而水面反射的内容本来几乎全是岸上的东西。
   */
  const setupRiver = (): void => {
    let waterMesh: THREE.Mesh | null = null;
    scene.traverse((o) => {
      if (waterMesh) return;
      const m = o as THREE.Mesh;
      if (m.isMesh && (o.userData as { qm_kind?: string }).qm_kind === 'water') {
        waterMesh = m;
        o.updateWorldMatrix(true, false);
      }
    });
    if (!waterMesh) {
      // 不抛异常:水面是观感项,缺了不该让整页打不开。
      console.warn('[river] 场景里没有 qm_kind=water 的网格,跳过反射水面');
      return;
    }
    river = createRiverReflector({ waterMesh, scene, renderer, sun: skyTime.sun });
    scene.add(river.object);
    // 先 add 再 register:`register` 会**立刻**按当前档位调一次
    // `applyQuality`,那一刻它会设 `reflector.visible` 并按档位决定 RT 尺寸。
    // 顺序反了不会报错,只是第一档画质的反射分辨率会晚一步才对。
    quality.register(river);

    // `?reflect=0|1`:A/B 测量用的覆盖位。放在 `register` **之后** ——
    // 覆盖位活在反射器内部,register 那次推送已经被它吸收;反过来的话
    // 覆盖会被 register 立刻推的那份计划冲掉,A/B 两组就完全一样了。
    if (url.reflect !== null) {
      river.setReflectOverride(url.reflect);
      console.info(`[river] 反射被 ?reflect=${url.reflect ? 1 : 0} 覆盖(画质档位本次不决定反射)`);
    }
  };

  /**
   * 人物与障碍。
   *
   * **必须在 `setupRiver()` 之后**:反射那一层是建水面时扫场景打上的,
   * 而 48 个克隆体是在运行时才 `scene.add` 进来的 —— 它们默认落在第 0 层,
   * 不重扫的话**人影不会出现在水面的倒影里**。这个失败是静的:
   * 水面看着正常,只是岸上的人一个都映不出来,得盯着倒影看才发现。
   */
  const setupActors = (): void => {
    obstacles = createObstacles(scene);
    actors = createCharacterPool({ scene, obstacles });
    // 道具动态要在**克隆体落地之后**建:它会遍历场景找 qm_anim 标签,
    // 而 48 具人物克隆体是运行时才 add 进来的,它们自带的
    // `acc_punt_pole`(SkinnedMesh,却被打了 qm_anim=oar)也在其中。
    // 早一步建就扫不到它们 —— 后果不是漏驱动那根篙(它归骨骼管),
    // 而是诊断里"跳过了 6 个蒙皮件"这条计数凭空少 6,
    // 让标签过宽的这件事在报表上消失。
    props = createPropsAnim(scene);
    // 克隆体落地之后重扫反射层(见上面那段)。
    river?.refreshReflectLayer();
  };

  /**
   * 氛围粒子(炊烟 / 飞鸟)。
   *
   * ⚠️ **必须排在 `setupActors()` 之后**,而且顺序是**有实质后果**的:
   *    `setupActors()` 末尾那次 `refreshReflectLayer()` 会把场景里所有对象
   *    enable 到反射层。粒子是在它**之后**才进场的,于是天然不进反射 ——
   *    这正是想要的(薄片映在水里会碎成一片亮点,而反射 pass 是全场最贵的)。
   *    反过来写不会报错,只会让反射图里多出几十片烟和鸟,而且**看不出来**
   *    是哪里来的。粒子内部另有 `qm_reflect=0` 与 `layers.set(0)` 两道兜底。
   */
  const setupEffects = (): void => {
    fx = createParticleFx(scene);
    scene.add(fx.object);
    // 与水面同样的顺序:先 add 再 register。`register` 会**立刻**按当前档位
    // 调一次 `applyQuality`,那一刻它会按 density 设 instanceCount 与 visible。
    quality.register(fx);
  };

  const assemble = (assets: LoadedAssets): void => {
    for (const [key, group] of assets.chunks) {
      group.name = key;
      scene.add(group);
    }
    loaded = assets;
    setupRiver();
    setupActors();
    setupEffects();

    // ⚠️ 装配完必须**重跑一次画质**。
    //    启动时那次 `quality.apply()` 发生在 GLB 落地之前,当时场景里
    //    一个人物都没有,于是"最近 N 个人物投影"这个名额分配是空转的。
    //    不重跑的话,人物阴影会永远不生效,而且不报任何错 ——
    //    画面看着只是"阴影有点少",不会有人去查。
    //    重跑是幂等的(见 core/quality.ts 的文件头),
    //    重复调用不会把分辨率或阴影贴图再叠一层。
    quality.apply(store.read().quality);
  };

  const boot = async (): Promise<void> => {
    const assets = await loadAssets();
    if (!assets) return; // 失败信息已经写进 store,遮罩会显示
    assemble(assets);
    // 完成位留给 compileAsync:它才是真正会卡住主线程那一步
    await warmUp(renderer, scene, camera);
  };

  void boot();

  // 重试按钮只改状态,真正重新加载要靠订阅 —— 否则点了没反应
  let lastPhase = store.read().load.phase;
  store.subscribe((s) => {
    if (lastPhase === 'failed' && s.load.phase === 'idle') void boot();
    lastPhase = s.load.phase;
  });

  // —— 调试接口 ——
  // 截图与性能脚本依赖它;同时作为"页面已就绪"的信号源。
  // 阶段 3 起 UI 会全部挂到 actions 上,这里的 surface 保持只读。
  const gpu = readGpuInfo(renderer);
  Object.defineProperty(window, '__QM__', {
    value: {
      THREE,
      renderer,
      scene,
      camera,
      director,
      loop,
      skyTime,
      store,
      gpu,
      ui,
      quality,
      /**
       * 水面反射的读数。性能探针靠它区分"反射真的跑了 N 次"与
       * "水面在画但反射一次没跑" —— 后者画面只是"河面颜色有点怪",
       * 不报错,只看得见 `reflectionPasses` 停在 0。
       * 同上:纯数据。
       */
      /**
       * 一帧的 pass 分解。性能报告里"主 pass drawcall"这一栏的唯一来源 ——
       * `renderer.info.render` 是主 pass + 阴影 + 反射的**累加**值,
       * 直接拿它当主 pass 去比门限,量的是三件事。
       * 同上:纯数据,现场读取。
       */
      passStats() {
        return passStats.read();
      },
      /**
       * 连渲 n 帧的同步吞吐(毫秒/帧)。**不含逻辑**。
       * 调用期间会短暂停掉主循环,测完自动恢复。
       */
      measureFrameCost(n = 120) {
        return frameCost.measureBurst(n);
      },
      /**
       * 跑 n 步 `frameStep`,可选是否绘制。
       *
       * - `measureLogicCost(n)` → 纯 CPU 逻辑(相机阻尼 + 步态 + 风动 uniform + UI)
       * - `measureLogicCost(n, true)` → 逻辑 + 绘制,即真循环里一帧的 CPU 总开销
       *
       * 存在的理由:渲染只要 ~4ms,而 rAF 间隔是 24~30ms。差的那些时间
       * 要么在逻辑里,要么在浏览器的合成/呈现里 —— 这一支就是为了把这
       * 两种可能分开。**不要**再用"大概是浏览器节拍"这个说法去填这个洞,
       * 那个说法在 rAF 地板被测成 6.1ms 之后已经不成立了。
       */
      measureLogicCost(n = 240, withRender = false) {
        return frameCost.measureStep(n, frameStep, withRender);
      },
      /**
       * 逐环节计时,按耗时降序。用来回答"那 20ms 落在哪一环"。
       *
       * 把绘制与 UI 也一起列进来:它们不在这张逻辑表里,但只有并排放,
       * 才能看出"逻辑 vs 绘制"的量级对比 —— 而这个对比正是本探针
       * 存在的理由(连渲口径只能看见小头,看不见大头)。
       */
      measureStageCost(n = 240) {
        const all: Stage[] = [
          ...stages,
          { name: '绘制', fn: () => renderer.render(scene, camera) },
          { name: '界面更新', fn: () => ui.update() },
        ];
        return frameCost.measureStages(n, all);
      },
      /**
       * 上下文守卫的读数(纯数据)。
       *
       * 为什么要有它:上下文丢失**没法从画面上判断**。丢了的画面就是
       * 最后一帧静在那里,截图与"程序卡住"完全一样。所以
       * `tests/context_loss.mjs` 只能读这里 —— 断言"确实丢了、确实恢复了、
       * 重建了哪几项、中断了多久"。
       *
       * ⚠️ 别拿 `loop.isRunning === false` 当"丢了"的证据:逐环节计时与
       *    吞吐测量也会短暂停掉循环。守卫内部用的是它自己的一个标志位,
       *    理由写在那边。
       */
      gpuRuntime() {
        const g = contextGuard.diagnostics;
        return {
          ...g,
          storeLost: store.read().gpu.contextLost,
          storeLostCount: store.read().gpu.lostCount,
          storeRestoredCount: store.read().gpu.restoredCount,
          storeTimedOut: store.read().gpu.recoveryTimedOut,
          loopRunning: loop.isRunning,
          veilVisible: !(document.querySelector('.veil') as HTMLElement | null)?.hidden,
          gpuBoxVisible: !(
            document.querySelector('.veil__gpu') as HTMLElement | null
          )?.hidden,
          // 恢复后首帧的 dt。断言它远小于丢失时长,证明 resetTimer 生效了。
          lastFrameDtMs: Math.round(lastDt * 100000) / 100,
          frameCount: loop.frameCount,
        };
      },
      riverRuntime() {
        if (!river) return { mounted: false };
        const d = river.diagnostics;
        return { mounted: true, ...d };
      },
      /**
       * 人物的读数。探针靠它断言"人是真的生成了、真的在动" ——
       * 只看截图分不清"48 个人站着"和"48 个人在走",而走路这件事
       * 恰恰是阶段 4 要交付的东西。
       * 同上:纯数据,只读。
       */
      actorsRuntime() {
        if (!actors) return { mounted: false };
        return {
          mounted: true,
          spawned: actors.spawned,
          walking: actors.walking,
          templates: actors.templates,
          // 模型局部前向 —— 探针拿它跟 Blender 的事实(脸朝 +Y ⇒ three −Z)对质
          localFacing: [
            +actors.localFacing.x.toFixed(4),
            +actors.localFacing.y.toFixed(4),
            +actors.localFacing.z.toFixed(4),
          ],
          obstacles: obstacles
            ? { boxes: obstacles.boxCount, groundMeshes: obstacles.groundTargets }
            : null,
        };
      },
      /** 人物位置快照。连拍两次比差值 = "有没有真的在移动"。 */
      actorsSnapshot() {
        return actors ? actors.snapshot() : [];
      },
      /**
       * 两支时钟的读数:`loop.time`(全局,永不停)与 `animTime`(动画层专用,
       * 被「动画」开关冻住)。字段名是 `world` 而不是 `worldTime` —— 后者是
       * `Loop` 的私有字段,公开读数叫 `time`,名字不同是刻意的,别混。
       *
       * 为什么必须把它露出来:关掉开关后"人物真的冻住了"还能靠位置快照断言,
       * 但**重新打开时是从冻结点续上、还是跳到新相位**——这一条在画面上
       * 看不出来。跳变只发生在一帧之内,前后两张截图各看各的都很正常;
       * 而它是"切标签页回来会瞬移"那类缺陷的同一种形态。
       * 只能比数:冻结期间 `anim` 一步不动、`world` 照常涨;解冻后
       * `anim` 必须从冻结值附近接着涨,**不能一次追平 `world`**。
       * 同上:纯数据,只读。
       */
      clockSnapshot() {
        return {
          world: +loop.time.toFixed(4),
          anim: +animTime.toFixed(4),
          animOn,
        };
      },
      /**
       * 道具动态的读数。**"跳过了 N 个"和"驱动了 N 个"一样重要** ——
       * 一件被标了动态却因为缺权重/缺轴心而没动的东西,在静帧里
       * 和"今天没风"完全一样,只有计数能把它抖出来。
       * 同上:纯数据,只读。
       */
      propsRuntime() {
        return props ? props.runtime : { mounted: false };
      },
      /**
       * 每条船一条:船壳的横摇角 + 一件**自身不动**的子件的世界坐标。
       *
       * 为什么不能只看 `propsRuntime().rigid.hull_rock` 的计数:
       * 那个数只证明"有 5 条船被登记成会摇",**证明不了**船壳转了之后
       * 子件真的跟着动 —— 而"整船轻摇"的全部内容恰恰是那个跟随。
       * 父子链断开(导出丢了层级 / 有人把 `_attach` 删了)时计数照旧,
       * 船却会在摇的时候散架。
       *
       * 所以这里读的是**静止子件的位置**:它自己没有动画,动了就只可能是
       * 被父级带动的。同理,上岸船(`qm_beached=1`)的那一条必须一步不动,
       * 那是 `qm_beached` 这道闸的反面判据。
       * 同上:纯数据,只读。
       */
      boatSnapshot() {
        return props ? props.boatSnapshot() : [];
      },
      /**
       * 氛围粒子(炊烟/飞鸟)的读数。
       *
       * ⚠️ `puffs` / `birds` 是**当前真的在画的数**,不是上限。low 档两者都是 0,
       *    而 0 与"装上了但一处都没画"在截图上完全一样 —— 只有这个数能分开。
       *    `warnings` 更是必须露出来的:`粒子在画`不等于`烟冒在该冒的地方`。
       * 同上:纯数据,只读。
       */
      fxRuntime() {
        return fx ? fx.runtime() : { mounted: false };
      },
      /**
       * A/B 测量用:绕过画质档位强制设粒子的密度倍率。`null` = 撤销。
       *
       * ⚠️ **为什么不走 `?fx=` 网址参数**(而 `reflect` 走了):那边 A/B 是
       *    "两张图各自导航一次",两次导航之间场景是静止的,差异只有反射。
       *    这里不行 —— 河岸上**有 48 个在走的人**,两次导航走过的帧数不同,
       *    差值图里会混进一堆人影,而人影与炊烟在同一片像素上。
       *    所以粒子 A/B 必须**同一页内切换**:先 `loop.stop()` 冻住,
       *    再切开关、各渲一帧。两个样本之间除了粒子计数**一个字节都没变**,
       *    这时差值图里的每个像素才都是粒子自己的。
       *    加一个只能靠导航使用的网址参数,换来的是"看着对称、量不准"。
       *
       * ⚠️ `which` 是**归因**用的:冻住之后拍四帧(关/关、烟开、鸟开),
       *    "关/关"拍两次用来证明冻结真的生效。烟那一帧与鸟那一帧各自
       *    与基准比,于是**每一块变化的像素属于烟还是鸟,是构造决定的**,
       *    不用再拿"它在地平线以上所以是鸟"这类线索去猜 ——
       *    那条线索把船机位升起在屋脊之上的三团烟判成了三只鸟。
       */
      setFxOverride(ratio: number | null, which: EffectsFamily = 'both') {
        fx?.setEffectsOverride(ratio, which);
        return fx ? fx.runtime() : { mounted: false };
      },
      /**
       * 脚下的地面高度。给近景诊断核对"脚是不是踩在地上"用 ——
       * 截图里"看着像悬空"和"真的悬空"长得一样,必须拿地面高度对质。
       *
       * ⚠️ 一次调用 = 一次对全部地面网格的射线(项目里**没有** BVH,
       *    见 world/obstacles.ts 的注释),单次几毫秒起。
       *    诊断脚本调几十次可以,别放进每帧循环。
       */
      groundAt(x: number, z: number) {
        return obstacles ? obstacles.groundAt(x, z) : null;
      },
      /**
       * 界面状态快照 —— 阶段 3 的脚本断言读它,不从 DOM 里抠。
       * 面板的显隐、按钮的高亮都只是状态的**结果**,查状态才能定位是谁错了。
       *
       * ⚠️ 返回值必须是**纯数据**。这里曾经把 `panelVisible` 写成一个方法,
       *    而探针是用 `Runtime.evaluate({returnByValue:true})` 取它的 ——
       *    函数无法跨这道边界,该字段会被**静默丢弃**,于是断言读到
       *    `undefined`,报的是"面板不可见"。这种"接口看着有、取值时没了"
       *    的错不会抛异常,只会让人去查界面,而界面是对的。
       *    凡是要过 CDP 的结构,一律只放数字、字符串、布尔和数组。
       */
      uiSnapshot() {
        const s = store.read();
        // 下面三项直接量 DOM,用来交叉验证"状态改了但界面没跟上"
        const host = document.querySelector('.qm-panelhost');
        const shown = host
          ? Array.from(host.children).filter((c) => !(c as HTMLElement).hidden)
          : [];
        return {
          panel: s.ui.panel,
          selected: s.ui.selected,
          chrome: s.ui.chrome,
          labels: s.ui.labels,
          anim: s.ui.anim,
          wireframe: s.ui.wireframe,
          audio: s.ui.audio,
          hud: s.ui.hud,
          tod: s.tod,
          quality: s.quality,
          panelVisible: !host ? 'missing' : shown.length === 0 ? 'none' : shown[0]!.className,
          labelCount: document.querySelectorAll('.qm-label').length,
          spotButtonCount: document.querySelectorAll('.qm-spotnav__btn').length,
        };
      },
      get assets() {
        return loaded;
      },
      /**
       * 配乐引擎的**运行时**状态(纯数据,可过 CDP)。
       *
       * ⚠️ 为什么不复用 `uiSnapshot().audio`:那一个是 store 里的**意图**
       *    (`ui.audio`),用户点了就变 true,哪怕浏览器压根没让上下文跑起来。
       *    "有没有声音"只能由 `context.state` 回答,所以要有一个地方把
       *    引擎的真实状态暴露出来 —— 否则脚本只能读一个自己写下去的愿望值。
       */
      get audioRuntime() {
        if (!audio) {
          return { wired: false, reason: audioInitError || '未注入', state: 'uninitialized' };
        }
        const d = audio.diagnostics;
        return {
          wired: true,
          reason: '',
          state: audio.state,
          enabled: audio.enabled,
          // 'module' = 生产构建下 worklet 从 ?url 拿到了;'blob' = 走了内联回退。
          // 这两个都算成功,但**得能分辨** —— 回退路径没有报错,不代表没问题。
          workletSource: d.workletSource,
          workletError: d.workletError,
          noteCount: audio.composition.notes.length,
          // 指纹在 diagnostics 里(它算的是整张乐句表的哈希,不是 Composition 的字段)
          fingerprint: d.composition.fingerprint,
          resyncs: d.resyncs,
          // 下面两个是"到底有没有在响"的实证:started 是工作节点真正起播的音数,
          // dropped 是被动丢音(事件来晚了)。拿不到 started 就没法把
          // "上下文在跑" 与 "有声音" 分开说。
          started: d.worklet.started,
          dropped: d.worklet.dropped,
          maxGap: d.worklet.maxGap,
          clockSkew: d.worklet.clockSkew,
        };
      },
      /** 相机状态快照 —— 四项交互验证脚本读它。 */
      cameraSnapshot() {
        return director.snapshot();
      },
      /** 景点清单 —— 脚本按 id 取机位,不再从 DOM 里抠坐标。 */
      spots: SPOTS,
      /** 飞向某个位姿。返回本次要走的距离(米)。 */
      flyTo(s: { position: [number, number, number]; target: [number, number, number] }) {
        return director.flyTo({ position: s.position, target: s.target });
      },
      /** 按 id 飞向景点全景位。id 写错会抛错,并列出可用的 id。 */
      goSpot(id: string) {
        return director.flyTo(viewShot(spotById(id)));
      },
      startRoam() {
        director.startRoam();
      },
      startTour() {
        return director.startTour();
      },
      stopTour() {
        director.exitAuto('api');
      },
      /**
       * 采样当前画面并统计。
       *
       * 用来客观判断"是不是黑屏/空白" —— 只看截图肉眼容易漏判,
       * 而纯色画面的标准差接近 0,一眼可辨。
       */
      sampleCanvas(): {
        width: number;
        height: number;
        meanColor: [number, number, number];
        stdDev: number;
        nonUniformRatio: number;
        isSoftwareRenderer: boolean;
        drawCalls: number;
        triangles: number;
      } {
        // ⚠️ 必须先 reset 再 render。
        //    renderer.info 设了 autoReset=false,由主循环每帧开头重置;
        //    这里额外渲染一帧,若不先清零,读到的就是"循环那一帧 + 这一帧"
        //    的累加值 —— 实测会虚报成整整两倍(16 而非 8)。
        renderer.info.reset();
        renderer.render(scene, camera);

        const gl = renderer.getContext();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

        let n = 0;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sq = 0;
        // 以左上角像素为背景基准,统计与之明显不同的像素比例
        const br = buf[0]!;
        const bgc = buf[1]!;
        const bb = buf[2]!;
        let different = 0;

        const step = 4;
        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const i = (y * w + x) * 4;
            const r = buf[i]!;
            const g = buf[i + 1]!;
            const b = buf[i + 2]!;
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            sr += r;
            sg += g;
            sb += b;
            sq += lum * lum;
            n++;
            if (Math.abs(r - br) > 12 || Math.abs(g - bgc) > 12 || Math.abs(b - bb) > 12) {
              different++;
            }
          }
        }

        const meanLum = 0.2126 * (sr / n) + 0.7152 * (sg / n) + 0.0722 * (sb / n);
        const varLum = sq / n - meanLum * meanLum;

        return {
          width: w,
          height: h,
          meanColor: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
          stdDev: Math.round(Math.sqrt(Math.max(0, varLum)) * 100) / 100,
          nonUniformRatio: Math.round((different / n) * 1000) / 1000,
          isSoftwareRenderer: gpu.isSoftware,
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
        };
      },

      /**
       * 采样画面上一小块矩形,返回它的**色彩**(RGB + HSL)。
       *
       * 与 `sampleCanvas()` 的分工:那个回答"整幅画面是不是空白",
       * 这个回答"**画面上的某一点是什么颜色**"。水面变没变"海水蓝"
       * 只能由后者判断 —— 全画面均色会被陆地和天空稀释掉,
       * 一条湛蓝的河在一整幅土黄画面里几乎不影响均色。
       *
       * ⚠️ 色彩空间:读回来的是 canvas 后备缓冲区,即**已经过色调映射、
       *    已编码成 sRGB 的 8 bit 值**。所以这里的 HSL 是"眼睛看到的颜色",
       *    也正是"看着像不像土黄"该用的判据。
       *    若改用线性值算 HSL,同一块像素会得到完全不同的 H —— 那是
       *    **量错了尺子**,不是量错了水(见 memory: 仪表先于几何)。
       *
       * 坐标以**左上角为原点**(与截图、与 CSS 一致),内部再翻成 GL 的左下角原点。
       */
      sampleRect(x: number, y: number, w: number, h: number): {
        x: number;
        y: number;
        w: number;
        h: number;
        color: [number, number, number];
        hue: number;
        sat: number;
        light: number;
        clampWarning: string | null;
      } {
        renderer.info.reset();
        renderer.render(scene, camera);

        const gl = renderer.getContext();
        const W = gl.drawingBufferWidth;
        const H = gl.drawingBufferHeight;

        // 采样框夹到缓冲区内。被夹过要**报出来** ——
        // 静默夹取会让"采到了角落的树"看起来像"水面是绿的"。
        const x0 = Math.max(0, Math.min(W - 1, Math.round(x)));
        const y0 = Math.max(0, Math.min(H - 1, Math.round(y)));
        const rw = Math.max(1, Math.min(W - x0, Math.round(w)));
        const rh = Math.max(1, Math.min(H - y0, Math.round(h)));
        let clampWarning: string | null = null;
        if (x0 !== Math.round(x) || y0 !== Math.round(y) || rw !== Math.round(w) || rh !== Math.round(h)) {
          clampWarning = `采样框被夹到缓冲区内:请求 ${x},${y},${w},${h} → 实际 ${x0},${y0},${rw},${rh}`;
        }

        const buf = new Uint8Array(rw * rh * 4);
        // GL 原点在左下角 → 翻转 y
        gl.readPixels(x0, H - y0 - rh, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, buf);

        let sr = 0;
        let sg = 0;
        let sb = 0;
        const n = rw * rh;
        for (let i = 0; i < n; i++) {
          sr += buf[i * 4]!;
          sg += buf[i * 4 + 1]!;
          sb += buf[i * 4 + 2]!;
        }
        const r = sr / n;
        const g = sg / n;
        const b = sb / n;

        // HSL,不是 HSV —— 判据"土黄"说的是色相与**饱和度**,
        // 而 HSL 的 S 才是直觉上的"有多艳"。两者对同一点像素给出的
        // S 可以差一倍,选错了会得到"河很艳"的假结论。
        const rn = r / 255;
        const gn = g / 255;
        const bn = b / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        const l = (max + min) / 2;
        const d = max - min;
        let hue = 0;
        let sat = 0;
        if (d > 1e-9) {
          sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          if (max === rn) hue = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
          else if (max === gn) hue = ((bn - rn) / d + 2) * 60;
          else hue = ((rn - gn) / d + 4) * 60;
        }

        return {
          x: x0,
          y: y0,
          w: rw,
          h: rh,
          color: [Math.round(r), Math.round(g), Math.round(b)],
          hue: Math.round(hue * 10) / 10,
          sat: Math.round(sat * 1000) / 1000,
          light: Math.round(l * 1000) / 1000,
          clampWarning,
        };
      },
    },
    writable: false,
    configurable: false,
  });

  // 就绪信号:等遮罩真正消失后再置位,避免脚本抢在渲染前截图
  store.subscribe((s) => {
    if (s.load.phase !== 'ready') return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!('__QM_READY__' in window)) {
          Object.defineProperty(window, '__QM_READY__', { value: true, writable: false });
        }
      });
    });
  });

  window.addEventListener('beforeunload', () => {
    // ⚠️ 守卫要先摘。留着它的话,页面已经在拆了还可能被一个
    //    contextlost 事件回调进来,调 `loop.stop()` 去碰一个
    //    正在被销毁的渲染器。同理它也清掉那个 8 秒的超时定时器 ——
    //    不清理的话导航之后还会有一个定时器试图写 store。
    contextGuard.dispose();
    veil.dispose();
    director.dispose();
    // 粒子的几何/材质/贴图都是本模块自己建的(不来自 GLB),
    // 所以它得自己收拾 —— 别的子系统都是"用别人的几何"
    fx?.dispose();
    skyTime.dispose();
    ui.dispose();
  });
}

main();
