/**
 * 相机的**唯一权威**。
 *
 * 除本类之外,任何模块都不得直接改 `camera.position` / `camera.quaternion`
 * 或 OrbitControls 的 target。理由很实际:相机是被最多功能同时惦记的东西
 * —— 环视、景点切换、巡游、防穿模推挤、窗口自适应都要动它。若各自为政,
 * "切换景点时抖一下""退出巡游后视角回弹"这类问题会层出不穷且无从复现。
 *
 * 四态状态机 `orbit | tween | roam | tour`。三条不变量:
 *
 *   ① **tween 期间不调用 `controls.update()`**。阻尼是有残量的,补间
 *      期间如果还让 controls 每帧"收拾一下",末段会多出一次回摆 ——
 *      正是验收里"无弹跳"要挡的东西。
 *   ② **手动操作立即退出自动行为**(`tween`/`roam`/`tour` → `orbit`)。
 *      监听挂在与键盘同一处的 **capture 阶段**,保证在任何 UI 控件拿到
 *      事件之前先把自动行为停掉。
 *   ③ 退出自动行为时把 `controls.target` 重置到**相机前方**一点。
 *      否则 target 还停在上一处景点上,用户一动鼠标画面就猛地甩过去。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CameraTween, type TweenSample } from './tween';

export type CameraMode = 'orbit' | 'tween' | 'roam' | 'tour';

/**
 * 三元组表示的三维点。
 *
 * 为什么不直接用 `THREE.Vector3Like`:r186 里它是 `{x, y, z}` 的**对象**,
 * 不含元组形式。而景点数据来自 JSON,数组才是它的自然形态,而且
 * `lo.log(...)` 打出来就是 `24.7, 18.5, -17.7`,与截图时抄下来的数一致。
 * 两边强行统一,只会多一层来回转换。(第一版没注意,`tsc` 一次报了 5 处错。)
 */
export type Vec3 = readonly [number, number, number];

/** 一个可飞往的位姿。景点、舆图定位、巡游都用它。 */
export interface Shot {
  id: string;
  position: Vec3;
  target: Vec3;
  /** 巡游时在这个位姿停留多久(秒)。不填用 DEFAULT_DWELL。 */
  dwell?: number;
}

/** 统一的入参类型:数组与 `THREE.Vector3Like` 都收。 */
export interface Pose {
  position: Vec3 | THREE.Vector3Like;
  target: Vec3 | THREE.Vector3Like;
}

function toVec3(v: Vec3 | THREE.Vector3Like): THREE.Vector3 {
  // ⚠️ 这里**不能**用 `Array.isArray(v)` 来区分。
  //    它的类型谓词是 `arg is any[]`,而 `Vec3` 是 **readonly** 元组 ——
  //    `readonly [number,number,number]` 不满足 `any[]`,于是收窄**静默失败**,
  //    联合类型原样保留,接着报三行 `Property 'x' does not exist on type 'Vec3'`。
  //    报错指着属性,真正的原因却是收窄没生效 —— 照着报错找会一路找错方向。
  //    改用属性存在性判断,`in` 对 readonly 元组正常工作。
  return 'x' in v
    ? new THREE.Vector3(v.x, v.y, v.z)
    : new THREE.Vector3(v[0], v[1], v[2]);
}

/** 巡游在每个位姿的停留时长(秒)。 */
const DEFAULT_DWELL = 9;
/** 漫游的角速度(弧度/秒)。刻意很慢 —— 漫游是"漂",不是"转"。 */
const ROAM_RATE = 0.055;
/** 漫游时不允许低于地平线到这个角度以内(弧度,自 +Y 轴量起)。 */
const ROAM_MAX_POLAR = Math.PI * 0.44;
const ROAM_MIN_POLAR = Math.PI * 0.16;
/** 退出自动行为后,target 落在相机前方多远(米)。 */
const REBASE_FORWARD = 18;

/** 键盘推进的基础速度(m/s)。实际速度会随相机距离缩放。 */
const KEY_BASE_SPEED = 9.0;
/** 键盘速度的缩放基准距离:离目标越远,迈得越大,操作手感才不会失真。 */
const KEY_SPEED_REF_DIST = 30.0;
const KEY_SPEED_MIN_SCALE = 0.3;
const KEY_SPEED_MAX_SCALE = 3.0;
/** 键盘移动时相机离地的最小高度(米)。防止贴着地面甚至钻到地面以下。 */
const KEY_MIN_HEIGHT = 0.6;

