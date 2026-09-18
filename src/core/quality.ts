/**
 * 画质档位的**幂等 reconciler**。
 *
 * 「幂等」在这里是硬要求,不是形容词:同一档位连调 10 次,场景必须与
 * 调 1 次完全相同。做不到的话,用户来回切两次画质就会看到画面一次比一次
 * 暗、贴图一次比一次糊 —— 那是"调试期没发现、上线后第 20 次切换才炸"的
 * 一类问题。
 *
 * ⚠️ 允许改的只有这些(改完不重建任何 `Object3D`):
 *      · `renderer.setPixelRatio`
 *      · 太阳阴影贴图边长(`shadow.mapSize` + 丢掉旧的 `shadow.map`)
 *      · 人物 `castShadow` 的**名额分配**
 *      · 已登记子系统(反射 RT)的参数
 *      · 材质属性(线框、uniform、defines)
 *
 * ⚠️ **绝对禁止**:重建 `SkinnedMesh`、`timer.reset()`、`worldTime = 0`、
 *    相机瞬移、重新加载贴图。违反由 `tests/state_invariants.mjs` 断言拦住 ——
 *    判据是"切换前后 `scene` 遍历出的 `Object3D.uuid` 集合逐项相同"。
 *
 * 关于 `shadow.mapSize` 的一个真实陷阱
 * ------------------------------------
 * three.js 只在**阴影贴图尚未分配时**读 `mapSize`。一旦 `light.shadow.map`
 * 存在,改 `mapSize` 不会有任何效果,而且是静默的 —— 不报错、不警告,
 * 只是画质档位看起来"切了但没变"。必须先把旧的 render target 丢掉。
 * 这丢掉的是 GPU 上的贴图,不涉及任何场景对象,不违反上面的禁令。
 */

import * as THREE from 'three';
import type { Quality } from '../ui/store';

/** 反射子系统的参数。阶段 4 的 `RiverReflector` 消费它。 */
export interface ReflectorPlan {
  enabled: boolean;
  /**
   * 反射 RT 的边长。
   *
   * ⚠️ **`enabled:false` 时也必须填真实尺寸**,不能填 0。
   *    这三项描述的是"这一档的反射是什么配置",不是"这一刻用不用它" ——
   *    `enabled` 才是那个开关。填 0 会让"强制打开反射"这类覆盖拿到一个
   *    0 尺寸的 RT(实测:2×2)。契约见 `TABLE.low` 的注释。
   */
  width: number;
  height: number;
  /** 每 N 帧更新一次。1 = 每帧。同样地,关闭时也要填真实值。 */
  everyNFrames: number;
}

export interface QualityPlan {
  quality: Quality;
  pixelRatio: number;
  /** 太阳阴影贴图边长。`0` 表示整个阴影系统关闭。 */
  shadowMapSize: 0 | 2048 | 4096;
  /** 允许投影的人物名额(取离相机最近的 N 个)。`0` = 全部关阴影。 */
  characterShadows: number;
  reflector: ReflectorPlan;
  /** 粒子/飞鸟的密度倍率。阶段 4 的粒子系统消费它。 */
  effectsRatio: number;
}

/** 已登记的、吃画质档位的子系统。阶段 4 的反射会实现它。 */
export interface QualityAware {
  applyQuality(plan: QualityPlan): void;
}

export interface QualityReport {
  quality: Quality;
  pixelRatio: number;
  drawingBuffer: [number, number];
  shadowEnabled: boolean;
  shadowMapSize: number;
  /** 实际打开了 castShadow 的蒙皮网格数量 */
  charactersCastingShadow: number;
  /** 场景里蒙皮网格总数 —— 与上一项一起看才知道名额有没有用满 */
  skinnedMeshCount: number;
  wireframe: boolean;
  wireframeMaterials: number;
  /** 已登记的反射子系统数量 */
  reflectors: number;
}

/**
 * 三档的参数表。
 *
 * ⚠️ **与计划书表格有一处刻意偏离**:计划书里 high 档写的是
 *    「`min(dpr,2)`,dpr>2.5 取 1.5」。那条规则在 dpr=3 的屏幕上会让
 *    high 得到 1.5,而 mid 档本来就是 `min(dpr,1.5)=1.5` —— **两档完全一样**。
 *    用户点「精细」发现画面毫无变化,只会认为这个按钮是坏的。
 *    而且 dpr 从 2.5 到 2.6 时倍率会从 2.0 掉到 1.5,不单调。
 *    所以这里改成单调的 `min(dpr, 2)`:高 DPI 屏上 high 仍然是像素最多的那档,
 *    "精细"这个名字与实际行为一致。这一偏离记在 docs/05。
 */
