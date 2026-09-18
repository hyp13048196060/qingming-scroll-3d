/**
 * 舆图面板 —— 功能组 ④「舆图定位」。
 *
 * ⚠️ 这张图**不是**原画的缩略图,也不是美术画的示意图。
 *    它是从 `spots.json` 的实测坐标**算出来的俯视图**:每个点画在它
 *    真实的三维 XZ 位置上,河道按实测的 x∈[−8.3, 8.3] 画成一条带。
 *
 *    这么做的理由是为了消掉计划书里列的风险 #14(「舆图坐标 ≠ 三维坐标」)。
 *    当初的设想是画一张好看的示意图、再声明它与三维不一致;但那是可以
 *    直接绕开的:只要图的坐标**就取自三维那套数据**,两者就不可能分家。
 *    所以本文件不读 `map.json`(那个文件也不需要存在),只读 `SPOTS`。
 *
 * 图上还会画一个**相机位置标记**,由 `cameraSnapshot()` 实时喂进来。
 * 它让这张图不只是"能点",而是能回答「我现在在哪、那五个点分别在哪个方向」。
 *
 * 坐标约定
 * --------
 * 三维是 Y-up,x 向东、z 向南(three 的右手系)。俯视图取 x→横、z→纵,
 * 并把 **z 翻转**成"上为北、下为南",与看地图的习惯一致。
 * 这个翻转只发生在本文件里,不改动任何三维数据。
 */

import { el, clear } from '../dom';

export interface MapPanelCallbacks {
  /** 点击图上的景点 → 相机飞过去。 */
  onPick: (id: string) => void;
  onClose: () => void;
}

export interface MapSpot {
  id: string;
  name: string;
  /** 看点坐标(三维世界坐标) */
  target: readonly [number, number, number];
}

export interface MapPanel {
  root: HTMLElement;
  /** 重建图上的点(景点数据变了才需要) */
  build(spots: readonly MapSpot[]): void;
  /** 每帧或按需更新相机标记。传 null 表示暂不显示。 */
  setCamera(x: number, z: number): void;
}

/** 汴河在 X 方向的半宽(米)。与 main.ts 记录的一致:河道 X −8.3…8.3。 */
const RIVER_HALF = 8.3;

