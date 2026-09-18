/**
 * 性能 HUD —— 真实读数,不是估算。
 *
 * ⚠️ 这一块的数字**全部来自实测**:帧时取自 `Loop` 的环形缓冲
 *    (记录的是未钳制的原始帧时),drawcall 与三角面取自 `renderer.info`。
 *    本文件不做任何"估算""按比例推算"或四舍五入到好看的值。
 *
 * 为什么必须显示 p95 而不是只显示平均帧率
 * --------------------------------------
 * 平均值会把周期性卡顿抹平:60fps 的平均可以是"稳定 60",也可以是
 * "一半 120 一半 30" —— 后者体感明显更差,但平均值一样。
 * 所以这里并列显示 avg / p95 / max,让卡顿无处可藏。
 *
 * ⚠️ 关于本机读数与用户读数的差异,写在 HUD 末行:本 HUD 显示的是
 *    **当前这台机器、当前这个浏览器**的实测值。它不是"这个作品能跑多快"
 *    的结论,更不能被当成"稳定 60fps"之类的宣传语引用。
 */

import { el, clear } from '../dom';
import type { FrameStats } from '../../core/loop';

export interface PerfSource {
  stats(): FrameStats;
  render(): { calls: number; triangles: number };
  memory(): { geometries: number; textures: number };
  gpu(): { renderer: string; isSoftware: boolean };
}

export interface PerfHud {
  root: HTMLElement;
  update(): void;
}

export function createPerfHud(src: PerfSource): PerfHud {
  const fps = el('span', { class: 'qm-hud__big' }, ['—']);
  const grid = el('div', { class: 'qm-hud__grid' });
  const root = el('div', { class: 'qm-hud qm-interactive' }, [
    el('div', { class: 'qm-hud__fps' }, [fps, el('span', { class: 'qm-hud__unit' }, ['fps 平均'])]),
    grid,
  ]);

  const fields: Record<string, HTMLElement> = {};
  function kv(key: string, label: string): HTMLElement {
    const v = el('span', { class: 'qm-kv__v' }, ['—']);
    fields[key] = v;
    return el('span', { class: 'qm-kv' }, [el('span', { class: 'qm-kv__k' }, [label]), v]);
  }

  grid.append(
    kv('p95', '帧时 p95'),
    kv('max', '帧时 max'),
    kv('calls', 'drawcall'),
    kv('tris', '三角面'),
    kv('geo', '几何'),
    kv('tex', '贴图'),
    kv('gpu', '渲染器'),
  );

  // 软件渲染必须显眼地标出来。
  // 本机若无头 Chrome 掉到 SwiftShader,所有帧时数字就都失去意义 ——
  // 而那种情况下画面**看起来是正常的**,只有读数在骗人。
  const warn = el('div', { class: 'qm-hud__warn', hidden: true }, [
    '⚠️ 当前是软件渲染(SwiftShader),帧时数据不代表真实 GPU 性能',
  ]);
  root.append(warn);

  let frame = 0;

  function update(): void {
    // 每 12 帧刷一次。每帧刷会让 HUD 自身的 DOM 开销进入被测量的帧时里 ——
    // 量具影响被测对象,这是最典型的观测者效应。
    if (frame++ % 12 !== 0) return;

    const st = src.stats();
    const r = src.render();
    const m = src.memory();
    const g = src.gpu();

    fps.textContent = st.frames === 0 ? '—' : st.avgFps.toFixed(1);
    fields.p95!.textContent = `${st.p95.toFixed(2)} ms`;
    fields.max!.textContent = `${st.max.toFixed(2)} ms`;
    fields.calls!.textContent = String(r.calls);
    fields.tris!.textContent = formatCount(r.triangles);
    fields.geo!.textContent = String(m.geometries);
    fields.tex!.textContent = String(m.textures);

    // 渲染器串很长(含 ANGLE / 显卡型号),截断显示,完整串在 title 里
    const gpuShort = g.renderer.slice(0, 34);
    fields.gpu!.textContent = gpuShort + (g.renderer.length > 34 ? '…' : '');
    fields.gpu!.parentElement!.title = g.renderer;

    warn.hidden = !g.isSoftware;
  }

  return { root, update };
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