const TABLE: Record<Quality, Omit<QualityPlan, 'quality' | 'pixelRatio'>> = {
  low: {
    shadowMapSize: 0,
    characterShadows: 0,
    // ⚠️ `enabled:false` 那一档,尺寸与帧距**也必须填真实值**,不能填 0。
    //
    //    填 0 的写法把"这一档用不上"编码成了"尺寸是 0",而下游会照它
    //    做算术 —— `?q=low&reflect=1`(强制打开反射)于是得到
    //    `max(2, 0) = 2`,也就是一张 **2×2** 的反射贴图:水面上是一块
    //    4 像素的糊斑,还每帧都在画,不报任何错。这是实测到的
    //    (693 次 pass、RT 2×2),不是推演。
    //
    //    这里填的是 mid 档的值 —— "低档若非要开反射,该花多少"的答案是
    //    **我们已经量过、确认能看的那一档**,而不是第三个没测过的配置。
    reflector: { enabled: false, width: 512, height: 256, everyNFrames: 3 },
    effectsRatio: 0,
  },
  mid: {
    shadowMapSize: 2048,
    characterShadows: 8,
    reflector: { enabled: true, width: 512, height: 256, everyNFrames: 3 },
    effectsRatio: 0.5,
  },
  high: {
    shadowMapSize: 4096,
    characterShadows: 16,
    reflector: { enabled: true, width: 1024, height: 512, everyNFrames: 1 },
    effectsRatio: 1,
  },
};

function pixelRatioFor(q: Quality, dpr: number): number {
  if (q === 'low') return 1;
  if (q === 'mid') return Math.min(dpr, 1.5);
  return Math.min(dpr, 2);
}

export interface QualityDeps {
  renderer: THREE.WebGLRenderer;
  /** 场景根。遍历它找蒙皮网格与材质。 */
  scene: THREE.Object3D;
  /** 太阳。阴影贴图边长归本文件管 —— 见文件头的陷阱说明。 */
  sun: THREE.DirectionalLight;
  camera: THREE.PerspectiveCamera;
}

export interface QualityReconciler {
  apply(q: Quality): void;
  get current(): Quality;
  /** 线框开关。只改材质属性,**不新建材质** —— 否则每切一次就多一批。 */
  setWireframe(on: boolean): void;
  register(subsystem: QualityAware): void;
  report(): QualityReport;
}

