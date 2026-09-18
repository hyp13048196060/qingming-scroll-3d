import * as THREE from 'three';

/**
 * 把一帧的 `renderer.info` 拆成 **主 pass / 阴影 pass / 反射 pass** 三份。
 *
 * ## 为什么非拆不可
 *
 * `renderer.info` 的计数是**累加**的:帧首 `reset()` 之后,
 * 阴影 pass、反射 pass、主 pass 全往上加。于是"这一帧 290 个 drawcall"
 * 到底是谁花的,从这一个数里看不出来。阶段 4 的性能门限写着
 * "主 pass drawcall ≤220",而"主 pass"这个数**当时根本不存在** ——
 * 拿累计值当主 pass 去比 220,要么虚报超标,要么为了压这个虚高的数
 * 去砍本来就正常的几何,两条路都是被量具带着走。
 *
 * ## 怎么拆
 *
 * 把两个 pass 各自**夹住**:
 *   - 阴影:`renderer.shadowMap.render` 是整个阴影 pass 的唯一入口,
 *     把它的调用前后各读一次 `info.render` 就是阴影的增量;
 *   - 反射:`RiverReflector` 的 `onBeforeRender` 里会渲染一遍场景到 RT。
 *
 * 主 pass = 总 − 阴影 − 反射。三个数相加必然等于总量,不会漏。
 *
 * ## 一个容易漏掉的实情
 *
 * 反射 pass 内部那次 `renderer.render()` **自己也会再跑一遍阴影**。
 * 也就是说水面开着反射时,阴影的活儿是**干两遍**的。
 * 这不是笔误,是 three 的默认行为(`shadow.autoUpdate` 默认 true)。
 * 所以这里额外记 `shadowRenders` —— 它若等于 2,报告里就该写
 * "阴影 pass 每帧执行两次",而不是把两次的量悄悄算进一个数里。
 */
export interface PassCounts {
  calls: number;
  triangles: number;
}

export interface PassStatsReport {
  /** 一帧的总量(等于 info.render 该帧的累加值)。 */
  total: PassCounts;
  shadow: PassCounts;
  reflection: PassCounts;
  /** 主 pass = 总 − 阴影 − 反射。 */
  main: PassCounts;
  /** 阴影 pass 在一帧里被**调用**了几次。>1 说明反射内部又跑了一遍。 */
  shadowRenders: number;
  reflectionRenders: number;
  /** 纹理与几何体的常驻计数(不随帧变化,但报告要)。 */
  memory: { textures: number; geometries: number };
  /** 已编译的 shader program 数。 */
  programs: number;
}

export interface PassStats {
  /** 每帧开头调,紧跟 `renderer.info.reset()` 之后。 */
  frameStart(): void;
  /** 反射 pass 开始渲染。可重入安全(前几次进入只算一次)。 */
  beginReflection(): void;
  /** 反射 pass 结束。 */
  endReflection(): void;
  read(): PassStatsReport;
}

const zero = (): PassCounts => ({ calls: 0, triangles: 0 });

/**
 * 反射 pass 的夹子要装在 `RiverReflector` 里(那儿是唯一知道
 * "反射正要渲染"的地方),而那个模块不该反过来依赖渲染器。
 * 于是留一对自由函数:没装探针时是空操作,装了才计数。
 */
let active: PassStats | null = null;

/** 反射 pass 开始。未安装探针时为空操作。 */
export function beginReflectionPass(): void {
  active?.beginReflection();
}

/** 反射 pass 结束。未安装探针时为空操作。 */
export function endReflectionPass(): void {
  active?.endReflection();
}

export function installPassStats(renderer: THREE.WebGLRenderer): PassStats {
  let shadow = zero();
  let reflection = zero();
  let shadowRenders = 0;
  let reflectionRenders = 0;
  let reflDepth = 0;
  let reflSnapshot: PassCounts | null = null;

  const snap = (): PassCounts => ({
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  });

  // —— 阴影 pass ——
  // r18x 的 WebGLShadowMap.render(shadowsArray, scene, camera) 是唯一入口。
  // 直接换掉实例上的方法,比继承 renderer 轻,也不会碰到 three 内部。
  const sm = renderer.shadowMap as unknown as { render: (...a: unknown[]) => void };
  const origShadowRender = sm.render.bind(sm);
  sm.render = (...args: unknown[]): void => {
    const before = snap();
    origShadowRender(...args);
    const after = snap();
    shadow.calls += after.calls - before.calls;
    shadow.triangles += after.triangles - before.triangles;
    shadowRenders++;
  };

  const frameStart = (): void => {
    shadow = zero();
    reflection = zero();
    shadowRenders = 0;
    reflectionRenders = 0;
    reflDepth = 0;
    reflSnapshot = null;
  };

  const beginReflection = (): void => {
    reflDepth++;
    if (reflDepth === 1) {
      reflSnapshot = snap();
      reflectionRenders++;
    }
  };

  const endReflection = (): void => {
    reflDepth--;
    if (reflDepth === 0 && reflSnapshot) {
      const after = snap();
      reflection.calls += after.calls - reflSnapshot.calls;
      reflection.triangles += after.triangles - reflSnapshot.triangles;
      reflSnapshot = null;
    }
  };

  const read = (): PassStatsReport => {
    const total = snap();
    return {
      total,
      shadow: { ...shadow },
      reflection: { ...reflection },
      main: {
        calls: total.calls - shadow.calls - reflection.calls,
        triangles: total.triangles - shadow.triangles - reflection.triangles,
      },
      shadowRenders,
      reflectionRenders,
      memory: {
        textures: renderer.info.memory.textures,
        geometries: renderer.info.memory.geometries,
      },
      programs: renderer.info.programs?.length ?? 0,
    };
  };

  const stats: PassStats = { frameStart, beginReflection, endReflection, read };
  active = stats;
  return stats;
}
