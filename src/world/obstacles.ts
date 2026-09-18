import * as THREE from 'three';

/**
 * 场景里"走不进去的地方"与"脚下的地面高度"。
 *
 * 阶段 4 要给 48 个人加走路。走路需要两件事:
 *   1. **别穿墙** —— 走到店铺里去了;
 *   2. **脚踩在地上** —— 虹桥是拱形的,沿桥面走 5 米,桥面高度会变半米;
 *      用出生点的高度一路走到底,人会浮在半空或者陷进桥面。
 * 这两件事都要一份"场景的通行信息",所以单独一个模块,相机将来也能用同一份。
 *
 * ## 为什么不用全场景 raycast
 *
 * 计划书明令禁止全场景 raycast。原因是它**又慢又难查**:一次
 * `raycaster.intersectObjects(scene.children, true)` 会打到地形、打到水面、
 * 打到自身,拿到一堆命中再挑;而"为什么这个人卡住了"几乎无法从命中列表里读出来。
 *
 * 所以这里分成两套**各司其职**的数据:
 *   · 挡路 = 从少数几类**大体积**对象上取到的 AABB 列表,XZ 平面的点测试;
 *   · 地面 = 只在**地形与桥**这 8 个网格上打向下的射线,而且**走路的人
 *     每移动 0.3 米才采一次**(见 CharacterPool 的采样缓存)。
 *
 * ## 挡路为什么只看 building / gate
 *
 * 这两个 kind 是 Blender 侧排人物时**自己用的同一套排除条件** ——
 * `actors.json` 的 `reject_reasons` 里写着"撞到 building(mid_roof_w)"、
 * "撞到 building(shop_w1_1_roof)"。沿用同一套,两侧对"哪里站得住人"的
 * 判断才是同一个口径;换一套就会出现在 Blender 里合法、在网页里一出生
 * 就卡在墙角的情况。
 *
 * ⚠️ 树**不算**障碍:柳树的包围盒把树冠也算进去,横跨十几米,按它挡路
 *    会得到"整条街都走不进去"。人本来就是从柳荫下走过的。
 */
export interface Obstacles {
  /** 这个位置能不能站人(已含 `radius` 的外扩)。 */
  blocked(x: number, z: number, radius: number): boolean;
  /**
   * 脚下的地面高度。打不到任何东西(比如走出地形边界)返回 `null` ——
   * 调用方**必须**处理这个 null,不能拿一个 0 顶上:
   * 河面上打不到东西时给 0,人就会"站在水面上"。
   */
  groundAt(x: number, z: number): number | null;
  readonly boxCount: number;
  readonly groundTargets: number;
}

/** 挡路的 kind。**只有这两个** —— 理由见文件头。 */
const BLOCKING_KINDS = new Set(['building', 'gate']);

/** 取地面高度的 kind。地形与桥:人只可能站在这两样上面。 */
const GROUND_KINDS = new Set(['terrain', 'bridge']);

const kindOf = (o: THREE.Object3D): string =>
  String((o.userData as { qm_kind?: string }).qm_kind ?? '');

/**
 * 俯视包围盒:整个盒子的 XZ 范围,以及顶面高度(给射线起点用)。
 * 取的是**世界**盒,所以对象是旋转过的也算得对。
 */
interface Footprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  maxY: number;
}

export function createObstacles(scene: THREE.Scene): Obstacles {
  const footprints: Footprint[] = [];
  const groundMeshes: THREE.Mesh[] = [];

  const box = new THREE.Box3();
  scene.traverse((o) => {
    const kind = kindOf(o);
    if (!kind) return;
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;

    if (GROUND_KINDS.has(kind)) {
      groundMeshes.push(m);
      return;
    }

    if (BLOCKING_KINDS.has(kind)) {
      box.setFromObject(m);
      // 空盒(几何没有顶点)跳过:`Box3.setFromObject` 对空几何给出
      // ±Infinity,而 `x > -Infinity && x < +Infinity` 恒真 ——
      // 一个空盒会变成一块**挡住整个场地**的隐形墙,且什么都不报。
      if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;
      footprints.push({
        minX: box.min.x,
        maxX: box.max.x,
        minZ: box.min.z,
        maxZ: box.max.z,
        maxY: box.max.y,
      });
    }
  });

  // 地面射线的起点要高于场地上的一切。取所有挡路体量的最高点再加一点余量;
  // 没有挡路体量时给一个够用的常数(虹桥拱顶约 5m,城墙 12.5m)。
  let topY = 16;
  for (const f of footprints) if (f.maxY + 4 > topY) topY = f.maxY + 4;

  // ⚠️ 这里**没有** `firstHitOnly`。那是 three-mesh-bvh 的扩展,不是 three
  //    自带的能力(我照着印象写过一次,被 tsc 当场拦下)。
  //    没有 BVH 意味着 `intersectObjects` 会把地面网格的**每个三角形**都测一遍
  //    再排序 —— 所以这个方法**不能每帧每人调一次**(见 CharacterPool 里
  //    那个 0.3 米的采样节流)。实测量到的开销记在 docs/05。
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);

  return {
    blocked(x, z, radius) {
      for (let i = 0; i < footprints.length; i++) {
        const f = footprints[i]!;
        if (
          x > f.minX - radius &&
          x < f.maxX + radius &&
          z > f.minZ - radius &&
          z < f.maxZ + radius
        ) {
          return true;
        }
      }
      return false;
    },

    groundAt(x, z) {
      raycaster.set(new THREE.Vector3(x, topY, z), down);
      const hits = raycaster.intersectObjects(groundMeshes, false);
      return hits.length ? hits[0]!.point.y : null;
    },

    get boxCount() {
      return footprints.length;
    },
    get groundTargets() {
      return groundMeshes.length;
    },
  };
}
