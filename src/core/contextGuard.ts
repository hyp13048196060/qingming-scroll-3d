/**
 * 图形上下文丢失的守卫。
 *
 * 存在的理由:WebGL 上下文会被**外部原因**拿掉 —— 显卡驱动重置、系统休眠唤醒、
 * 移动端切后台、GPU 进程崩溃、用户在浏览器里手动丢弃。丢掉之后画面会
 * **永久停在最后一帧**,而页面上不报任何错、控制台干干净净。用户看到的是
 * "卡住了",我们能看到的什么都没有。所以要在**丢失与恢复这两个时刻**做三件事:
 *
 *   1. 丢掉时把主循环停下来。不停的话每帧都在往一个死上下文上提交,
 *      rAF 空转、帧时统计被灌进一堆假数据。
 *   2. 恢复时把**只有我们能重建的东西**重建出来(见 RebuildHook)。
 *   3. 全程把状态写进 store,让遮罩能说话、让测试有东西可断言。
 *
 * ── 三条 r186 的事实,都是读源码核过的,不是推测 ──
 *
 * ① `preventDefault()` 是**恢复事件的前提**。上下文丢失事件的默认行为是
 *    "不再尝试恢复";不阻止它,`webglcontextrestored` 永远不会来。
 *    ⚠️ three 自己已经调了(`WebGLRenderer.js` 的 `onContextLost`),而且它的
 *    监听器在渲染器构造时就注册了 —— 也就是**永远先于**本模块执行。
 *    这里仍然自己调一次:它幂等,而"恢复能工作"这件事不该依赖
 *    three 的内部实现不被改动。
 *
 * ② three 会自己重建大部分 GPU 侧资源。恢复时它的 `onContextRestore` 会调
 *    `initGLContext()`,把 `properties`(逐对象的 GPU 状态映射)、`textures`、
 *    `geometries`、`state` 全部换成新的 —— 于是几何、贴图、材质
 *    在下一帧渲染时**按 CPU 侧那份数据重新上传**。它还很仔细地保住了
 *    `info.autoReset` 与 `shadowMap.enabled/autoUpdate/needsUpdate/type`,
 *    因为这几项会被 `initGLContext()` 重置。
 *
 * ③ three **不重建**渲染目标的**内容**。RT 的 GPU 侧帧缓冲会随
 *    `properties` 一起丢掉,而它不会自己再画一遍。更要命的是
 *    `WebGLTextures.setTexture2D` 里有一条:
 *
 *        if ( texture.isRenderTargetTexture === false && ... ) { 上传 }
 *        state.bindTexture( ..., textureProperties.__webglTexture, ... );
 *
 *    渲染目标贴图**走不进上传分支**,直接 bind 那个(已经是 undefined 的)
 *    句柄,而 `WebGLState.bindTexture` 会回退到一张空贴图。
 *    结果就是:环境贴图变成全黑、**不报错、不警告**。
 *    这正是 RebuildHook 存在的理由 —— 见 `SkyTime.invalidateEnvironment`。
 *
 *    ⚠️ 上面这段是**读源码读出来的**,所以另做了一次 A/B 把它量出来
 *    (`tools/perf/once/env_stale_ab.mjs`:从页面里把环境钩子换成空函数,
 *     再走一遍丢失→恢复):
 *
 *        环境钩子正常  → 恢复后 / 丢失前 亮度比 = 1.0000,stdDev 64.73
 *        环境钩子被摘  → 恢复后 / 丢失前 亮度比 = 0.8107,stdDev 81.62
 *
 *    **暗 19%**,而且画面只是"变暗了、对比变强了",控制台一个字都没有。
 *    读源码得出的结论必须自己验一遍 —— 这是本项目反复栽跟头的地方,
 *    这次验完是对的,数据也就留在这里而不是"读代码推测的"。
 *
 * ── 为什么绝不 dispose 任何东西 ──
 *
 * 丢失路径上调用 `geometry/material/texture/renderTarget.dispose()` 是
 * 看得见的错,而且**不是**计划书里写的那个理由。
 * 计划书的风险表 #12 写的是"r186 的 `dispose()` 会释放 CPU 端数据" ——
 * 这句是**错的**,读源码核过:`BufferGeometry.dispose()`、`Material.dispose()`、
 * `Texture.dispose()`、甚至 `Object3D.dispose()` 都只做一件事
 * (`dispatchEvent({type:'dispose'})`),真正的删除发生在 WebGL 侧的监听器里,
 * 删的是 GL 对象,**不碰 CPU 侧那份数组/图像**。
 *
 * 真正的理由是另一件事,而且更硬:本作品**没有任何重新创建场景内容的路径**
 * (几何与贴图全部来自 GLB,构建期就定死了)。恢复之所以能工作,靠的
 * 恰恰是"CPU 侧那份数据还在,three 重新上传一遍"。一旦在丢失时把它们
 * dispose 掉,恢复之后就没有任何东西可以重传 —— 场景会空掉,
 * 而且**当场看不出因果**:画面是在"恢复"之后才黑掉的。
 * 所以那条断言(丢失路径上 dispose 调用数为 0)守的是这条不许越过的线。
 */

import type * as THREE from 'three';
import type { Loop } from './loop';
import { contextLost, contextRecoveryTimedOut, contextRestored } from '../ui/actions';

/** 一件"只有我们能重建"的事。 */
export interface RebuildHook {
  /** 中文名。会原样出现在遮罩与诊断里 —— 写"环境贴图",不要写 `pmrem`。 */
  name: string;
  /**
   * 重建。**不得 dispose 任何东西**,见文件头。
   * 允许抛错:抛了会被记成这一项的失败,剩下的项继续跑。
   */
  run: () => void;
}

