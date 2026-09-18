/**
 * 景点简介面板 —— 功能组 ③「标签 → 简介 → 走近看看」。
 *
 * 三段式:点三维标签或顶部景点按钮 → 本面板展开 → 点【走近看看】相机飞到近观位。
 *
 * ⚠️ 为什么会有一条 `caveat` 固定在底部
 *    这条不是装饰,也不是免责声明式的套话。本作品的核心约束是
 *    「不得暗示复原程度高于实际」,而一个写得漂亮的简介面板**天然**
 *    会让人以为"这些都有依据"。所以每一段简介下面都固定显示它**做不到**
 *    的那部分,且样式上不做弱化 —— 弱化成小灰字就等于没有。
 *
 * ⚠️ 【走近看看】是**显式**的相机动作,点标签本身不移动镜头。
 *    理由见 `ui/actions.ts:selectSpot` 的注释。
 */

import { el, button, richText, clear } from '../dom';
import { findHotspot, GRADES, type Hotspot } from '../../data/content';
import { spotById } from '../../data/spots';

export interface SpotPanelCallbacks {
  /** 相机飞到该景点的近观位。 */
  onNear: (id: string) => void;
  onClose: () => void;
}

export interface SpotPanel {
  root: HTMLElement;
  update(selectedId: string | null): void;
}

export function createSpotPanel(cb: SpotPanelCallbacks): SpotPanel {
  const body = el('div', { class: 'qm-panel__body' });
  const root = el('section', { class: 'qm-panel qm-panel--spot qm-interactive' }, [
    el('header', { class: 'qm-panel__head' }, [
      el('h2', { class: 'qm-panel__title' }, ['—']),
      button('关闭', cb.onClose, { class: 'qm-btn qm-btn--ghost', 'aria-label': '关闭简介' }),
    ]),
    body,
  ]);

  // 缓存上一次渲染的 id。同一个景点重复 update 时不再重建 DOM ——
  // 否则相机每帧触发的 store 通知都会把面板重刷一遍,用户正在读的
  // 文字会被反复重建(选中文本会丢失、滚动位置会跳回顶部)。
  let lastId: string | null = null;

  function render(h: Hotspot): void {
    clear(body);

    // 可靠度徽标 —— 与「复原依据」面板用同一套等级定义,不各写一份
    const g = GRADES[h.reliability];
    const badge = el('span', { class: `qm-grade qm-grade--${h.reliability}` }, [
      `${h.reliability} · ${g.label}`,
    ]);

    body.append(
      el('div', { class: 'qm-panel__meta' }, [
        badge,
        el('span', { class: 'qm-panel__anchor' }, [`看点 ${h.name}`]),
      ]),
      el('p', { class: 'qm-panel__intro' }, [richText(h.intro)]),
    );

    if (h.points.length) {
      const ul = el('ul', { class: 'qm-points' });
      for (const p of h.points) ul.append(el('li', {}, [richText(p)]));
      body.append(ul);
    }

    // 不可知的部分。样式上与正文同权重,不弱化。
    body.append(
      el('div', { class: 'qm-caveat' }, [
        el('span', { class: 'qm-caveat__tag' }, ['边界']),
        el('p', {}, [richText(h.caveat)]),
      ]),
    );

    // 【走近看看】只在 near 机位确实存在时才可点。
    // 这里不写"没有就近观位"的降级 —— spots.json 的校验层已经保证
    // 五个景点都有 near,拿不到就是数据坏了,应当让它显式失败。
    const spot = spotById(h.id);
    body.append(
      el('div', { class: 'qm-actions' }, [
        button(`走近看看`, () => cb.onNear(h.id), { class: 'qm-btn qm-btn--primary' }),
        el('span', { class: 'qm-actions__hint' }, [
          `近观位 (${spot.near.map((v) => v.toFixed(1)).join(', ')})`,
        ]),
      ]),
    );
  }

  function update(selectedId: string | null): void {
    if (selectedId === lastId) return;
    lastId = selectedId;

    const h = findHotspot(selectedId);
    if (!h) {
      // 没有选中景点时不渲染空壳 —— 面板的显隐由 UIRoot 按 panel 状态决定,
      // 这里只管内容。留着上一次的内容会被误读成"选中了它"。
      clear(body);
      root.querySelector('.qm-panel__title')!.textContent = '—';
      return;
    }
    root.querySelector('.qm-panel__title')!.textContent = h.title;
    render(h);
  }

  return { root, update };
}
