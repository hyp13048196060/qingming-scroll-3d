import { Timer } from 'three';
import type { WebGLRenderer } from 'three';

/**
 * 单帧回调。
 * @param dt        距上一帧的秒数,已钳制到 MAX_DT
 * @param worldTime 全局唯一累加时间(秒)
 */
export type FrameFn = (dt: number, worldTime: number) => void;

/**
 * 帧时上限(秒)。
 *
 * 掉帧时若不钳制,水面相位、风场、人物步态都会一次性推进一大步,
 * 表现为"瞬移"或"抽搐"。钳到 50ms 后,卡顿只让动画变慢,不会跳变。
 */
const MAX_DT = 1 / 20;

/** 帧时环形缓冲容量。60fps 下约 10 秒,足够算稳定的 p95。 */
const RING_CAPACITY = 600;

export interface FrameStats {
  frames: number;
  /** 毫秒 */
  p50: number;
  p95: number;
  max: number;
  avgFps: number;
}

/**
 * 主循环 —— 全作品唯一的时间源。
 *
 * 硬性约定:除本文件外,任何模块都不得读 Date.now() / performance.now() /
 * timer.getElapsed()。水面、风、粒子、刚体动画一律使用本循环喂进来的
 * dt 与 worldTime。违反这条,切画质或切标签时就会出现跳变。
 */
export class Loop {
  readonly timer = new Timer();

  private readonly fns: FrameFn[] = [];
  private readonly ring = new Float32Array(RING_CAPACITY);
  private ringIdx = 0;
  private ringLen = 0;

  private worldTime = 0;
  private frames = 0;
  private running = false;

  constructor() {
    // 必须手动连接 Page Visibility。
    // 不连接的话,从后台标签页切回来的第一帧 getDelta() 会是离开的总秒数,
    // 相机与所有动画会瞬间跳过去。
    this.timer.connect(document);
  }

  /** 注册每帧回调。按注册顺序执行。 */
  add(fn: FrameFn): void {
    this.fns.push(fn);
  }

  start(renderer: WebGLRenderer): void {
    if (this.running) return;
    this.running = true;
    renderer.setAnimationLoop((timestamp) => this.tick(renderer, timestamp));
  }

  stop(renderer: WebGLRenderer): void {
    this.running = false;
    renderer.setAnimationLoop(null);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 全局累加时间(秒)。所有着色器 uniform 都应喂这个值。 */
  get time(): number {
    return this.worldTime;
  }

  get frameCount(): number {
    return this.frames;
  }

  /**
   * 上下文恢复后调用。
   * 不重置的话,恢复首帧的 dt 会是丢失期间的总时长。
   */
  resetTimer(): void {
    this.timer.reset();
  }

  /** 清空帧时统计。性能采集时先热身、丢弃热身数据,再开始正式测量。 */
  resetStats(): void {
    this.ringIdx = 0;
    this.ringLen = 0;
    this.frames = 0;
  }

  /**
   * 帧时统计(毫秒)。
   *
   * 必须看 p95 与 max,不能只看平均值 —— 平均值会把周期性卡顿抹平,
   * 而卡顿恰恰是体感最差的部分。
   */
  stats(): FrameStats {
    const n = this.ringLen;
    if (n === 0) return { frames: 0, p50: 0, p95: 0, max: 0, avgFps: 0 };

    const sorted = Array.from(this.ring.subarray(0, n)).sort((a, b) => a - b);
    const pick = (q: number): number =>
      sorted[Math.min(n - 1, Math.max(0, Math.floor(q * n)))]!;

    let sum = 0;
    for (let i = 0; i < n; i++) sum += sorted[i]!;

    return {
      frames: this.frames,
      p50: round2(pick(0.5)),
      p95: round2(pick(0.95)),
      max: round2(sorted[n - 1]!),
      avgFps: round2(1000 / (sum / n)),
    };
  }

  private tick(renderer: WebGLRenderer, timestamp: number): void {
    this.timer.update(timestamp);

    const raw = this.timer.getDelta();
    const dt = Math.min(raw, MAX_DT);
    this.worldTime += dt;
    this.frames++;

    // 帧首重置。反射/阴影/深度 pass 会持续累加计数,不重置会严重虚报。
    renderer.info.reset();

    for (let i = 0; i < this.fns.length; i++) {
      this.fns[i]!(dt, this.worldTime);
    }

    // 环形缓冲记录真实帧时(含被钳制掉的那部分),
    // 这样 p95 / max 反映的是实际体感,而不是被修饰过的数字。
    this.ring[this.ringIdx] = raw * 1000;
    this.ringIdx = (this.ringIdx + 1) % RING_CAPACITY;
    if (this.ringLen < RING_CAPACITY) this.ringLen++;
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
