/**
 * 复原依据面板 —— 功能组 ④「复原依据」。
 *
 * 验收:条目 ≥12,且**每条带可靠度徽标**。条数与等级定义来自
 * `src/data/basis.json`,本文件不写死任何一条。
 *
 * ⚠️ 等级筛选是**默认全部显示**的,而不是默认只看 A。
 *    默认只看 A 会让读者以为"这个作品几乎全有依据",而实际上本作
 *    相当一部分内容是 C 级推断。把 C 藏起来是最容易发生、也最不该发生的
 *    一种误导 —— 它不需要说谎,只需要把不利的那部分折叠起来。
 *    所以默认全开,并且筛选按钮上**直接标出各等级有几条**。
 */

import { el, clear, richText } from '../dom';
import { BASIS, GRADES, BASIS_CAVEAT, basisCounts, type Grade } from '../../data/content';

export interface BasisPanel {
  root: HTMLElement;
}

export function createBasisPanel(onClose: () => void): BasisPanel {
  const counts = basisCounts();
  const list = el('div', { class: 'qm-basis__list' });
  const active = new Set<Grade>(['A', 'B', 'C']);

  const filters = el('div', { class: 'qm-basis__filters' });

  function applyFilter(): void {
    for (const row of Array.from(list.children)) {
      const g = (row as HTMLElement).dataset.grade as Grade | undefined;
      (row as HTMLElement).hidden = !g || !active.has(g);
    }
    for (const b of Array.from(filters.children)) {
      const g = (b as HTMLElement).dataset.grade as Grade | undefined;
      if (g) b.classList.toggle('is-off', !active.has(g));
    }
  }

  for (const g of ['A', 'B', 'C'] as Grade[]) {
    const def = GRADES[g];
    const b = el(
      'button',
      {
        type: 'button',
        class: `qm-btn qm-gradebtn qm-grade--${g}`,
        'data-grade': g,
        title: def.desc,
      },
      [`${g} ${def.label} ${counts[g]}`],
    );
    b.addEventListener('click', () => {
      if (active.has(g)) active.delete(g);
      else active.add(g);
      applyFilter();
    });
    filters.append(b);
  }

  for (const e of BASIS) {
    const def = GRADES[e.grade];
    const row = el('article', { class: 'qm-basis__item', 'data-grade': e.grade }, [
      el('header', {}, [
        el('span', { class: `qm-grade qm-grade--${e.grade}`, title: def.desc }, [
          `${e.grade} · ${def.label}`,
        ]),
        el('h3', {}, [e.topic]),
      ]),
      el('p', { class: 'qm-basis__claim' }, [richText(e.claim)]),
      el('p', { class: 'qm-basis__basis' }, [richText(e.basis)]),
      e.assert
        ? el('p', { class: 'qm-basis__assert' }, [
            el('span', { class: 'qm-k' }, ['机器断言']),
            el('code', {}, [e.assert]),
          ])
        : null,
      e.caveat ? el('p', { class: 'qm-basis__caveat' }, [richText(e.caveat)]) : null,
    ]);
    list.append(row);
  }

  const root = el('section', { class: 'qm-panel qm-panel--basis qm-interactive' }, [
    el('header', { class: 'qm-panel__head' }, [
      el('h2', { class: 'qm-panel__title' }, [`复原依据(${BASIS.length} 条)`]),
      el('button', { class: 'qm-btn qm-btn--ghost', type: 'button' }, ['关闭']),
    ]),
    el('div', { class: 'qm-panel__body' }, [
      el('p', { class: 'qm-basis__caveat' }, [richText(BASIS_CAVEAT)]),
      filters,
      list,
    ]),
  ]);

  root.querySelector('button')!.addEventListener('click', onClose);
  applyFilter();

  return { root };
}