export function createQuality(deps: QualityDeps): QualityReconciler {
  const { renderer, scene, sun, camera } = deps;

  let quality: Quality = 'mid';
  let wireframe = false;
  const subsystems: QualityAware[] = [];

  /**
   * 找场景里全部蒙皮网格。
   *
   * ⚠️ **每次现遍历,不做缓存。**
   *    这里曾经缓存过一次,理由是"切画质很频繁,遍历浪费"。那个理由是错的,
   *    而且错得很隐蔽:`apply()` 在启动时就跑了一次,那时 GLB 还没加载完,
   *    遍历结果是个**空数组**,于是缓存下来的是一个空表,并且再也不会更新 ——
   *    症状是"人物阴影这个功能从来就没生效过",而没有任何报错。
   *    切画质是用户手动动作,一次遍历两百来个对象,代价可以忽略。
   *    凡是"缓存一个此刻还不存在的东西",都要先问它什么时候会被填上。
   */
  function collectSkinned(): THREE.SkinnedMesh[] {
    const out: THREE.SkinnedMesh[] = [];
    scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) out.push(m);
    });
    return out;
  }

  function applyShadowSize(size: 0 | 2048 | 4096): void {
    if (size === 0) {
      renderer.shadowMap.enabled = false;
      sun.castShadow = false;
      return;
    }
    // 从"关"切回"开"时,阴影贴图是旧的甚至没被画过 —— 必须让它重画一帧,
    // 否则会有一帧没有任何影子(而且只在 low→mid 这条路径上出现)。
    const wasOff = !renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = true;
    sun.castShadow = true;

    if (sun.shadow.mapSize.width !== size) {
      // ⚠️ 必须先丢掉旧的贴图,否则改 mapSize 完全无效(见文件头)
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
      sun.shadow.mapSize.set(size, size);
    }
    if (wasOff) renderer.shadowMap.needsUpdate = true;
  }

  /**
   * 按"离相机最近"分配投影名额。
   *
   * ⚠️ 排序只在**切换画质时**做一次,不逐帧重算。
   *    逐帧重算会让走着的人物在跨过第 N 名时突然出现/丢掉影子 ——
   *    那种一跳一跳的阴影比"远处几个人没影子"显眼得多。
   */
  function applyCharacterShadows(budget: number): void {
    const meshes = collectSkinned();
    if (budget <= 0) {
      for (const m of meshes) m.castShadow = false;
      return;
    }
    if (meshes.length <= budget) {
      for (const m of meshes) m.castShadow = true;
      return;
    }
    const camPos = camera.position;
    // 用一个临时数组存 {mesh, d²},避免给每个网格建 Vector3
    const ranked = meshes.map((m) => {
      const p = new THREE.Vector3();
      m.getWorldPosition(p);
      return { m, d: p.distanceToSquared(camPos) };
    });
    ranked.sort((a, b) => a.d - b.d);
    for (let i = 0; i < ranked.length; i++) ranked[i]!.m.castShadow = i < budget;
  }

  /**
   * 遍历场景里所有材质,按 uuid 去重后交给 `visit`。返回材质总数。
   *
   * 材质常被多个网格共享,不去重的话同一个材质会被处理 N 次 ——
   * 报出来的"影响了多少材质"会虚高,而那个数字是要写进报告的。
   */
  function eachMaterial(visit: (m: THREE.Material) => void): number {
    const seen = new Set<string>();
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material;
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        if (!m || seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        visit(m);
      }
    });
    return seen.size;
  }

  function applyWireframeToMaterials(on: boolean): number {
    // 只改属性,不新建、不替换 —— 否则每切一次线框就多一批材质,显存只增不减
    return eachMaterial((m) => {
      (m as THREE.Material & { wireframe: boolean }).wireframe = on;
    });
  }

  function planFor(q: Quality): QualityPlan {
    return {
      ...TABLE[q],
      quality: q,
      pixelRatio: pixelRatioFor(q, window.devicePixelRatio),
    };
  }

  function apply(q: Quality): void {
    const plan = planFor(q);
    quality = q;

    // setPixelRatio 内部会带 updateStyle=false 重新 setSize,
    // 所以 CSS 尺寸不受影响(画布仍是 100%)。
    renderer.setPixelRatio(plan.pixelRatio);

    applyShadowSize(plan.shadowMapSize);
    // 关阴影时名额没有意义,统一按 0 处理,免得报告里出现
    // "阴影已关但还有 16 个人在投影"这种自相矛盾的行
    applyCharacterShadows(plan.shadowMapSize === 0 ? 0 : plan.characterShadows);

    // 线框是独立开关,不随档位变 —— 但重画一次保证与材质状态一致
    applyWireframeToMaterials(wireframe);

    for (const s of subsystems) s.applyQuality(plan);
  }

  return {
    apply,
    get current() {
      return quality;
    },
    setWireframe(on: boolean): void {
      wireframe = on;
      applyWireframeToMaterials(on);
    },
    register(subsystem: QualityAware): void {
      subsystems.push(subsystem);
      // 立刻按当前档位初始化一次,免得新接入的子系统要等到下次切换
      // 才拿到参数 —— 那种"接入后第一次切画质才生效"的问题很难查。
      subsystem.applyQuality(planFor(quality));
    },
    report(): QualityReport {
      const meshes = collectSkinned();
      const gl = renderer.getContext();
      return {
        quality,
        pixelRatio: renderer.getPixelRatio(),
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        shadowEnabled: renderer.shadowMap.enabled,
        shadowMapSize: sun.castShadow ? sun.shadow.mapSize.width : 0,
        charactersCastingShadow: meshes.filter((m) => m.castShadow).length,
        skinnedMeshCount: meshes.length,
        wireframe,
        // ⚠️ 这里**只数不改**。早先的写法是调一次 applyWireframeToMaterials(true),
        //    那让 `report()` 变成了一个会改世界的"读"操作 —— 一个本该纯读取的
        //    诊断接口把场景改回线框,而调用它的人完全看不出来。
        wireframeMaterials: wireframe ? eachMaterial(() => {}) : 0,
        reflectors: subsystems.length,
      };
    },
  };
}
