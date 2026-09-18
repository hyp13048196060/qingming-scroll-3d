/**
 * 设置面板 —— 功能组 ⑤「时辰 / 画质 / 动画·标签·线框开关」。
 *
 * ⚠️ 本面板**没有任何装饰性控件**。每个控件都必须满足两条:
 *    ① 改的是 `store`(经 actions),不是 DOM 自己的状态;
 *    ② 有一个真实的消费者订阅它去改变渲染。
 *    做不到②的控件一律不加 —— 一个拖动无反应的滑块,比没有滑块更糟:
 *    用户会以为是性能问题,然后反复拖。
 *
 * 每个开关的消费者写在各自注释里,便于核对。
 */

import { el, clear } from '../dom';
import type { AppState, Quality } from '../store';

export interface SettingsCallbacks {
  onTimeOfDay: (t: number) => void;
  onQuality: (q: Quality) => void;
  onToggle: (key: 'anim' | 'labels' | 'wireframe', on: boolean) => void;
  onClose: () => void;
}

/**
 * 哪些开关**当前真的有消费者**。
 *
 * ⚠️ 这不是预留接口,是一道防止「装饰性控件」的闸门。
 *    把「动画」复选框画出来是需要资格的:用户勾掉它而画面上什么都没变,
 *    他会得出"这个作品的动画是坏的"或"这按钮没用"的结论 ——
 *    而这比按钮不存在更糟。
 *
 *    `anim` 的资格在阶段 4 拿到了,消费者是 `main.ts` 里三个带
 *    `clock: 'anim'` 的环节(人物 / 道具风动 / 氛围粒子),开关经由
 *    `animOn → animDt` 落到它们身上。调用方(`UIRoot`)按此声明 capability。
 *
 * ⚠️ 这里的 `true` 只是**画不画这一行**;它是不是"真有响应"由
 *    `tools/perf/probe_ui.mjs` 拨一遍开关去验。两件事别混为一谈 ——
 *    这个文件决定"画",那边决定"算了"。
 */
export interface SettingsCapabilities {
  anim: boolean;
}

const DEFAULT_CAPS: SettingsCapabilities = { anim: false };

export interface SettingsPanel {
  root: HTMLElement;
  update(s: Readonly<AppState>): void;
}

/** 时辰滑块的档位名,只用于显示。刻度与 PRESETS 的三个锚点一致。 */
const TOD_LABEL = (t: number): string =>
  t < 0.15 ? '拂晓' : t < 0.38 ? '晨' : t < 0.62 ? '正午' : t < 0.85 ? '午后' : '暮色';

const QUALITY_LABEL: Record<Quality, string> = {
  low: '流畅',
  mid: '均衡',
  high: '精细',
};