export interface CameraSnapshot {
  mode: CameraMode;
  position: [number, number, number];
  target: [number, number, number];
  distance: number;
  /** 方位角(弧度),绕 Y 轴 */
  azimuth: number;
  /** 极角(弧度),自 +Y 轴量起 */
  polar: number;
  autoTour: boolean;
  /** 最近一次退出自动行为的原因,形如 `pointerdown (from tour)`。 */
  exitReason: string;
  shots: number;
  tourIndex: number;
}

export class CameraDirector {
  readonly controls: OrbitControls;

  private mode: CameraMode = 'orbit';
  private readonly keys = new Set<string>();

  /** 每帧累积的位移,供测试断言"相机确实动了" */
  private lastDelta = new THREE.Vector3();

  /** 当前补间;非 tween 态时为 null。 */
  private tween: CameraTween | null = null;
  /** 补间开始前所处的模式,用于 `?` 与调试。 */
  private roam: { azimuth: number; polar: number; radius: number } | null = null;
  private shots: Shot[] = [];
  private tourIndex = 0;
  private tourTimer = 0;
  /** 最近一次退出自动行为的原因,写进 snapshot 便于断言与排查。 */
  private lastExitReason = '';

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
  ) {
    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 320;
    // 不允许转到地平面以下 —— 否则会从下方看到地面与河床的背面
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };

    this.bindKeyboard(domElement);
    this.bindManualExit(domElement);
  }

  get currentMode(): CameraMode {
    return this.mode;
  }

  /** 「自动巡游开着吗」。UI 的按钮状态与验收断言都读它。 */
  get autoTour(): boolean {
    return this.mode === 'tour';
  }

  get roamActive(): boolean {
    return this.mode === 'roam';
  }

  get tweening(): boolean {
    return this.mode === 'tween';
  }

  get exitReason(): string {
    return this.lastExitReason;
  }

  /** 上一次 update 造成的位移量(米)。供测试断言方向与幅度。 */
  get deltaSinceLastUpdate(): THREE.Vector3 {
    return this.lastDelta;
  }

  /**
   * 键盘驱动。
   *
   * ⚠️ 必须在 **capture 阶段**监听:自动行为的退出逻辑也挂在这里,
   *    用 capture 才能保证在任何 UI 控件拿到事件之前先把巡游停掉。
   */
  private bindKeyboard(domElement: HTMLElement): void {
    // 方向键默认会滚动页面,必须拦掉
    const BLOCK = new Set([
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      ' ',
    ]);

    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        // 在输入框里打字不算"操作相机" —— 否则在搜索框里敲 W 也会
        // 把巡游掐掉,用户没碰画面却被打断了。
        if (!isTextInput(e.target)) this.exitAuto('keydown');
        this.keys.add(e.code);
        if (BLOCK.has(e.key) && !isTextInput(e.target)) e.preventDefault();
      },
      { capture: true },
    );

    window.addEventListener(
      'keyup',
      (e: KeyboardEvent) => {
        this.keys.delete(e.code);
      },
      { capture: true },
    );

    // 失焦时清空按键。不清的话切走再切回来,相机会一直朝一个方向飘。
    window.addEventListener('blur', () => this.keys.clear(), { capture: true });
    domElement.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /**
   * 「手动操作必须退出自动巡游」的落点。
   *
   * ⚠️ `pointerdown` 用 capture,而且**不过滤左右键** —— 右键平移也是
   *    手动操作。曾经只监听左键,结果用户右键一拖,画面在动、巡游还在
   *    后台按自己的节奏改机位,两者每帧互相覆盖,看起来像"抖"。
   *    滚轮同理:缩放也是操作。
   */
  private bindManualExit(domElement: HTMLElement): void {
    const exit = (kind: string) => () => this.exitAuto(kind);
    domElement.addEventListener('pointerdown', exit('pointerdown'), { capture: true });
    domElement.addEventListener('wheel', exit('wheel'), { capture: true, passive: true });
    // 双指捏合走的是 touchstart,不给它单独挂会漏掉触屏用户
    domElement.addEventListener('touchstart', exit('touchstart'), { capture: true, passive: true });
  }

  /**
   * 退出任何自动行为,回到 `orbit`。
   *
   * 只对自动行为生效 —— 在 orbit 里调它什么也不做,所以可以放心地挂在
   * 每个输入事件上,不必先判断模式。
   */
  exitAuto(reason: string): void {
    if (this.mode === 'orbit') return;
    const wasTweening = this.mode === 'tween';
    const from = this.mode;
    this.mode = 'orbit';
    this.tween = null;
    this.roam = null;
    this.lastExitReason = `${reason} (from ${from})`;

    // ③ 把 target 重置到相机前方。不重置的话,target 还钉在上一处景点,
    //    用户拖一下就把镜头甩到几十米外 —— 看着像相机失控,其实是
    //    "旋转中心还在景点那儿"。
    //
    //    ⚠️ 补间中途被打断时**不要**重置:补间刚走了一半,相机正朝着
    //    目标飞,此刻它前方那个点离真正想看的东西还很远,重置会让画面
    //    跳一下。(这是从验收条件⑤反推的:打断不该产生位置突变。)
    if (!wasTweening) this.rebaseTarget();

    this.controls.enabled = true;
    this.controls.update();
  }

  /** 把 controls.target 放到相机前方的水平投影点上。 */
  private rebaseTarget(): void {
    const look = new THREE.Vector3();
    this.camera.getWorldDirection(look);
    look.y = 0;
    if (look.lengthSq() < 1e-6) {
      // 正俯视时水平投影退化了,退回"保持原距离、朝向不变"
      const cur = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      if (cur.lengthSq() < 1e-6) cur.set(0, 0, -1);
      this.controls.target.copy(this.camera.position).add(cur);
      return;
    }
    look.normalize();
    const d = this.camera.position.distanceTo(this.controls.target);
    const step = Math.min(REBASE_FORWARD, Math.max(2.5, d * 0.6));
    this.controls.target.copy(this.camera.position).addScaledVector(look, step);
  }

  /** 键盘推进的合成方向(世界坐标),已归一化的水平分量 + 独立的垂直分量。 */
  private keyVector(): THREE.Vector3 {
    const k = this.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const right = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const up = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);

    const out = new THREE.Vector3();
    if (!fwd && !right && !up) return out;

    // 相机朝向在水平面上的投影。垂直向下看时它会退化,
    // 此时退回"世界 −Z",否则按 W 相机不动,像是坏了。
    const look = new THREE.Vector3();
    this.camera.getWorldDirection(look);
    look.y = 0;
    if (look.lengthSq() < 1e-6) look.set(0, 0, -1);
    look.normalize();

    const side = new THREE.Vector3().crossVectors(look, new THREE.Vector3(0, 1, 0)).normalize();

    out.addScaledVector(look, fwd);
    out.addScaledVector(side, right);
    out.y += up;
    return out;
  }

  /**
   * 每帧调用。dt 由 Loop 提供 —— 本类**不读任何时钟**。
   */
  update(dt: number): void {
    this.lastDelta.set(0, 0, 0);

    if (this.mode === 'tween') {
      this.stepTween(dt);
      return;
    }
    if (this.mode === 'roam') {
      this.stepRoam(dt);
      return;
    }
    if (this.mode === 'tour') {
      this.stepTour(dt);
      return;
    }

    if (this.mode === 'orbit') {
      const dir = this.keyVector();
      if (dir.lengthSq() > 0) {
        const dist = this.camera.position.distanceTo(this.controls.target);
        const scale = THREE.MathUtils.clamp(
          dist / KEY_SPEED_REF_DIST,
          KEY_SPEED_MIN_SCALE,
          KEY_SPEED_MAX_SCALE,
        );
        // 归一化后再乘速度:斜向按两个键不该比单按一个键快 1.41 倍
        const step = dir.normalize().multiplyScalar(KEY_BASE_SPEED * scale * dt);

        // ⚠️ 只动相机,**不动 controls.target**。
        //
        //    这里曾经把 step 同时加到相机与目标点上,结果是"滑行":
        //    半径恒定不变,按 W 永远走不近桥,而且目标点会一路漂到
        //    场景之外 —— 之后环视就是绕着一片空地在转。
        //    实测依据:screenshots/web/stage1_camera.json,
        //    位移 8.65m 而到目标的水平距离 39.70 → 39.70m,纹丝不动。
        //
        //    正确的语义是:**目标点是"我正在看的东西",WASD 移动的是
        //    观察者**。W 沿视线水平投影靠近目标(距离缩短),
        //    S 后退,A/D 绕行,Q/E 升降。这样才对得上阶段 3 的
        //    "走近看看" —— 那个动作的本质就是缩短半径。
        const next = this.camera.position.clone().add(step);
        // 不许钻到地面以下。OrbitControls 的 maxPolarAngle 只管到
        // "不低于目标点",目标点被平移到地下时就兜不住了。
        next.y = Math.max(next.y, KEY_MIN_HEIGHT);
        this.lastDelta.subVectors(next, this.camera.position);
        this.camera.position.copy(next);
      }
      this.controls.update();
    }
  }

  // ————————————————————————————————————————————————————————————————
  // tween:飞向一个位姿
  // ————————————————————————————————————————————————————————————————

  /**
   * 平滑飞向某个位姿。返回本次补间要走的距离(米),供调用方决定要不要等。
   *
   * ⚠️ 期间 `controls.enabled = false` **且不调用 `controls.update()`**。
   *    这是"无弹跳"的必要条件:controls 的阻尼有残量,补间期间还让它
   *    每帧收拾一次,末段会多出一次回摆。
   */
  flyTo(to: Pose): number {
    const from: TweenSample = {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
    };
    const p = toVec3(to.position);
    const t = toVec3(to.target);
    const dest: TweenSample = {
      position: [p.x, p.y, p.z],
      target: [t.x, t.y, t.z],
    };

    this.tween = new CameraTween(from, dest);
    this.mode = 'tween';
    this.roam = null;
    this.controls.enabled = false;
    return this.tween.totalDistance;
  }

  private stepTween(dt: number): void {
    const tw = this.tween;
    if (!tw) {
      this.mode = 'orbit';
      this.controls.enabled = true;
      return;
    }
    const before = this.camera.position.clone();
    const s = tw.update(dt);
    this.camera.position.set(s.position[0], s.position[1], s.position[2]);
    this.controls.target.set(s.target[0], s.target[1], s.target[2]);
    this.lastDelta.subVectors(this.camera.position, before);

    if (tw.done) {
      this.tween = null;
      this.mode = 'orbit';
      this.controls.enabled = true;
      // 到点后把球坐标里剩余的浮点噪声抹掉:快照读的是 Spherical,
      // 差一个 1e-15 也会让"位置误差 0"的断言变成 1e-15 而不是 0。
      this.controls.update();
    }
  }

  // ————————————————————————————————————————————————————————————————
  // roam:绕着当前目标慢慢漂
  // ————————————————————————————————————————————————————————————————

  /**
   * 开始漫游。
   *
   * 做法是**在球坐标里匀速改方位角** —— 不是"随便找方向飞"。这样有两条
   * 好处:半径恒定,所以不会一头撞进建筑;极角被钳在
   * `[ROAM_MIN_POLAR, ROAM_MAX_POLAR]` 里,而这两个角都离竖直方向足够远,
   * 于是相机高度恒 ≥ 目标点高度 —— 目标点在地面之上,相机就不可能穿地。
   *
   * ⚠️ 这是一条**几何上的保证**,不是"测了 10 秒没穿所以就没事"。
   *    完整的 AABB 推挤是阶段 4 的事;漫游靠这条不变量先站住。
   */
  startRoam(): void {
    const off = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    this.roam = {
      azimuth: sph.theta,
      polar: THREE.MathUtils.clamp(sph.phi, ROAM_MIN_POLAR, ROAM_MAX_POLAR),
      radius: sph.radius,
    };
    this.mode = 'roam';
    this.tween = null;
    this.controls.enabled = false;
    // 立刻按钳过的极角摆一次,免得第一帧才跳
    this.applyRoam();
  }

  private applyRoam(): void {
    const r = this.roam;
    if (!r) return;
    const off = new THREE.Vector3().setFromSphericalCoords(r.radius, r.polar, r.azimuth);
    const before = this.camera.position.clone();
    this.camera.position.copy(this.controls.target).add(off);
    this.lastDelta.subVectors(this.camera.position, before);
  }

  private stepRoam(dt: number): void {
    const r = this.roam;
    if (!r) {
      this.mode = 'orbit';
      this.controls.enabled = true;
      return;
    }
    r.azimuth += ROAM_RATE * dt;
    this.applyRoam();
  }

  // ————————————————————————————————————————————————————————————————
  // tour:自动巡游
  // ————————————————————————————————————————————————————————————————

  /** 设定巡游路线。传入空数组则巡游无内容,`startTour()` 会拒绝启动。 */
  setShots(shots: Shot[]): void {
    this.shots = shots.map((s) => ({ ...s }));
  }

  /**
   * 开始自动巡游。
   *
   * ⚠️ 起点是**当前镜头飞向第一个景点**,不是"瞬移到第一个景点" ——
   *    否则用户一点巡游,画面会跳一下。这一条是功能 6 的验收里
   *    "点击后 autoTour===false"之外,唯一能让巡游看起来不廉价的地方。
   */
  startTour(): boolean {
    if (this.shots.length === 0) return false;
    this.tourIndex = 0;
    this.tourTimer = 0;
    this.mode = 'tour';
    this.roam = null;
    this.flyTo(this.shots[0]);
    // flyTo 会把 mode 改成 'tween',巡游状态得在它之后恢复
    this.mode = 'tour';
    return true;
  }

  private stepTour(dt: number): void {
    if (this.shots.length === 0) {
      this.exitAuto('tour-empty');
      return;
    }
    if (this.tween) {
      this.stepTween(dt);
      // stepTween 结束时会把自己置回 orbit;巡游期间要保持 tour
      if (this.mode === 'orbit') this.mode = 'tour';
      return;
    }
    this.tourTimer += dt;
    const cur = this.shots[this.tourIndex];
    const dwell = cur.dwell ?? DEFAULT_DWELL;
    if (this.tourTimer >= dwell) {
      this.tourTimer = 0;
      this.tourIndex = (this.tourIndex + 1) % this.shots.length;
      this.flyTo(this.shots[this.tourIndex]);
      this.mode = 'tour';
    }
    // 停留期间也在动 —— 让镜头缓慢横移,与"漫游"同一套球坐标逻辑,
    // 否则停留的 9 秒里画面完全静止,看着像卡住了。
    if (!this.tween) {
      const off = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      const sph = new THREE.Spherical().setFromVector3(off);
      sph.theta += ROAM_RATE * 0.5 * dt;
      const before = this.camera.position.clone();
      this.camera.position
        .copy(this.controls.target)
        .add(new THREE.Vector3().setFromSphericalCoords(sph.radius, sph.phi, sph.theta));
      this.lastDelta.subVectors(this.camera.position, before);
    }
  }

  /** 取当前相机状态快照。测试脚本靠它断言,不要读内部字段。 */
  snapshot(): CameraSnapshot {
    const p = this.camera.position;
    const t = this.controls.target;
    const off = new THREE.Vector3().subVectors(p, t);
    const sph = new THREE.Spherical().setFromVector3(off);
    return {
      mode: this.mode,
      position: [p.x, p.y, p.z],
      target: [t.x, t.y, t.z],
      distance: sph.radius,
      azimuth: sph.theta,
      polar: sph.phi,
      autoTour: this.mode === 'tour',
      exitReason: this.lastExitReason,
      shots: this.shots.length,
      tourIndex: this.tourIndex,
    };
  }

  /** 直接摆位。用于初始化、URL 定位与测试脚本,会**中止**任何自动行为。 */
  place(position: Vec3 | THREE.Vector3Like, target: Vec3 | THREE.Vector3Like): void {
    if (this.mode !== 'orbit') this.exitAuto('place');
    this.camera.position.copy(toVec3(position));
    this.controls.target.copy(toVec3(target));
    this.controls.update();
  }

  dispose(): void {
    this.controls.dispose();
  }
}

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}
