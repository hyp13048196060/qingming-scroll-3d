/**
 * 界面外壳 —— 顶栏、面板容器、底部工具栏、HUD、三维标签的装配处。
 *
 * 职责边界
 * --------
 *   · 本文件只负责**装配与同步**:建 DOM、把回调接到 action 上、
 *     按 `store` 的状态显示/隐藏。它自己不持有任何界面状态。
 *   · 每个面板的内部逻辑归 `panels/*`,每个 HUD 归 `hud/*`。
 *   · 相机的一切动作由 `main.ts` 注入进来(本文件不认识相机类)。
 *
 * ⚠️ 唯一的状态真相源是 `store`。本文件**不存** "当前面板是哪个" 之类的
 *    局部变量 —— 存了就会有两份,然后某次点击只更新了其中一份,
 *    于是按钮的高亮与实际展开的面板不一致,而这种不一致极难复现。
 *    所以 `sync()` 每次都从 `store.read()` 重新推导全部可见性。
 *
 * ⚠️ **唯一的例外是巡游**。它的状态在 `CameraDirector` 里(模式 `tour`
 *    只由相机状态机改变,而且用户碰一下画面就会脱离 —— 见
 *    `CameraDirector.exitAuto`)。把巡游也搬进 store 就要来回同步两份,
 *    而"用户拖了一下画面"这条路径根本不经过 UI。所以巡游走
 *    `deps.tourActive()` 每帧读一次,**变了才**触发 sync。
 */

import { el, button } from './dom';
import { store } from './store';
import * as actions from './actions';
import { createSpotPanel } from './panels/SpotPanel';
import { createMapPanel, type MapSpot } from './panels/MapPanel';
import { createBasisPanel } from './panels/BasisPanel';
import { createScrollPanel } from './panels/ScrollPanel';
import { createSettingsPanel } from './panels/SettingsPanel';
import { createPerfHud } from './hud/PerfHud';
import { createLabels, type LabelSpot } from './hud/Labels';
import { SPOTS } from '../data/spots';
import type { Loop } from '../core/loop';
import type * as THREE from 'three';

export interface UIRootDeps {
  mount: HTMLElement;
  loop: Loop;
  renderer: THREE.WebGLRenderer;
  camera: THREE.Camera;
  gpu: { renderer: string; isSoftware: boolean };
  /** 飞到景点全景位 */
  goSpot(id: string): void;
  /** 飞到景点近观位 */
  goNear(id: string): void;
  /** 开始巡游。返回 false 表示路线为空,没启动 —— 调用方要据此提示。 */
  startTour(): boolean;
  stopTour(): void;
  /** 相机当前是否在巡游。权威在 CameraDirector,不在这里复制一份。 */
  tourActive(): boolean;
  /**
   * 动画层是否**真的接上了线**。`true` 才画「动画」开关。
   *
   * ⚠️ 这不是一个普通的布尔配置项,而是「不许有无响应的装饰性控件」
   *    那条要求在 `anim` 上的落点 —— 与下面 `audio?` 是同一个理由,
   *    只是那边是运行期构造失败,这边是源码里有没有接线。
   *
   * 契约:这一项必须与真正接线的代码**对得上**。消费者是 `main.ts` 里
   * 三个带 `clock: 'anim'` 的环节(人物 / 道具风动 / 氛围粒子)。
   * 哪天那三处被改回 `'world'`,传进来的这一项也必须跟着变成 `false`。
   *
   * ⚠️ 光靠这一行的 `true` 证不了什么 —— 它是一句声明。所以另一半由
   *    `tools/perf/probe_ui.mjs` 承担:那边**真的去拨这个开关**,然后
   *    连拍两张人物位置快照,要求关掉时两张**完全相同**、打开时有位移。
   *    声明与行为一起查,装饰性控件才真被挡住。
   *
   * 写成**必填**而非可选:调用方忘了传会编译不过,而不是安静地少画一个
   * 开关。方向是选过的 —— 少画一个开关没人会发现,多画一个假开关
   * 用户会以为功能坏了。
   */
  anim: boolean;
  /**
   * 配乐引擎。**不注入就等于没有这个引擎**,此时按钮不画出来。
   *
   * ⚠️ 这不是可选参数的客套写法,而是「不许有无响应的装饰性控件」那条
   *    要求在类型上的落实:引擎没落地时,如果仍把「配乐」按钮画出来,
   *    用户点它什么都不会发生 —— 他会以为音频坏了,而不是以为还没做。
   *    所以"没有引擎"这件事在类型里就表示出来了,而不是靠一个空实现掩盖。
   */
  audio?: {
    /** 切开关。返回**实际生效**的状态(浏览器可能因非用户手势拒绝)。 */
    set(on: boolean): Promise<boolean>;
    /** 引擎当前状态短语,用于按钮次级文字。 */
    state(): string;
  };
}

