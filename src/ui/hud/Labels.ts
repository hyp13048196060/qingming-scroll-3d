/**
 * 三维空间标签 —— 功能组 ③ 的入口。
 *
 * 做成 DOM 元素再由相机投影定位,而不是场景里的 Sprite:
 *   · 文字在任何缩放下都保持清晰(精灵要跟着缩放,或忍受贴图模糊);
 *   · 可以被键盘 Tab 到、被屏幕阅读器读到,精灵不能;
 *   · 样式直接吃 CSS,不必为标签单独做一套材质与图集。
 *
 * ⚠️ 锚点**不手写**。每个标签的悬挂位置由 `spots.json` 里那个物体
 *    **实测包围盒的顶面中心**决定:
 *
 *        标签位置 = ((x0+x1)/2,  y1 + 抬高量,  (z0+z1)/2)
 *
 *    这样物体一动(哪怕只是重跑一次构建),标签跟着动;要是手写一份坐标,
 *    改了模型却忘了改标签,症状是"标签飘在半空",而看不出是谁错了。
 *
 * ⚠️ 本文件**不做遮挡判断**。标签会浮在挡在它前面的建筑之上。
 *    做遮挡需要对每个标签每帧打一次射线,5 个标签 × 200 多个物体,
 *    开销与收益不成比例。这是已知取舍,写在 docs/08。
 */

import * as THREE from 'three';
import { el } from '../dom';

export interface LabelSpot {
  id: string;
  name: string;
  /** [x0, y0, z0, x1, y1, z1](three 坐标系) */
  bboxThree: number[];
}

export interface LabelsCallbacks {
  onPick: (id: string) => void;
}

export interface Labels {
  root: HTMLElement;
  /** 每帧调用:把三维锚点投影到屏幕上。 */
  update(camera: THREE.Camera, width: number, height: number): void;
  setVisible(on: boolean): void;
}

/** 标签相对物体顶面再抬高多少米,免得贴着屋檐。 */
const RAISE = 1.2;

/** 超过这个距离(米)标签淡出,避免远景一堆叠在一起的小字。 */
const FADE_NEAR = 30;
const FADE_FAR = 190;

export function createLabels(spots: readonly LabelSpot[], cb: LabelsCallbacks): Labels {
  const root = el('div', { class: 'qm-labels' });

  const items = spots
    .filter((s) => {
      // 宁可少一个标签,也不要摆一个位置错误的标签。
      if (!s.bboxThree || s.bboxThree.length !== 6) {
        console.warn(`[labels] 景点「${s.id}」没有可用的包围盒,跳过它的标签。`);
        return false;
      }
      return true;
    })
    .map((spot) => {
      const b = spot.bboxThree;
      const anchor = new THREE.Vector3(
        (b[0]! + b[3]!) / 2,
        b[4]! + RAISE,
        (b[2]! + b[5]!) / 2,
      );
      const node = el(
        'button',
        { type: 'button', class: 'qm-label qm-interactive', 'data-spot': spot.id },
        [spot.name],
      ) as HTMLButtonElement;
      node.addEventListener('click', () => cb.onPick(spot.id));
      root.append(node);
      return { spot, node, anchor };
    });

  // 复用同一个向量,避免每帧为每个标签各新建一个(GC 压力)
  const projected = new THREE.Vector3();

  return {
    root,

    update(camera: THREE.Camera, width: number, height: number): void {
      if (root.hidden) return;

      for (const it of items) {
        projected.copy(it.anchor).project(camera);

        // project() 的结果是 NDC:z > 1 表示在相机**背后**或远裁剪面之外。
        // 不判这一条的话,背后的标签会被镜像地画到屏幕上,看着像标签
        // 到处乱飞 —— 而这种错很难从画面上猜到原因。
        const behind = projected.z > 1 || projected.z < -1;
        if (behind) {
          it.node.hidden = true;
          continue;
        }

        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;

        // 出画面就藏起来,免得贴着边缘显示半截
        if (x < -80 || x > width + 80 || y < -40 || y > height + 40) {
          it.node.hidden = true;
          continue;
        }

        const dist = camera.position.distanceTo(it.anchor);
        const t = (dist - FADE_NEAR) / (FADE_FAR - FADE_NEAR);
        // 近处不透明、远处淡出;下限 0.25 保证远处的标签仍能看清并点到
        it.node.style.opacity = String(Math.max(0.25, Math.min(1, 1 - t)));
        it.node.hidden = false;
        // translate(-50%,-50%) 在 CSS 里,这里只给左上角坐标
        it.node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      }
    },

    setVisible(on: boolean): void {
      root.hidden = !on;
    },
  };
}