export function createSettingsPanel(
  cb: SettingsCallbacks,
  caps: Partial<SettingsCapabilities> = {},
): SettingsPanel {
  const cap: SettingsCapabilities = { ...DEFAULT_CAPS, ...caps };

  // —— 时辰 ——
  // 消费者:`main.ts` 订阅 store.tod → `skyTime.setTimeOfDay()`,
  //         后者改天空/太阳/雾并置 environmentDirty,下一帧重建 PMREM。
  const todInput = el('input', {
    type: 'range',
    min: '0',
    max: '1',
    step: '0.01',
    class: 'qm-range',
    'aria-label': '时辰',
  }) as HTMLInputElement;
  const todValue = el('span', { class: 'qm-kv__v' }, ['—']);
  todInput.addEventListener('input', () => cb.onTimeOfDay(Number(todInput.value)));

  // —— 画质 ——
  // 消费者:`core/quality.ts` 的 reconciler。它按档位改 pixelRatio /
  //         阴影贴图边长 / 反射 RT,**绝不重建任何对象** ——
  //         所以「切换前后对象 UUID 集合相同」是可以断言的。
  const qRow = el('div', { class: 'qm-seg' });
  const qButtons = new Map<Quality, HTMLButtonElement>();
  for (const q of ['low', 'mid', 'high'] as Quality[]) {
    const b = el(
      'button',
      { type: 'button', class: 'qm-btn qm-seg__btn', 'data-quality': q },
      [QUALITY_LABEL[q]],
    ) as HTMLButtonElement;
    b.addEventListener('click', () => cb.onQuality(q));
    qButtons.set(q, b);
    qRow.append(b);
  }

  // —— 开关 ——
  // anim      → 消费者:main.ts 里三个 clock:'anim' 的环节(人物/道具风动/
  //             氛围粒子)。关掉后它们收到的 dt 是 0、相位停住;
  //             重新打开是从**冻结处**续上,不是跳到新相位(故不跳变)。
  // labels    → 消费者:ui/hud/Labels.ts 的可见性。
  // wireframe → 消费者:core/quality.ts,遍历已登记的材质改 material.wireframe。
  //             ⚠️ 它**只改材质属性**,不新建材质、不换几何 ——
  //             否则每切一次线框就多一批材质,显存只增不减。
  type ToggleKey = 'anim' | 'labels' | 'wireframe';
  const toggles: Partial<Record<ToggleKey, HTMLInputElement>> = {};

  function makeRow(label: string, key: ToggleKey): HTMLElement {
    const input = el('input', {
      type: 'checkbox',
      class: 'qm-check',
      id: `qm-${key}`,
    }) as HTMLInputElement;
    input.addEventListener('change', () => cb.onToggle(key, input.checked));
    toggles[key] = input;
    return el('label', { class: 'qm-switch', for: `qm-${key}` }, [input, el('span', {}, [label])]);
  }

  // 「动画」只在它真有消费者时才出现 —— 理由见 SettingsCapabilities 的注释
  const switchRows: HTMLElement[] = [
    ...(cap.anim ? [makeRow('动画', 'anim')] : []),
    makeRow('标签', 'labels'),
    makeRow('线框', 'wireframe'),
  ];

  const body = el('div', { class: 'qm-panel__body' }, [
    el('div', { class: 'qm-field' }, [
      el('div', { class: 'qm-field__head' }, [
        el('span', { class: 'qm-field__label' }, ['时辰']),
        todValue,
      ]),
      todInput,
      el('div', { class: 'qm-field__hint' }, [
        '拖动会实时重建天空与环境光贴图。三档锚点:拂晓 0 · 白昼 0.5 · 暮色 1。',
      ]),
    ]),
    el('div', { class: 'qm-field' }, [
      el('div', { class: 'qm-field__head' }, [
        el('span', { class: 'qm-field__label' }, ['画质']),
      ]),
      qRow,
      el('div', { class: 'qm-field__hint' }, [
        '切换画质不会重建任何三维对象,只调分辨率、阴影与反射开销。',
      ]),
    ]),
    el('div', { class: 'qm-field' }, [
      el('div', { class: 'qm-field__head' }, [
        el('span', { class: 'qm-field__label' }, ['显示']),
      ]),
      el('div', { class: 'qm-switches' }, switchRows),
    ]),
  ]);

  const root = el('section', { class: 'qm-panel qm-panel--settings qm-interactive' }, [
    el('header', { class: 'qm-panel__head' }, [
      el('h2', { class: 'qm-panel__title' }, ['设置']),
      el('button', { class: 'qm-btn qm-btn--ghost', type: 'button' }, ['关闭']),
    ]),
    body,
  ]);
  root.querySelector('button')!.addEventListener('click', cb.onClose);

  function update(s: Readonly<AppState>): void {
    // ⚠️ 只在**值确实不同**时写 DOM。
    //    本面板每帧都被 store 通知调用,若无条件赋值,用户正在拖的滑块
    //    会被"同步"回上一帧的值,表现为拖不动。
    if (document.activeElement !== todInput) todInput.value = String(s.tod);
    todValue.textContent = `${s.tod.toFixed(2)} · ${TOD_LABEL(s.tod)}`;

    for (const [q, b] of qButtons) b.classList.toggle('is-on', q === s.quality);

    // ⚠️ 只在**值确实不同**时写 DOM。本面板每次 store 通知都会被调用,
    //    无条件赋值会把用户刚点下的复选框按状态"同步"回去。
    //    查表仍然容缺:`anim` 那一行存不存在由 capability 决定(见文件头),
    //    哪天它被关掉,这里不该因为读到一个不存在的复选框而抛。
    const set = (key: ToggleKey, on: boolean): void => {
      const node = toggles[key];
      if (node && node.checked !== on) node.checked = on;
    };
    set('anim', s.ui.anim);
    set('labels', s.ui.labels);
    set('wireframe', s.ui.wireframe);
  }

  return { root, update };
}
