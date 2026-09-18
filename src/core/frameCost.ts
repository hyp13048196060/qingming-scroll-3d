import * as THREE from 'three';
import type { Loop } from './loop';

/**
 * 直接测"画一帧要多少毫秒"。
 *
 * ## 为什么不能用 rAF 的间隔当帧时
 *
 * 实测(无头 Chrome,1920×1080,空页面、不含任何渲染逻辑):
 *   rAF 回调间隔 p50 = **30.26ms**,max = 36.44ms。
 * 而本作品在各画质档下的帧时 p50 分别是 low 24.26 / mid 26.33 / high 30.30。
 * 也就是说 **high 档的"帧时"正好等于 rAF 自己的节拍**,而且是 33Hz 的节拍。
 * 把 30.4ms 当成"作品每帧花 30 毫秒"写进报告,是把**量具的刻度上限**
 * 当成了被测物的长度 —— 这一类错误在这个项目里已经出现过多次
 * (见 memory: instrument-error-pattern)。
 *
 * 关掉 vsync(`--disable-gpu-vsync`) 也只能把地板降到 17.5ms,依然是地板。
 *
 * ## 所以换个量法
 *
 * 停掉 rAF,连着渲染 N 帧,最后 `gl.finish()` 一次性等 GPU 干完,
 * 总时间除以 N。这样拿到的是**这台机器画一帧的真实吞吐**,
 * 与合成器节拍、与显示器刷新率都无关。
 *
 * ⚠️ 它与"用户看到的帧时"不是一回事:真机上帧时会被 vsync 钳到
 *    16.7ms 的整数倍。这个数回答的是"离 60fps 的预算还差多少",
 *    正是门限表想问的问题。
 *
 * ⚠️ 本文件读 `performance.now()`,是「只有 loop.ts 可以读时钟」这条
 *    规定的**唯一例外**,理由是它量的就是时钟本身,不参与任何动画推进。
 */
export interface BurstResult {
  frames: number;
  totalMs: number;
  msPerFrame: number;
  /** 逐帧分布,用来判断是不是稳定开销还是有周期性的尖峰 */
  p50: number;
  p95: number;
  max: number;
}

/** 一步的形态:`main.ts` 里的 `frameStep` 就是它。 */
export type StepFn = (dt: number, worldTime: number, doRender: boolean) => void;

export interface FrameCost {
  /** 停 rAF → 连渲 n 帧 → gl.finish → 恢复 rAF。**不跑逻辑**。 */
  measureBurst(n: number): BurstResult;
  /**
   * 停 rAF → 连跑 n 步 `step` → 恢复 rAF。
   *
   * `doRender=false` 时一步里没有任何绘制,量到的是**纯 CPU 逻辑**
   * (相机阻尼、人物步态、风动 uniform、UI 更新)。这一路存在的理由:
   * 连渲口径量到渲染只要 4ms,而 rAF 的间隔是 24~30ms ——
   * 差的那 20ms 只有两种去处,要么是逻辑,要么是浏览器的合成/呈现。
   * 不把逻辑单独量一次,就没法分辨,只能猜。**猜出来的那个答案
   * 会被写进报告,而且看起来完全合理** —— 上一版就是这么错的。
   */
  measureStep(n: number, step: StepFn, doRender: boolean): BurstResult;
  /**
   * 逐个环节计时:把每一环单独跑 n 次,给出各自的耗时与占比。
   *
   * ⚠️ 各环是**分开**测的,不是在同一帧里串起来测的 —— 所以它回答的是
   *    "这一环自己做一遍要多久",不含环与环之间的缓存/预热耦合。
   *    用来**定位**大头足够,拿来当"各部分之和 = 总帧时"则会有偏差。
   */
  measureStages(n: number, stages: Stage[]): StageTiming[];
}