export interface UIRoot {
  /** 每帧调用:标签投影、HUD 刷新、巡游状态跟随。 */
  update(): void;
  /** 解绑全局监听。漏掉它会在 UIRoot 被重建时留下一条按 H 会触发两次的监听。 */
  dispose(): void;
  /** 面板实例,给测试脚本取状态用。 */
  panels: {
    scroll: ReturnType<typeof createScrollPanel>;
  };
}

export function createUIRoot(deps: UIRootDeps): UIRoot {
  // ------------------------------------------------------------------
  // 顶栏:标题 + 五个景点按钮
  // ------------------------------------------------------------------
  const spotNav = el('nav', { class: 'qm-spotnav' });
  const spotButtons = new Map<string, HTMLButtonElement>();
  for (const s of SPOTS) {
    // 消费者:`actions.selectSpot` → 简介面板展开。
    // ⚠️ 点这里**不移动相机** —— 想移动要点面板里的【走近看看】。
    //    理由见 actions.ts:selectSpot 的注释。
    const b = button(s.name, () => actions.selectSpot(s.id), {
      class: 'qm-btn qm-spotnav__btn',
      'data-spot': s.id,
    });
    spotButtons.set(s.id, b);
    spotNav.append(b);
  }

  const topbar = el('header', { class: 'qm-topbar qm-interactive' }, [
    el('div', { class: 'qm-brand' }, [
      el('h1', { class: 'qm-brand__title' }, ['清明上河图']),
      el('span', { class: 'qm-brand__sub' }, ['三维长卷 · 汴河虹桥']),
    ]),
    spotNav,
  ]);

  // ------------------------------------------------------------------
  // 面板
  // ------------------------------------------------------------------
  const panelHost = el('aside', { class: 'qm-panelhost' });

  const spotPanel = createSpotPanel({
    onNear: (id) => deps.goNear(id),
    onClose: () => actions.closePanel(),
  });

  // 消费者:`deps.goSpot` → `director.flyTo(viewShot(...))`
  const mapPanel = createMapPanel({
    onPick: (id) => {
      actions.selectSpot(id);
      deps.goSpot(id);
    },
    onClose: () => actions.closePanel(),
  });

  // ⚠️ 必须**在图能看见之前**把点画上去。舆图不像别的面板那样自带内容:
  //    它的河道、桥梁、五个定位点全部由 build() 根据实测坐标算出来。
  //    漏掉这一次调用不会报任何错,只是图上空无一物 —— 一个"看着像加载中"
  //    的空面板,比直接报错更难查。
  mapPanel.build(SPOTS.map((s): MapSpot => ({ id: s.id, name: s.name, target: s.target })));

  const basisPanel = createBasisPanel(() => actions.closePanel());
  const scrollPanel = createScrollPanel(() => actions.closePanel());

  const settingsPanel = createSettingsPanel({
    onTimeOfDay: (t) => actions.setTimeOfDay(t),
    onQuality: (q) => actions.setQuality(q),
    onToggle: (key, on) => {
      if (key === 'anim') actions.setAnim(on);
      else if (key === 'labels') actions.setLabels(on);
      else actions.setWireframe(on);
    },
    onClose: () => actions.closePanel(),
  }, {
    // 直接转述调用方的声明,不在这里写死 true。
    // 这里写死的话,`deps.anim` 就只是个装饰性的参数了 —— 面板会永远
    // 画出那一行,而"动画层到底接没接线"这件事没人再对得上。
    anim: deps.anim,
  });

  panelHost.append(
    spotPanel.root,
    mapPanel.root,
    basisPanel.root,
    scrollPanel.root,
    settingsPanel.root,
  );

  // ------------------------------------------------------------------
  // 工具栏
  // ------------------------------------------------------------------
  const tourBtn = button(
    '巡游',
    () => {
      // 状态取自相机(权威),不取自 DOM —— 否则按钮文字一旦与实际状态脱节,
      // 就会点出"已经在巡游还要再开一次"这种事。
      if (deps.tourActive()) {
        deps.stopTour();
      } else if (!deps.startTour()) {
        // 路线为空时 startTour() 返回 false。静默失败会让按钮看起来是坏的。
        console.warn('[ui] 巡游路线为空,未启动。检查 data/spots.ts 的 tourShots()。');
      }
      sync();
    },
    { class: 'qm-btn qm-toolbar__btn', 'data-action': 'tour' },
  );

  const chromeBtn = button('隐藏界面', () => actions.toggleChrome(), {
    class: 'qm-btn qm-toolbar__btn',
    'data-action': 'chrome',
  });

  const fsBtn = button(
    '全屏',
    () => {
      // 消费者:浏览器 Fullscreen API。测试断言 document.fullscreenElement != null。
      if (document.fullscreenElement) void document.exitFullscreen();
      else
        void document.documentElement.requestFullscreen().catch((e: unknown) => {
          // 全屏可能被浏览器策略或权限拒绝,不能吞掉
          console.warn('[ui] 全屏被拒绝:', e);
        });
    },
    { class: 'qm-btn qm-toolbar__btn', 'data-action': 'fullscreen' },
  );

  const audioEngine = deps.audio;
  const audioBtn = audioEngine
    ? button(
        '配乐',
        () => {
          const want = !store.read().ui.audio;
          actions.setAudio(want);
          // ⚠️ 先写状态、再由引擎回报修正。浏览器可能因"非用户手势"拒绝,
          //    那时必须把状态改回来 —— 否则按钮高亮着"已开启"而实际没声音,
          //    用户只会以为音频坏了。
          void audioEngine.set(want).then((ok) => {
            if (ok !== want) {
              actions.setAudio(ok);
              console.warn(`[ui] 配乐实际状态为 ${ok},与请求的 ${want} 不一致,已按实际值回写。`);
            }
          });
        },
        { class: 'qm-btn qm-toolbar__btn', 'data-action': 'audio' },
      )
    : null;

  const hudBtn = button('数据', () => actions.toggleHud(), {
    class: 'qm-btn qm-toolbar__btn',
    'data-action': 'hud',
  });

  /**
   * 「隐藏界面」之后的返回按钮。
   *
   * ⚠️ 它**必须挂在 toolbar 之外**。挂在里面的话,隐藏界面时它自己也被
   *    藏掉(尺寸变 0×0),用户就再也点不回来了 —— 界面成一次性的。
   *    这是探针实测撞到的:`[data-action="chrome"]` 第二次点击时是 0×0。
   *    「隐藏界面」这个动作本身就是把工具栏藏起来,所以恢复入口**不可能**
   *    在工具栏上,这不是布局偏好而是逻辑上的必然。
   */
  const restoreBtn = button('显示界面', () => actions.setChrome(true), {
    class: 'qm-btn qm-restore qm-interactive',
    'data-action': 'unhide',
  });

  function panelBtn(label: string, id: 'map' | 'scroll' | 'basis' | 'settings'): HTMLButtonElement {
    return button(
      label,
      () => {
        // 原卷是惰性加载的:首次打开才去取图,不给启动流程加负担
        if (id === 'scroll') scrollPanel.load();
        actions.togglePanel(id);
      },
      { class: 'qm-btn qm-toolbar__btn', 'data-panel': id },
    );
  }

  const toolbar = el('footer', { class: 'qm-toolbar qm-interactive' }, [
    el('div', { class: 'qm-toolbar__group' }, [
      panelBtn('舆图', 'map'),
      panelBtn('原卷', 'scroll'),
      panelBtn('依据', 'basis'),
      panelBtn('设置', 'settings'),
    ]),
    // `el()` 会跳过 children 里的 null,所以没有音频引擎时那个按钮直接不出现
    el('div', { class: 'qm-toolbar__group' }, [tourBtn, chromeBtn, fsBtn, audioBtn, hudBtn]),
  ]);

  // ------------------------------------------------------------------
  // HUD 与标签
  // ------------------------------------------------------------------
  const hud = createPerfHud({
    stats: () => deps.loop.stats(),
    render: () => ({
      calls: deps.renderer.info.render.calls,
      triangles: deps.renderer.info.render.triangles,
    }),
    memory: () => ({
      geometries: deps.renderer.info.memory.geometries,
      textures: deps.renderer.info.memory.textures,
    }),
    gpu: () => deps.gpu,
  });

  const labels = createLabels(
    SPOTS.map((s): LabelSpot => ({ id: s.id, name: s.name, bboxThree: s.anchor.bboxThree })),
    { onPick: (id) => actions.selectSpot(id) },
  );

  // 挂在 mount 下。注意 `#ui-root` 自身是 pointer-events:none,
  // 所以每个可交互容器都带 .qm-interactive 把它放开(见 styles/base.css)。
  // `restoreBtn` 单独挂在最外层 —— 它不属于任何会被隐藏的容器(见其定义处的注释)。
  deps.mount.append(labels.root, hud.root, topbar, panelHost, toolbar, restoreBtn);

  // ------------------------------------------------------------------
  // 键盘:H = 显示/隐藏界面
  //
  // 加这条是因为「隐藏界面」在触屏之外还有一个高频场景 —— 想反复截图对比。
  // 每次都要去找那个半透明的小按钮太费事。它不是**唯一**的退路:
  // 上面的 restoreBtn 才是(触屏用户没有键盘)。两者都要有。
  // ------------------------------------------------------------------
  function onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    // 滑块吃方向键、输入框吃字符键,别把界面显隐抢过来
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      actions.toggleChrome();
    }
  }
  window.addEventListener('keydown', onKeyDown);

  // ------------------------------------------------------------------
  // 同步:每次状态变化都从 store 重新推导
  // ------------------------------------------------------------------
  /** 上一次看到的巡游状态,用来判断要不要重画按钮。 */
  let lastTourActive = false;

  function sync(): void {
    const s = store.read();

    // 面板:有且只有一个可见
    spotPanel.root.hidden = s.ui.panel !== 'spot';
    mapPanel.root.hidden = s.ui.panel !== 'map';
    basisPanel.root.hidden = s.ui.panel !== 'basis';
    scrollPanel.root.hidden = s.ui.panel !== 'scroll';
    settingsPanel.root.hidden = s.ui.panel !== 'settings';

    spotPanel.update(s.ui.selected);
    settingsPanel.update(s);

    // 工具栏按钮的选中态
    for (const id of ['map', 'scroll', 'basis', 'settings'] as const) {
      toolbar.querySelector(`[data-panel="${id}"]`)!.classList.toggle('is-on', s.ui.panel === id);
    }
    for (const [id, b] of spotButtons) {
      b.classList.toggle('is-on', s.ui.selected === id && s.ui.panel === 'spot');
    }

    tourBtn.textContent = lastTourActive ? '停止巡游' : '巡游';
    tourBtn.classList.toggle('is-on', lastTourActive);
    // chromeBtn 的文字是常量:它只随工具栏可见,而工具栏只在 chrome=true 时可见,
    // 所以它永远读作「隐藏界面」,不存在需要改成「显示界面」的时机 ——
    // 那件事由 restoreBtn 负责(它才是那条路径上唯一存在的按钮)。
    hudBtn.classList.toggle('is-on', s.ui.hud);
    if (audioBtn && audioEngine) {
      audioBtn.classList.toggle('is-on', s.ui.audio);
      audioBtn.textContent = s.ui.audio ? `配乐 · ${audioEngine.state()}` : '配乐';
    }

    // ⚠️ 「隐藏界面」只隐藏**界面**,不隐藏三维标签 ——
    //    标签属于场景内容的一部分,由「设置 → 标签」单独控制。
    //    把两者揉在一起的话,想截一张"只有画面没有 UI"的图时标签也会消失,
    //    而那往往正是想留下的东西。
    topbar.hidden = !s.ui.chrome;
    toolbar.hidden = !s.ui.chrome;
    panelHost.hidden = !s.ui.chrome;
    hud.root.hidden = !s.ui.hud;
    labels.setVisible(s.ui.labels);
    // ⚠️ 与上面三个**相反**:界面隐藏时它才出现,而且它不在被隐藏的容器里。
    //    把它和 topbar 写成同一行(`restoreBtn.hidden = !s.ui.chrome`)就
    //    等于又一次把退路藏掉,只是藏在了另一个地方。
    restoreBtn.hidden = s.ui.chrome;
  }

  // subscribe 会立即推一次当前状态,所以这里就等于"初始化后立刻同步一遍"
  store.subscribe(sync);

  return {
    update(): void {
      const s = store.read();

      // 巡游状态跟着相机走。每帧一次布尔比较,变了才重画 ——
      // 逐帧重画按钮文字会让 HUD 的帧时读数把这点开销算进去。
      const active = deps.tourActive();
      if (active !== lastTourActive) {
        lastTourActive = active;
        sync();
      }

      labels.update(deps.camera, deps.renderer.domElement.clientWidth, deps.renderer.domElement.clientHeight);
      if (s.ui.hud) hud.update();

      // 舆图上的相机标记:只在舆图开着时更新(关着就是白算)
      if (s.ui.panel === 'map') {
        const p = deps.camera.position;
        mapPanel.setCamera(p.x, p.z);
      }
    },
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
    },
    panels: { scroll: scrollPanel },
  };
}
