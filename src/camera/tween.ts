/**
 * 相机补间(缓动)。
 *
 * 为什么自己写而不用 GSAP
 * ----------------------
 * GSAP 是"专有但免费"(not OSI-approved),授权可由一方单方终止。本项目
 * 要求依赖全部免费且可本地运行,所以缓动这二十行自己写。顺带还有个好处:
 * 缓动曲线的数学性质由我们自己保证,而"无弹跳"这个验收条件**是可以从
 * 导数推出来的**,不必靠眼睛看。
 *
 * 「无弹跳」在这里是一个可证的性质,不是感觉
 * ------------------------------------------
 * 阶段 3 的验收写的是:
 *     tween 结束位置误差 <0.05m;**末 0.3s 位移方差 <1e-4(无弹跳)**
 *
 * 弹跳的成因是缓动函数**过冲**:t 走到 1 时值已经超过 1,再退回来。
 * 常见的 `easeOutBack` / 弹性曲线就是这样。只要满足两条,就不可能弹跳:
 *     ① f(0)=0,f(1)=1,f(t) 单调不减     → 不会越过终点
 *     ② f'(1)=0                          → 到达时速度为零,不会冲过头再回
 *
 * 但光满足这两条还不够 —— 验收量的是**末 0.3s 的位移方差**。方差要小,
 * 意味着最后那 0.3s 里每帧的位移都必须很小。`easeInOutCubic` 满足 ①②,
 * 可是它在 t=0.83 处还剩 (1-0.833)³/2 ≈ 1.9% 的行程 —— 一次 33m 的
 * 切换就是最后 0.3s 还要走 0.61m,方差明显超 1e-4。
 * (这不是"曲线选得不好",是**验收量选得比曲线的性质更严**。)
 *
 * 所以这里用的曲线是**导数带长尾**的:
 *
 *     f(t) = 1 − (1−t)⁴(1 + 4t)
 *     f'(t) = 20·t·(1−t)³
 *
 * 逐条核过:
 *     f(0) = 1 − 1·1 = 0                              ✓
 *     f(1) = 1 − 0·5 = 1                              ✓
 *     f'(t) = 20t(1−t)³ ≥ 0 在 [0,1] 上             → 单调不减 ✓
 *     f'(1) = 0                                      → 末端速度为零 ✓
 *     f'(t)=0 的解:t=0 与 t=1                        → 起步也慢,不会"一下窜出去"
 *     f' 的峰在 t=0.25(20(1−t)²(1−4t)=0)          → 前 1/4 加速,后 3/4 减速
 *
 * 尾部的量级:(1−0.833)⁴(1+4×0.833) = 7.7e−4 × 4.33 ≈ 3.3e−3,即最后 0.3s
 * 只剩**千分之三**的行程。33m 的切换对应 0.11m,分到约 19 帧上,单帧位移
 * 约 5.8mm —— 方差落在 1e−5 量级,比阈值低一个数量级。
 *
 * ⚠️ 上面的数是**推导**出来的。测试会实测并打印真实值 —— 推导只用来选
 *    曲线,不用来当结论。
 */

/**
 * 相机缓动曲线。单调、不过冲、末端速度为零,且尾部衰减极快。
 * 值域与定义域都是 [0,1]。t 会被钳制。
 */
export function easeCamera(t: number): number {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const r = 1 - u;
  return 1 - r * r * r * r * (1 + 4 * u);
}

/** 上述曲线的导数。给测试用:可以直接断言 f'(1)=0 与 f'≥0。 */
export function easeCameraDerivative(t: number): number {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return 20 * u * (1 - u) ** 3;
}

/**
 * 切换时长:按位移距离定,带上下限。
 *
 * 定长的时长在短距离上会"磨蹭"、在长距离上会"甩出去"。按距离开方缩放
 * 比线性缩放在两端都更稳:36m 的切换 1.8s,9m 的切换 1.35s。
 */
export const TWEEN_MIN_SEC = 0.9;
export const TWEEN_MAX_SEC = 1.8;
/** 参考距离:走这么远正好用满 TWEEN_MAX_SEC。 */
const TWEEN_REF_DIST = 36;

export function tweenDuration(distance: number): number {
  const k = Math.sqrt(Math.max(distance, 0) / TWEEN_REF_DIST);
  return Math.min(TWEEN_MAX_SEC, Math.max(TWEEN_MIN_SEC, TWEEN_MAX_SEC * k));
}

/** 一次补间的输入与状态。位置与目标点**同步插值**。 */
export interface TweenSample {
  position: [number, number, number];
  target: [number, number, number];
}

export class CameraTween {
  private elapsed = 0;
  private readonly duration: number;
  private readonly from: TweenSample;
  private readonly to: TweenSample;
  private readonly dist: number;
  private finished = false;

  constructor(from: TweenSample, to: TweenSample) {
    this.from = { position: [...from.position], target: [...from.target] };
    this.to = { position: [...to.position], target: [...to.target] };
    this.dist = Math.hypot(
      to.position[0] - from.position[0],
      to.position[1] - from.position[1],
      to.position[2] - from.position[2],
    );
    this.duration = tweenDuration(this.dist);
  }

  get totalDistance(): number {
    return this.dist;
  }

  get totalSeconds(): number {
    return this.duration;
  }

  /** 归一化进度 [0,1]。 */
  get progress(): number {
    return this.duration <= 0 ? 1 : Math.min(1, this.elapsed / this.duration);
  }

  get done(): boolean {
    return this.finished;
  }

  /** 推进 dt 秒,返回当前应处的位姿。 */
  update(dt: number): TweenSample {
    this.elapsed += dt;
    const raw = this.progress;
    if (raw >= 1) this.finished = true;

    // ⚠️ 插值的自变量是**缓动后的 k**,位置与目标点用同一个 k ——
    //    两边各用一条曲线,或者一边缓动一边不缓动,都会让视线在
    //    中途偏摆一下,看上去像机身在扭。
    const k = easeCamera(raw);

    // 到点后直接给**精确**的终点值,不留浮点余量。
    // 验收要求"结束位置误差 <0.05m",给精确值最省事,也免得多一帧的差。
    if (this.finished) return { position: [...this.to.position], target: [...this.to.target] };

    return {
      position: [
        this.from.position[0] + (this.to.position[0] - this.from.position[0]) * k,
        this.from.position[1] + (this.to.position[1] - this.from.position[1]) * k,
        this.from.position[2] + (this.to.position[2] - this.from.position[2]) * k,
      ],
      target: [
        this.from.target[0] + (this.to.target[0] - this.from.target[0]) * k,
        this.from.target[1] + (this.to.target[1] - this.from.target[1]) * k,
        this.from.target[2] + (this.to.target[2] - this.from.target[2]) * k,
      ],
    };
  }
}