export interface Stage {
  name: string;
  fn: (dt: number, worldTime: number) => void;
  /**
   * 这一环吃哪一支时钟。默认 `'world'`。
   *
   * `'anim'` 的那几环会被「动画」开关冻结(见 `main.ts` 的 `animTime`)。
   *
   * ⚠️ **这个选择必须在调用处生效,不能让 `fn` 自己去读闭包里的时间。**
   *    原因是 `measureStages()` 会**绕过主循环**直接调 `fn(1/60, t)` 来给
   *    各环单独计时 —— 若 `fn` 读的是闭包里的动画钟,那么「动画」开关一关,
   *    这里量到的就是一个空转,「人物」那一行会打印出一个漂亮的小数字,
   *    而它量的是"没干活有多快"。逐环计时的用途正是给性能报告定位大头,
   *    被一个界面开关污染之后,报告会安静地少报一笔。
   *    挂在 `Stage` 上、由调用处择一传入,则测量路径**天然看不到闸门**:
   *    它永远拿 `1/60` 去量工作本身。
   */
  clock?: 'world' | 'anim';
}

export interface StageTiming {
  name: string;
  /** 单次耗时的中位数(ms) */
  ms: number;
  p95: number;
  /** 占各环中位数之和的比例。分母是"和",不是总帧时,见上面那条警告 */
  share: number;
}

export function createFrameCost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  loop: Loop,
): FrameCost {
  const gl = renderer.getContext();

  /** 共用的计时骨架:停 rAF → 热身 → n 次 timed → 恢复。 */
  const timedRun = (n: number, once: () => void): BurstResult => {
    const wasRunning = loop.isRunning;
    // 必须先停:rAF 还在跑的话,它的渲染会插进来,测到的是两件事的混合
    loop.stop(renderer);

    // 先空跑几帧,把驱动侧的懒分配(缓冲、状态对象)摊掉,不混进均值
    for (let i = 0; i < 4; i++) once();
    gl.finish();

    const per: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      once();
      per.push(performance.now() - t0);
    }

    if (wasRunning) loop.start(renderer);

    const sorted = per.slice().sort((a, b) => a - b);
    const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    const total = per.reduce((a, b) => a + b, 0);
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    return {
      frames: n,
      totalMs: r2(total),
      msPerFrame: r2(total / n),
      p50: r2(pick(0.5)),
      p95: r2(pick(0.95)),
      max: r2(sorted[sorted.length - 1]!),
    };
  };

  const measureBurst = (n: number): BurstResult =>
    timedRun(n, () => {
      renderer.render(scene, camera);
      // 每帧 finish:否则命令只是排进队列,量到的是"提交"不是"画完"
      gl.finish();
    });

  /**
   * 逻辑计时里的 `worldTime` 是**累加**的,与真循环一致。
   * 若每次都喂同一个 t,风动/水面的相位就钉在一点上,
   * 量到的是"某个瞬间的逻辑",不是"一帧的逻辑"。
   *
   * dt 固定 1/60:真循环里 dt 随帧变化,但 MAX_DT 已经把它钳在 1/20 以内,
   * 而逻辑里没有哪一支会因为这个差别换算法。
   */
  const measureStep = (n: number, step: StepFn, doRender: boolean): BurstResult => {
    let t = 0;
    const once = (): void => {
      t += 1 / 60;
      step(1 / 60, t, doRender);
      // 没有绘制时**不** finish:队列里没有本步提交的活儿,
      // 此时 finish 等的是上一帧残留的 GPU 工作,那是别人的时间。
      if (doRender) gl.finish();
    };
    return timedRun(n, once);
  };

  const measureStages = (n: number, stages: Stage[]): StageTiming[] => {
    const wasRunning = loop.isRunning;
    loop.stop(renderer);
    const raw = stages.map((s) => {
      let t = 0;
      // 热身:第一遍要把 JIT 还没编译的分支、懒分配的临时对象都跑出来
      for (let i = 0; i < 8; i++) { t += 1 / 60; s.fn(1 / 60, t); }
      const per: number[] = [];
      for (let i = 0; i < n; i++) {
        t += 1 / 60;
        const t0 = performance.now();
        s.fn(1 / 60, t);
        per.push(performance.now() - t0);
      }
      per.sort((a, b) => a - b);
      const pick = (q: number): number => per[Math.min(per.length - 1, Math.floor(q * per.length))]!;
      return { name: s.name, ms: pick(0.5), p95: pick(0.95) };
    });
    if (wasRunning) loop.start(renderer);
    const total = raw.reduce((a, b) => a + b.ms, 0);
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    return raw
      .map((r) => ({ name: r.name, ms: r2(r.ms), p95: r2(r.p95), share: total > 0 ? r.ms / total : 0 }))
      .sort((a, b) => b.ms - a.ms);
  };

  return { measureBurst, measureStep, measureStages };
}
