/**
 * 状态写入的**唯一入口**。
 *
 * UI、加载器、相机都只调这里的函数。这样"状态怎么变的"永远只有一处
 * 可查,也才有可能为状态不变量写断言。
 */

import { store, type AppState, type LoadFailure, type PanelId, type Quality } from './store';

// --------------------------------------------------------------------------
// 加载
// --------------------------------------------------------------------------

/** 进度只允许前进。跳回 0 会让进度条视觉上倒退,用户以为出错了。 */
function monotonic(prev: number, next: number): number {
  return Math.max(prev, Math.min(1, next));
}

export function loadPhase(phase: AppState['load']['phase'], current = ''): void {
  store.write((s) => {
    // 重复设置同一阶段不重复记账,否则轮询式的调用会把日志刷满
    if (s.load.phase === phase) return { load: { ...s.load, current } };
    return {
      load: {
        ...s.load,
        phase,
        current,
        phaseLog: [...s.load.phaseLog, { phase, t: performance.now(), progress: s.load.progress }],
      },
    };
  });
}

export function loadProgress(progress: number, current?: string, bytes?: [number, number]): void {
  store.write((s) => ({
    load: {
      ...s.load,
      progress: monotonic(s.load.progress, progress),
      current: current ?? s.load.current,
      bytesLoaded: bytes ? bytes[0] : s.load.bytesLoaded,
      bytesTotal: bytes ? bytes[1] : s.load.bytesTotal,
    },
  }));
}

export function loadReady(): void {
  store.write((s) => ({
    load: {
      ...s.load,
      phase: 'ready',
      progress: 1,
      current: '',
      failures: [],
      phaseLog: [...s.load.phaseLog, { phase: 'ready', t: performance.now(), progress: 1 }],
    },
    ui: { ...s.ui, veil: false },
  }));
}

/**
 * 记录一次失败。
 *
 * ⚠️ 要把**具体哪个文件、哪一步、什么错误**记下来并显示出来。
 *    只显示"加载失败"等于没给任何排查线索 —— 这是本作品对
 *    "不静默失败"的具体落实。
 */
export function loadFailed(failure: LoadFailure): void {
  store.write((s) => ({
    load: {
      ...s.load,
      phase: 'failed',
      failures: [...s.load.failures, failure],
    },
    ui: { ...s.ui, veil: true },
  }));
}

/**
 * 重试:清空失败列表,回到起点。
 *
 * ⚠️ phaseLog **不清空**。它是"本次会话里加载到底走过哪些阶段"的账本,
 *    重试恰好是最需要看这份账本的时候 —— 把上一次的记录留着,
 *    才能看出两次尝试是在同一步失败还是不同步。
 */
export function loadRetry(): void {
  const prev = store.read();
  store.write(() => ({
    load: {
      phase: 'idle',
      progress: 0,
      current: '',
      bytesLoaded: 0,
      bytesTotal: 0,
      failures: [],
      phaseLog: [
        ...prev.load.phaseLog,
        { phase: 'idle', t: performance.now(), progress: 0 },
      ],
    },
    // ⚠️ 必须整个 `ui` 展开再改,不能只写 `{ veil: true, hud: ... }`。
    //    后者会把没列出来的字段**整个删掉**:重试一次之后 `ui.chrome`
    //    变成 undefined(界面整体消失)、`ui.panel` 变成 undefined
    //    (面板路由错乱),而且不报任何错 —— 状态对象只是少了几把钥匙。
    //    这是 UiState 加字段时最容易漏的一处,由 tsc 的 TS2740 兜住。
    ui: { ...prev.ui, veil: true },
  }));
}

// --------------------------------------------------------------------------
// 图形上下文
// --------------------------------------------------------------------------

/** 上下文丢失。遮罩由 `gpu.contextLost` 驱动,不在这里碰 DOM。 */
export function contextLost(): void {
  store.write((s) => ({
    gpu: {
      ...s.gpu,
      contextLost: true,
      lostCount: s.gpu.lostCount + 1,
      // ⚠️ 必须一起清掉。清理成"每次丢失都从零开始等",否则第二次丢失会
      //    直接显示上一次的超时结论 —— 用户看到"恢复超时"的瞬间,
      //    浏览器其实才刚开始尝试。
      recoveryTimedOut: false,
    },
  }));
}