export function createMapPanel(cb: MapPanelCallbacks): MapPanel {
  const NS = 'http://www.w3.org/2000/svg';
  const vb = { w: 360, h: 260 };
  const pad = 26;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${vb.w} ${vb.h}`);
  svg.setAttribute('class', 'qm-map__svg');
  svg.setAttribute('role', 'img');

  const riverLayer = document.createElementNS(NS, 'g');
  const spotLayer = document.createElementNS(NS, 'g');
  const camLayer = document.createElementNS(NS, 'g');
  svg.append(riverLayer, spotLayer, camLayer);

  const status = el('div', { class: 'qm-map__status' });

  const root = el('section', { class: 'qm-panel qm-panel--map qm-interactive' }, [
    el('header', { class: 'qm-panel__head' }, [
      el('h2', { class: 'qm-panel__title' }, ['舆图']),
      el('button', { class: 'qm-btn qm-btn--ghost', type: 'button' }, ['关闭']),
    ]),
    el('div', { class: 'qm-panel__body' }, [svg, status]),
  ]);
  root.querySelector('button')!.addEventListener('click', cb.onClose);

  // 世界坐标 → 视图坐标。比例与偏移在 build() 里按实测范围定。
  let sx = 1;
  let sy = 1;
  let ox = 0;
  let oz = 0;
  const toX = (x: number): number => pad + (x - ox) * sx;
  const toY = (z: number): number => vb.h - pad - (z - oz) * sy;

  function build(spots: readonly MapSpot[]): void {
    if (!spots.length) {
      status.textContent = '舆图没有可定位的景点。';
      return;
    }

    // —— 范围由实测坐标决定,不用手写的边界 ——
    let minX = -RIVER_HALF;
    let maxX = RIVER_HALF;
    let minZ = 0;
    let maxZ = 0;
    for (const s of spots) {
      minX = Math.min(minX, s.target[0]);
      maxX = Math.max(maxX, s.target[0]);
      minZ = Math.min(minZ, s.target[2]);
      maxZ = Math.max(maxZ, s.target[2]);
    }
    // 让横纵比例**一致**,否则图上两点之间的夹角是假的,看着像示意画。
    // 取两轴所需比例的较小者,保证两个方向都装得下。
    const spanX = Math.max(maxX - minX, 1e-3);
    const spanZ = Math.max(maxZ - minZ, 1e-3);
    const s = Math.min((vb.w - pad * 2) / spanX, (vb.h - pad * 2) / spanZ);
    sx = s;
    sy = s;
    // 居中
    ox = minX - ((vb.w - pad * 2) - spanX * s) / 2 / s;
    oz = minZ - ((vb.h - pad * 2) - spanZ * s) / 2 / s;

    // —— 河道:一条沿 z 的带。z 的上下界取图的边界,保证贯通画面 ——
    clear(riverLayer);
    const zTop = oz + (vb.h - pad * 2) / sy;
    const river = document.createElementNS(NS, 'rect');
    river.setAttribute('x', String(toX(-RIVER_HALF)));
    river.setAttribute('y', String(toY(zTop)));
    river.setAttribute('width', String((RIVER_HALF * 2) * sx));
    river.setAttribute('height', String((zTop - oz) * sy));
    river.setAttribute('class', 'qm-map__river');
    riverLayer.append(river);

    // 虹桥:横跨河道,画在 z=0 处(实测锚点 虹桥_桥面的 z 是 0)
    const bridge = spots.find((x) => x.id === 'bridge');
    if (bridge) {
      const bz = bridge.target[2];
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(toX(-RIVER_HALF - 3)));
      line.setAttribute('y1', String(toY(bz)));
      line.setAttribute('x2', String(toX(RIVER_HALF + 3)));
      line.setAttribute('y2', String(toY(bz)));
      line.setAttribute('class', 'qm-map__bridge');
      riverLayer.append(line);
    }

    // —— 景点 ——
    clear(spotLayer);
    for (const sp of spots) {
      const cx = toX(sp.target[0]);
      const cy = toY(sp.target[2]);

      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'qm-map__spot');
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', `定位到${sp.name}`);

      const hit = document.createElementNS(NS, 'circle');
      hit.setAttribute('cx', String(cx));
      hit.setAttribute('cy', String(cy));
      hit.setAttribute('r', '12'); // 命中区比可见点大,便于点中
      hit.setAttribute('class', 'qm-map__hit');

      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', String(cx));
      dot.setAttribute('cy', String(cy));
      dot.setAttribute('r', '3.5');
      dot.setAttribute('class', 'qm-map__dot');

      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', String(cx + 7));
      label.setAttribute('y', String(cy + 3.5));
      label.setAttribute('class', 'qm-map__label');
      label.textContent = sp.name;

      g.append(hit, dot, label);
      const go = (): void => cb.onPick(sp.id);
      g.addEventListener('click', go);
      g.addEventListener('keydown', (e) => {
        const k = (e as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') {
          e.preventDefault();
          go();
        }
      });
      spotLayer.append(g);
    }

    // ⚠️ 说明里必须点出**空心圈是当前机位**。图上那个圈不带标签,
    //    用户看到的是一个孤零零的圆圈;不解释的话它既不像景点(没名字),
    //    也不像图例(没有说明),只能被当成画错了的装饰。
    status.textContent =
      `按实测坐标绘制 · 河道宽 ${(RIVER_HALF * 2).toFixed(1)}m · ` +
      `图上 ${spots.length} 个定位点 · 空心圈为当前机位`;
  }

  function setCamera(x: number, z: number): void {
    clear(camLayer);
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(toX(x)));
    c.setAttribute('cy', String(toY(z)));
    c.setAttribute('r', '5');
    c.setAttribute('class', 'qm-map__cam');
    camLayer.append(c);
  }

  return { root, build, setCamera };
}
