/**
 * 全局状态的**单一真相源**。
 *
 * 约定(阶段 3 的 UI 全量遵守,现在就先立住):
 *   · 任何模块都只能**读** `store.read()`;
 *   · 唯一的写入口是 `ui/actions.ts` 里的 action;
 *   · UI 组件只调 action,不直接改状态。
 *
 * 这条约定不是洁癖:画质切换要保证"对象 UUID 集合不变",切换时辰要保证
 * "PMREM 重建但相机不动"。如果谁都能改状态,这些不变量就无法断言,
 * `tests/state_invariants.mjs` 也就没有拦截能力。
 */

// --------------------------------------------------------------------------
// 类型
// --------------------------------------------------------------------------

export type Quality = 'low' | 'mid' | 'high';

export type LoadPhase =
  | 'idle'
  | 'manifest'
  | 'fetching'
  | 'parsing'
  | 'compiling'
  | 'ready'
  | 'failed';

export interface LoadFailure {
  url: string;
  /** 失败发生在哪一步 —— 遮罩上要显示它,否则用户只知道"失败了" */
  stage: 'manifest' | 'fetch' | 'parse' | 'compile';
  status?: number;
  message: string;
}

/** 一次阶段变迁。时间戳取 performance.now(),与主循环同源。 */
export interface PhaseMark {
  phase: LoadPhase;
  t: number;
  progress: number;
}

export interface LoadState {
  phase: LoadPhase;
  /** 0..1,单调不减 */
  progress: number;
  /** 当前正在处理的资源,显示在进度条下方 */
  current: string;
  /** 已下载字节 / 总字节。分母来自 manifest,不依赖 Content-Length */
  bytesLoaded: number;
  bytesTotal: number;
  failures: LoadFailure[];
  /**
   * 阶段变迁记录,按发生顺序。
   *
   * ⚠️ 这不是调试残留。本机 1MB 的 GLB 走 localhost 只要十几毫秒,
   *    外部脚本按 50ms 轮询根本采不到 fetching / parsing ——
   *    "进度确实依次经过了下载、解析、编译"这条出口断言,
   *    只能靠**在应用内部记录变迁**来证明,靠轮询是证明不了的。
   */
  phaseLog: PhaseMark[];
}

export interface UiState {
  /** 加载遮罩是否可见 */
  veil: boolean;
  /** 调试 HUD(帧率、drawcall、三角面)是否可见 */
  hud: boolean;
  /** 当前展开的浮动面板。同时只开一个 —— 两个面板叠在一起会互相遮挡。 */
  panel: PanelId;
  /**
   * 当前选中的景点 id。
   *
   * ⚠️ 它与 `panel` 是两个字段而不是一个「面板 + 参数」,因为
   *    `panel: 'spot'` 而 `selected: null` 是一个**必须能被表示出来的中间态** ——
   *    用户点了标签、面板正在打开的那一刻就是它。若把景点 id 塞进 panel
   *    变成一个字符串(如 `'spot:bridge'`),这个中间态就表示不出来了,
   *    代码只能靠"字符串里有没有冒号"来判断,那种判断迟早会错。
   */
  selected: string | null;
  /** 界面是否显示(「隐藏界面」开关)。关掉后只剩三维画面。 */
  chrome: boolean;
  /** 三维空间标签是否显示 */
  labels: boolean;
  /** 动画总开关(人物、船、风动) */
  anim: boolean;
  /** 线框模式 */
  wireframe: boolean;
  /** 配乐是否开启 */
  audio: boolean;
}

/**
 * 图形上下文的状态。
 *
 * 存在的理由:WebGL 上下文会**丢失** —— 显卡驱动重置、系统休眠唤醒、
 * 移动端后台切回、以及 GPU 进程崩溃。丢了之后画面会**永久停在最后一帧**,
 * 而页面不报任何错、控制台干干净净。用户看到的是"卡住了",
 * 我们能看到的什么都没有。所以把"丢过没有、恢复了几次"变成一份状态,
 * 界面才能说话、测试才有东西可断言。
 *
 * ⚠️ 之所以放在 store 而不是藏在 contextGuard 内部:遮罩是**由状态驱动**的
 *    (`LoadingVeil` 订阅 store)。若 guard 自己去操作 DOM,就会出现
 *    "两条路径都能改遮罩" —— 而这两条路径迟早会打架,且看不出谁赢。
 */
export interface GpuState {
  /** 当前是否处于丢失状态。遮罩据此显示。 */
  contextLost: boolean;
  /** 累计丢失次数。只增不减 —— 恢复不清零。 */
  lostCount: number;
  /** 累计恢复次数。 */
  restoredCount: number;
  /**
   * 丢失后等了很久仍没恢复。
   *
   * ⚠️ 这一项不是"再加个状态"。浏览器**常常根本不会**恢复上下文 ——
   *    驱动重置、显存耗尽之后它就不再发 `webglcontextrestored` 了。
   *    没有这一项的话,用户对着一动不动的画面永远等下去,
   *    而界面上一句话都没有;这跟"静默失败"是同一件事。
   *    置位后遮罩会给出「刷新页面」这条唯一的出路。
   */
  recoveryTimedOut: boolean;
  /**
   * 最近一次恢复里,每个重建项的成败。
   *
   * ⚠️ 逐项记,不记一个总的"成功/失败"。恢复流程里有好几件互不相干的
   *    重建(环境贴图、反射 RT、…),把它们合成一个布尔值之后,
   *    "环境贴图没重建"与"全都重建了"在读数上完全一样 ——
   *    而前者会让整个场景的材质变黑,后者是正常的。
   */
  lastRebuild: Array<{ name: string; ok: boolean; error?: string }>;
}

/** 可展开的面板。`none` 表示都关着。 */
export type PanelId = 'none' | 'spot' | 'map' | 'scroll' | 'basis' | 'settings';

export interface AppState {
  load: LoadState;
  ui: UiState;
  gpu: GpuState;
  quality: Quality;
  /** 时辰 0..1(0=拂晓, 0.5=白昼, 1=黄昏) */
  tod: number;
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

export type Listener = (state: Readonly<AppState>) => void;

function initialState(): AppState {
  return {
    load: {
      phase: 'idle',
      progress: 0,
      current: '',
      bytesLoaded: 0,
      bytesTotal: 0,
      failures: [],
      phaseLog: [],
    },
    ui: {
      veil: true,
      hud: false,
      panel: 'none',
      selected: null,
      chrome: true,
      labels: true,
      anim: true,
      wireframe: false,
      audio: false,
    },
    gpu: {
      contextLost: false,
      lostCount: 0,
      restoredCount: 0,
      recoveryTimedOut: false,
      lastRebuild: [],
    },
    quality: 'mid',
    tod: 0.5,
  };
}

class Store {
  private state: AppState = initialState();
  private readonly listeners = new Set<Listener>();

  /** 只读快照。调用方不得直接改它 —— 状态是冻结的。 */
  read(): Readonly<AppState> {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    // 立即推一次当前值,订阅者不必自己再读一遍
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  /**
   * 写入状态。
   *
   * ⚠️ 仅供 `ui/actions.ts` 调用。其它模块要改状态请走 action ——
   *    这是"唯一写入口"约定的执行点。
   */
  write(patch: (prev: AppState) => Partial<AppState>): void {
    const next = { ...this.state, ...patch(this.state) };
    this.state = Object.freeze(next) as AppState;
    for (const fn of this.listeners) fn(this.state);
  }
}

export const store = new Store();