/** 等了很久也没恢复。遮罩据此显示「刷新页面」。 */
export function contextRecoveryTimedOut(): void {
  store.write((s) => ({ gpu: { ...s.gpu, recoveryTimedOut: true } }));
}

/**
 * 上下文已恢复。
 *
 * ⚠️ 这里**同时**写 `lastRebuild` 与 `restoredCount`。分成两个 action 的话,
 *    中间会存在"计数已加、重建报告还没写"的一帧 —— 而探针恰好在这一帧
 *    读到的话,会报"这次恢复一个重建项都没有",看起来像恢复流程整个没跑。
 */
export function contextRestored(
  rebuild: Array<{ name: string; ok: boolean; error?: string }>,
): void {
  store.write((s) => ({
    gpu: {
      ...s.gpu,
      contextLost: false,
      recoveryTimedOut: false,
      restoredCount: s.gpu.restoredCount + 1,
      lastRebuild: rebuild,
    },
  }));
}

// --------------------------------------------------------------------------
// 界面
// --------------------------------------------------------------------------

export function setVeil(visible: boolean): void {
  store.write((s) => ({ ui: { ...s.ui, veil: visible } }));
}

/**
 * 直接设 HUD 的开关。
 *
 * 存在的理由是 `toggleHud` 表达不了"我要它一定开着" —— 排障与批量截图
 * 都必须能**指定**状态,而不是"当前是关的所以点一下就好了"。靠 toggle
 * 来设定状态的脚本会在初始值变了之后**静默地设成相反的值**。
 */
export function setHud(hud: boolean): void {
  store.write((s) => ({ ui: { ...s.ui, hud } }));
}

export function toggleHud(): void {
  store.write((s) => ({ ui: { ...s.ui, hud: !s.ui.hud } }));
}

export function setQuality(quality: Quality): void {
  store.write(() => ({ quality }));
}

export function setTimeOfDay(t: number): void {
  store.write(() => ({ tod: Math.min(1, Math.max(0, t)) }));
}

/**
 * 打开一个面板。`'none'` 等于全关。
 *
 * **同时只开一个**是有意的:舆图与复原依据并排开着会把三维画面挤成一条缝,
 * 而这个作品的主要内容是三维画面。切换面板不改变相机 —— 用户可能只是想
 * 一边看介绍一边看景。
 */
export function openPanel(panel: PanelId): void {
  store.write((s) => ({ ui: { ...s.ui, panel } }));
}

/** 关闭当前面板。 */
export function closePanel(): void {
  store.write((s) => ({ ui: { ...s.ui, panel: 'none' } }));
}

/**
 * 选中一个景点并展开它的简介面板。
 *
 * ⚠️ 这里**不做相机移动**。「点标签 → 看简介」与「点【走近看看】→ 相机飞过去」
 *    是两件事:前者只是想读一段字。若点标签就把镜头拽走,用户读到一半
 *    画面已经在动了,而他还得先把面板关掉才能挪回去。
 *    相机移动是 `flyToSpot` 的职责,由面板上的按钮显式触发。
 */
export function selectSpot(id: string | null): void {
  store.write((s) => ({
    ui: { ...s.ui, selected: id, panel: id ? 'spot' : s.ui.panel },
  }));
}

/** 面板的开/关切换。再点一次同一个按钮就是关掉它。 */
export function togglePanel(panel: PanelId): void {
  store.write((s) => ({ ui: { ...s.ui, panel: s.ui.panel === panel ? 'none' : panel } }));
}

export function setChrome(on: boolean): void {
  store.write((s) => ({ ui: { ...s.ui, chrome: on } }));
}

export function toggleChrome(): void {
  store.write((s) => ({ ui: { ...s.ui, chrome: !s.ui.chrome } }));
}

export function setLabels(on: boolean): void {
  store.write((s) => ({ ui: { ...s.ui, labels: on } }));
}

export function setAnim(on: boolean): void {
  store.write((s) => ({ ui: { ...s.ui, anim: on } }));
}

export function setWireframe(on: boolean): void {
  store.write((s) => ({ ui: { ...s.ui, wireframe: on } }));
}

export function setAudio(on: boolean): void {
  store.write((s) => ({ ui: { ...s.ui, audio: on } }));
}