export interface ContextGuardDeps {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  loop: Loop;
  hooks: readonly RebuildHook[];
  /**
   * 超过这么久还没等到 `webglcontextrestored`,就报"恢复超时"。
   *
   * 默认 8 秒。这个数不是性能指标,是**用户体验的取舍**:等太久,
   * 用户对着一动不动的画面不知道该干嘛;太短,又会在浏览器马上要恢复的
   * 时候误报。真实的恢复通常在 1 秒内完成,超过 8 秒基本就是不会回来了 ——
   * 而这恰恰是现实中最常见的结果(驱动重置、显存耗尽),必须给用户出路。
   */
  timeoutMs?: number;
}

export interface ContextGuardDiagnostics {
  contextLost: boolean;
  lostCount: number;
  restoredCount: number;
  recoveryTimedOut: boolean;
  /** 最近一次丢失持续了多久(毫秒)。没丢过是 0。 */
  lastOutageMs: number;
  lastRebuild: Array<{ name: string; ok: boolean; error?: string }>;
}

export interface ContextGuard {
  readonly diagnostics: ContextGuardDiagnostics;
  dispose(): void;
}

export function installContextGuard(deps: ContextGuardDeps): ContextGuard {
  const { canvas, renderer, loop, hooks, timeoutMs = 8000 } = deps;

  let isLost = false;
  let lostCount = 0;
  let restoredCount = 0;
  let timedOut = false;
  let lostAt = 0;
  let lastOutageMs = 0;
  let lastRebuild: Array<{ name: string; ok: boolean; error?: string }> = [];
  let timer: number | null = null;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const onLost = (event: Event): void => {
    // ① 不阻止默认行为 → 浏览器不会再尝试恢复,restored 事件永远不会来。
    event.preventDefault();

    isLost = true;
    lostCount++;
    lostAt = performance.now();
    timedOut = false;
    // 主循环必须停。停不下来会是"每帧往死上下文提交" ——
    // three 自己会在 render() 开头 `if (_isContextLost) return`,
    // 所以画面不会更坏,但 rAF 空转会把帧时统计灌成一堆无意义的数。
    loop.stop(renderer);
    contextLost();
    console.warn('[gpu] 图形上下文丢失,画面已暂停');

    clearTimer();
    timer = window.setTimeout(() => {
      timer = null;
      timedOut = true;
      contextRecoveryTimedOut();
      console.warn(`[gpu] 等待上下文恢复超过 ${timeoutMs}ms,遮罩已提供「刷新页面」`);
    }, timeoutMs);
  };

  const onRestored = (): void => {
    clearTimer();
    isLost = false;

    // 逐项重建,各自 try/catch。
    //
    // ⚠️ 一项失败**不能**中断其余的:环境贴图与水面反射互不相干,
    //    前者失败让画面整体发黑,后者失败只让倒影不对。让后者
    //    跟着一起不做,是把一个可诊断的小故障升级成一团分不清的糊。
    const results: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const h of hooks) {
      try {
        h.run();
        results.push({ name: h.name, ok: true });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        results.push({ name: h.name, ok: false, error });
        console.error(`[gpu] 重建「${h.name}」失败:${error}`);
      }
    }
    lastRebuild = results;

    restoredCount++;
    lastOutageMs = Math.round(performance.now() - lostAt);

    // ⚠️ 顺序:先 resetTimer,再 start。
    //    `Timer.reset()` 把 `_currentTime` 推成"此刻",而 `update()` 里的
    //    `_delta = _currentTime - _previousTime` —— 于是恢复后首帧的 dt
    //    是"从 reset 到下一次 rAF"的那几毫秒,而不是整个丢失时长。
    //    反过来写的话首帧读到的 dt 会是丢失时长,虽然会被 MAX_DT(50ms)
    //    钳住不会让画面跳变,但那一帧的动画仍然白白慢半拍。
    //    (核过 three 的 Timer:reset 只动 `_currentTime`,不动 `_previousTime` ——
    //     所以能work 靠的是 update 开头的 `_previousTime = _currentTime`。)
    loop.resetTimer();
    loop.start(renderer);

    contextRestored(results);
    const failed = results.filter((r) => !r.ok).length;
    console.info(
      `[gpu] 上下文已恢复(中断 ${lastOutageMs}ms,重建 ${results.length - failed}/${results.length} 项)`,
    );
  };

  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  return {
    get diagnostics(): ContextGuardDiagnostics {
      return {
        // ⚠️ 必须用本地这个 `isLost`,**不能**写 `!loop.isRunning`。
        //    主循环会因为别的原因停 —— 逐环节计时(`measureStages`)与
        //    吞吐测量(`measureBurst`)都会先 stop 再 start。拿循环状态
        //    当上下文状态,那些测量一跑,诊断就会报"上下文丢了",
        //    而它其实好好的。这正是本项目反复栽的那个跟头:
        //    读数来自一个**含义不完全重合**的仪表。
        contextLost: isLost,
        lostCount,
        restoredCount,
        recoveryTimedOut: timedOut,
        lastOutageMs,
        lastRebuild: lastRebuild.map((r) => ({ ...r })),
      };
    },
    dispose(): void {
      clearTimer();
      canvas.removeEventListener('webglcontextlost', onLost, false);
      canvas.removeEventListener('webglcontextrestored', onRestored, false);
    },
  };
}
