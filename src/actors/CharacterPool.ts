import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import raw from '../data/actors.json';
import {
  createProceduralWalk,
  type ProceduralWalk,
} from './proceduralWalk';
import type { Obstacles } from '../world/obstacles';
import { mulberry32 } from '../audio/rng';

/**
 * 把 `actors.json` 里排好的 **48 个人**实例化出来,并驱动他们走动。
 *
 * ## 为什么是克隆 `_rig` 节点,而不是克隆网格
 *
 * 实测(runtime,见 tools/perf/once/chars.mjs 的第 1 组输出):
 * `char_carry` 与 `acc_carry_pole` **共享同一个 Skeleton 实例**
 * (uuid b2745395,21 根骨,首骨 root);`char_punt` 与 `acc_punt_pole` 同理。
 * 而这种共享在 GLB 里是常态 —— 同一副骨架下的多个网格指向同一个 skin。
 *
 * 所以克隆的**最小单位是那具骨架连同挂在它下面的所有网格**,在场景里
 * 就是 `char_<姿态>_rig` 这个 Object3D:它的子节点同时包含
 * SkinnedMesh(可能不止一个)与根骨骼。只克隆其中一块网格的话,
 * 另一块仍指着**原骨架** —— 于是"人走了、扁担留在原地",而且不报错。
 *
 * ⚠️ 直接用 `Object3D.clone()` 也不行的:它**共享 Skeleton**,48 个人会
 *    共用一个骨架,动作完全同步(计划书风险 #3)。必须走
 *    `SkeletonUtils.clone()`,它会把骨架和 `skinIndex` 一起重映射。
 *
 * ## 位置一律用 `+=`,不用 `set()`
 *
 * 模板 rig 自己带着一个**烘进 `position.y` 的落地修正量**:
 * 实测 `char_vendor_rig.y = −0.306`(蹲姿),其余六具在 +0.001 ~ +0.021。
 * 这是 Blender 侧"把每具的最低点抬到 z=0"留下的量。
 * 用 `position.set(x, y, z)` 会把它**整条抹掉**,于是只有蹲着的那个人
 * 浮在半空 —— 而这个坑本项目已经踩过一次(见 memory 第 27 条)。
 * 所以:克隆之后**在既有值上累加**,让别人的量留在原地。
 *
 * ## 朝向:模型朝哪儿是**量出来的**,不是约定的
 *
 * `actors.json` 给的是 Blender 坐标下的 yaw,而模型自身朝 +Z 还是 −Z
 * 取决于 Blender 那边怎么建的。这里不写死一个猜测,而是**从骨架自己
 * 量**:取两侧脚(或髋)的水平连线,`forward = 左向 × up`。
 * 量出来是多少就用多少,并打日志 —— 猜错方向的代价是"整个市集的人
 * 倒着走",而倒着走在静止截图里几乎看不出来。
 */

export interface CharacterPool {
  update(dt: number): void;
  readonly spawned: number;
  readonly walking: number;
  readonly templates: string[];
  /**
   * 模型自身的前向在**局部坐标系**里的方向(只读)。
   *
   * 单独立一个 getter 出来,是为了让探针能拿它跟**外部事实**对质:
   * Blender 侧人物"脸朝 +Y",`export_yup` 后应当是 three 的 `(0,0,-1)`。
   * 这是唯一一个**不依赖本项目自己公式**的判据 ——
   * 别的自检(髋/臂/位移互相印证)都共享同一套符号假设。
   */
  readonly localFacing: THREE.Vector3;
  /** 诊断快照。断言"人真的动了"用 —— 位置必须随 worldTime 变。 */
  snapshot(): Array<{
    id: string;
    pose: string;
    pos: [number, number, number];
    /**
     * 目标朝向,**单位:度**。
     * 名字里带 `Deg` 是刻意的 —— 本项目栽过一次"数算对了、单位名说谎"
     * (memory 第 29 条:1.8 秒被印成 1799 秒)。角度这种既可能用弧度
     * 也可能用度的量,名字里必须写清楚是哪一种。
     */
    yawDeg: number;
    driven: number;
    phase: number;
    /**
     * 模型自身的朝向(世界系,已归一到 XZ 平面),由**量出来的** `localFacing`
     * 乘上实例四元数得到。
     *
     * ⚠️ 字段名以前叫 `moveDir`(移动方向),那是**在说谎**:它算的是
     *    rig 的局部 +Z,而模型的前向是局部 −Z —— 名字与含义差了 180°。
     *    真正"往哪个方向移动"只有一个可靠来源:**两次快照之间的位移**,
     *    那是物理事实。所以这里改名成它真正算的东西,移动方向由探针自己
     *    从位移求,不再由本对象代劳。
     */
    bodyFwd: [number, number, number] | null;
    /**
     * 从**上臂**量出来的模型朝向,作为独立第二来源。
     *
     * ⚠️ 它能发现什么、不能发现什么,见 `measureArmFacing` 的注释:
     *    它与 `bodyFwd` 同公式,所以**公式整体反号时它俩会一起反**,
     *    夹角仍是 0°。要发现"整体反了"必须靠位移。
     */
    armFwd: [number, number, number] | null;
    /**
     * rig 原点到脚底的偏移。`pos[1] − baseOffsetY` 就是这个人脚下**应有的**
     * 地面高度 —— 与独立打出来的 `groundAt(pos[0], pos[2])` 一比,
     * 就能查出"脚是不是踩在地上"。
     *
     * 加这个字段是为了验地面采样节流:节流之后高度每 0.3 米才更新一次,
     * 于是 `pos[1]` 与真实地面之间**必然**有一个由坡度决定的误差。
     * 这个误差有多大、会不会让人浮起来,只能量,不能靠"应该没事"。
     * 没有它就只能比 `pos[1] − groundAt(...)`,而那个差值里混着
     * 每人不同的 baseOffsetY,读不出来。
     */
    baseOffsetY: number;
    /** 这一帧是否贴地(船上的为 false,不参与地面核对)。 */
    grounded: boolean;
  }>;
}

interface Actor {
  id: string;
  pose: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  swing: string[];
  anim: string;
  surface: string;
}

interface Instance {
  id: string;
  pose: string;
  rig: THREE.Object3D;
  walk: ProceduralWalk | null;
  speed: number;
  /** 目标朝向(弧度,绕世界 Y)。转身是**渐变**的,见 `TURN_RATE`。 */
  yaw: number;
  /**
   * **当前已施加**的朝向(弧度)。
   *
   * ⚠️ 必须自己记,不能去读 `rig.rotation.y` —— 这是踩过的坑:
   *    出生时四元数是 `premultiply(R_y(yaw − facingYaw))`,实测
   *    `facingYaw = π`(模型脸朝 −Z),于是 `rotation.y = yaw − 180°`。
   *    转身那段写的是 `diff = it.yaw - it.rig.rotation.y`,于是**每帧都
   *    读到 180° 的误差**,命令一直存在,48 具里有 25 具在加载后
   *    以 2.6 rad/s(**约 149°/s**)原地自转半圈。
   *
   *    它为什么难发现:自转会把"朝向"和"前进方向"**一起**带走,
   *    所以"朝向 vs 位移"的自检读到的是 0° —— 两边一起错,自检反而通过。
   *    只有把"目标 − 实际"这个**原始读数**印出来才看得见(实测 p50 = 179.3°)。
   */
  curYaw: number;
  /** 脚下相对 rig 原点的偏移量,落地时加回去(见文件头)。 */
  baseOffsetY: number;
  /**
   * 上一次**打射线取样**的位置,用来做"移动够远才重采"的节流。
   *
   * ⚠️ 它节流的是**射线本身**,不只是赋值。早先它只卡住
   *    `rig.position.y = g` 那一行,射线照打 —— 于是"每移动 0.3 米采一次"
   *    这条注释描述的是意图,代码没有实现它(实测见 update 里的注释)。
   */
  lastSample: THREE.Vector3;
  /** 上一次采样得到的地面高度。节流期间沿用这个值。 */
  lastGround: number | null;
  /** 强制下一次重新打射线(掉头之后必须重采,否则会一直读到上一次的结论)。 */
  needGroundSample: boolean;
  grounded: boolean;
  /** 这一帧是否真的移动了。诊断用。 */
  moved: number;
}

/** 身体半径(米)。挡路判定用它外扩。 */
const BODY_RADIUS = 0.28;
/** 转身速度(弧度/秒)。撞墙掉头时用,避免瞬间转身。 */
const TURN_RATE = 2.6;
/**
 * 走多远重采一次地面(米)。见 obstacles.ts 里关于射线开销的说明。
 *
 * 这个数直接决定**脚的贴地误差**:两次采样之间高度是缓存值,误差约为
 * `坡度 × GROUND_RESAMPLE`。实测(虹桥机位,单次射线 0.595ms,
 * 核对方式见 tools/perf/once/ground_throttle_check.mjs —— 拿人物缓存的
 * 高度与探针现场重打的 `groundAt` 对质):
 *
 *   0.30m → 误差 p50 0.0003m / p95 0.050m / max 0.141m,桥上最坏 0.183m
 *   0.15m → 误差 p50 0.0003m / p95 0.024m / max 0.052m,桥上最坏 0.086m
 *
 * 代价是采样次数翻倍:「人物」一环 0.67 → 1.70ms(p95 7.94)。
 * 这一笔换得起 —— 桥上 18 厘米的下陷近景是看得出来的。
 *
 * 0.30 是**射线不节流**那个年代定的("反正每帧都打")。射线真正节流之后
 * 场上只有 2~3 次/帧,预算允许把这个距离减半,把贴地误差也减半 ——
 * 桥上 18 厘米的下陷近景是看得出来的,而这个作品的诉求正是"近景经得起看"。
 */
const GROUND_RESAMPLE = 0.15;

const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _next = new THREE.Vector3();
const _left = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _yawQuat = new THREE.Quaternion();

/** 去掉 `_<数字>` 后缀。理由见 proceduralWalk.ts 里同名的那个函数。 */
const baseName = (n: string): string => n.replace(/_\d+$/, '');

/**
 * 从一具骨架量出"模型自身朝哪个方向"。
 * 用两侧髋关节的水平连线:左向 × up = 前向。
 *
 * ⚠️ **必须用髋,不能用脚** —— 这一条是实测改过来的。
 *
 *    最初写的是"优先用 foot_L/foot_R"。量出来是 **155.0°**:
 *    既不是 0° 也不是 180°,差了 25°。原因不在骨架,在**取景**:
 *    `carry` 是一具**迈步中的**姿态,两只脚一前一后 ——
 *    于是"左右连线"被步幅斜过去了 25°,量到的是"步子的方向",
 *    不是"身体朝向"。而走路姿态的脚**永远**是错开的,这个偏差不会自己消失。
 *
 *    `thigh_L`/`thigh_R` 的**骨头原点**是髋关节,长在骨盆上,
 *    迈步时只改朝向不改位置,所以这条连线**与姿态无关**。
 *
 *    顺带:`carry` 的髋还是全部七具里最不齐的一具(挑担时会拧腰)。
 *    量它都稳,其余六具更稳。
 */
function measureFacingFrom(
  rig: THREE.Object3D,
  nameA: string,
  nameB: string,
): THREE.Vector3 | null {
  let oa: THREE.Object3D | null = null;
  let ob: THREE.Object3D | null = null;
  rig.traverse((o) => {
    const n = baseName(o.name);
    if (n === nameA) oa = o;
    if (n === nameB) ob = o;
  });
  if (!oa || !ob) return null;

  const l: THREE.Object3D = oa;
  const r: THREE.Object3D = ob;
  l.getWorldPosition(_tmpA);
  r.getWorldPosition(_tmpB);
  _tmpA.y = 0;
  _tmpB.y = 0;
  _left.subVectors(_tmpA, _tmpB);
  if (_left.lengthSq() < 1e-8) return null;
  _left.normalize();
  // forward = left × up
  const f = new THREE.Vector3().crossVectors(_left, _up);
  return f.lengthSq() < 1e-8 ? null : f.normalize();
}

/**
 * 量朝向的结果。**必须带上"实际用的是哪一对骨头"**。
 *
 * ⚠️ 原先这里只返回一个 `Vector3`,日志里印的是写死的字符串
 *    `(foot/shin/thigh 的左右连线)` —— 它把三个候选全列一遍,
 *    **不表示真的用了哪一个**。我据此推断过"髋查不到、退回脚了",
 *    那是在把一段静态文本当读数读。日志里凡有"来源/依据"字样,
 *    要么由代码填真值,要么就删掉。
 */
interface FacingHit {
  fwd: THREE.Vector3;
  source: string;
}

/** 髋优先(理由见上),取不到才退回膝、脚。 */
function measureFacing(rig: THREE.Object3D): FacingHit | null {
  const pairs: Array<[string, string, string]> = [
    ['thigh_L', 'thigh_R', '髋 thigh_L/R'],
    ['shin_L', 'shin_R', '膝 shin_L/R'],
    ['foot_L', 'foot_R', '踝 foot_L/R'],
  ];
  for (const [a, b, label] of pairs) {
    const f = measureFacingFrom(rig, a, b);
    if (f) return { fwd: f, source: label };
  }
  return null;
}

/**
 * 独立校验用的第二组朝向:**上臂**左右连线。
 *
 * ⚠️ 原先这里用的是 `shoulder_L/R`,**实测左右两点世界坐标完全重合**
 *    (差 0.0000m),`measureFacingFrom` 恒返回 null ——
 *    于是 48 具的朝向自检全部拿不到样本。原因是锁骨这类骨的**骨头原点
 *    长在颈根**,只有*尾巴*才朝外;拿原点连线量不出任何东西。
 *
 *    换成 `upperarm_L/R`(肩关节,实测左右相距 0.3808m):
 *    与髋一样是"关节原点",但**这对骨头没有参与过 yaw 的推算**,
 *    所以拿它复核是有意义的。
 *
 * ⚠️ 但要说清楚它**不能**发现什么:它和 `measureFacing` 用的是**同一个公式**,
 *    所以公式本身若符号反了,两边会一起反,夹角照样是 0°。
 *    真正能发现"整体反了"的是**位移**——那是物理事实,不是算出来的方向。
 *    探针因此以"实际位移 vs 本函数结果"为准,而不是拿两个公式互相印证。
 */
function measureArmFacing(rig: THREE.Object3D): THREE.Vector3 | null {
  return measureFacingFrom(rig, 'upperarm_L', 'upperarm_R');
}

export function createCharacterPool(opts: {
  scene: THREE.Scene;
  obstacles: Obstacles;
  /** 模板所在的组。缺省在整个场景里找 `char_*_rig`。 */
  root?: THREE.Object3D;
}): CharacterPool {
  const { scene, obstacles } = opts;
  const searchRoot = opts.root ?? scene;

  const actors = (raw.actors ?? []) as Actor[];
  if (!actors.length) {
    // 不抛异常:没有人物时场景仍然能看(只是空),但必须**喊出来** ——
    // 空荡荡的市集正是那种"看着只是安静了点"的静默失败。
    console.warn('[actors] actors.json 里没有人物,市集将是空的');
  }

  // —— 模板表 ——
  const templates = new Map<string, THREE.Object3D>();
  searchRoot.traverse((o) => {
    const m = /^char_(.+)_rig$/.exec(o.name);
    if (m) templates.set(m[1]!, o);
  });
  for (const t of templates.values()) t.visible = false; // 模板本身不出镜

  // —— 量一次朝向 ——
  // 取一具有腿的模板来量。所有模板由同一套 Blender 代码生成,朝向一致。
  let facing = new THREE.Vector3(0, 0, 1);
  let facingSource = '默认 +Z(一对骨头都没量到)';
  let facingTemplate: THREE.Object3D | null = null;
  for (const [pose, t] of templates) {
    const hit = measureFacing(t);
    if (hit) {
      facing = hit.fwd;
      facingSource = `${pose} 模板 · ${hit.source}`;
      facingTemplate = t;
      break;
    }
  }
  const facingYaw = Math.atan2(facing.x, facing.z);
  // 上面这个 facingYaw 只用于**打印**,不再用于算旋转 —— 原因见下。

  // —— `a.yaw` 到底是什么口径:以 Blender 源码为准 ——
  //
  // blender/build/08_assembly.py 里写着人的前向:
  //     f = Vector((-math.sin(yaw), math.cos(yaw), 0.0))
  // `(x, z, -y)` 换算到 three 就是 **(-sin yaw, 0, -cos yaw)**。
  //
  // ⚠️ 这**不是**"把 yaw 当成 three 里的 atan2(x, z) 角"。
  //    两者差 180°:Blender 的 yaw=0 对应 three 的 **-Z**,而
  //    模型自身的 `localFacing` 实测也正是 (0,0,-1) ——
  //    也就是说 **yaw=0 时模型不需要任何旋转**。
  //
  //    旧代码写的是 `rotate(a.yaw - facingYaw)`,而 facingYaw = atan2(0,-1) = π,
  //    于是 yaw=0 时反而转 −180°,整套人正好朝反方向走。
  //    它之所以一直看着没出错,是因为转身那段同时也在**错误地**转 180°
  //    (见 `curYaw` 的注释),两个 180° 互相抵消,人恰好走对了方向 ——
  //    代价是加载后所有人先原地自转半圈。修掉自转之后,这个抵消没有了,
  //    才暴露出真正的口径错误。
  //
  // 所以这里不再用"角度相减"来推补偿,而是直接用 Blender 的式子:
  // 目标前向在 (sin, cos) 口径下的角 = yaw + π;模型自身前向的角 = facingYaw。
  // 两者相减即为应当施加的旋转。
  const WANT_YAW_OFFSET = Math.PI;
  const appliedYawFor = (yaw: number): number => yaw + WANT_YAW_OFFSET - facingYaw;

  // —— 模型自身的前向,换算到**局部坐标系** ——
  //
  // `facing` 是在模板的世界系里量的;实例的世界前向 = 本向量 × 实例世界四元数。
  // 用模板自身的世界四元数把它拉回局部系,避免把模板带着的旋转算两遍。
  // 实例是 `scene.add()` 直接挂在场景下的,父级无旋转,所以
  // `rig.quaternion` 就是它的世界旋转,每帧不必再取矩阵。
  const localFacing = new THREE.Vector3(0, 0, -1);
  if (facingTemplate) {
    const tq = facingTemplate.getWorldQuaternion(new THREE.Quaternion());
    localFacing.copy(facing).applyQuaternion(tq.invert()).normalize();
  }

  console.info(
    `[actors] 模板 ${templates.size} 种: ${[...templates.keys()].join(', ')};` +
      `模型朝向实量为 ${(facingYaw * 180 / Math.PI).toFixed(1)}°(来源:${facingSource})` +
      `;局部前向 (${localFacing.x.toFixed(2)}, ${localFacing.y.toFixed(2)}, ${localFacing.z.toFixed(2)})` +
      // 把口径写进日志,而不是留在代码里:yaw=0 应施加 0° 旋转、
      // 且此时世界前向应为 (0,0,-1)(Blender 的"沿街走 yaw 取 0 或 π")。
      `;按 Blender 口径 yaw=0 施加 ${(appliedYawFor(0) * 180 / Math.PI).toFixed(1)}° 旋转`,
  );

  /**
   * 由角色 id 派生的稳定哈希(FNV-1a,32 位)。
   *
   * 为什么用 id 派生,而不是拿一个全局 RNG 顺着发:
   *   色相一旦依赖**生成顺序**,以后往 actors.json 里加一个人、
   *   或者调整任何一个人的位置,整条街的人会集体换色。
   *   而"换了一批色"在图上和"换了一批人"根本分不出来 ——
   *   这种回归没人会发现。用 id 派生,则每个人穿什么颜色是他自己的属性。
   */
  function hashId(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /**
   * 给这一具实例的**身体**换一档衣色。
   *
   * 为什么只动 `char_*`、不碰 `acc_*`:
   *   一具实例底下挂着两块蒙皮网格 —— 身体 `char_<姿态>` 与配件
   *   `acc_<姿态>_*`(扁担、船篙、竹篮)。身体的材质基色**就是**衣色
   *   (Blender 侧刻意不贴图,见 07_characters.py 的 `_robe_material`);
   *   配件则是有贴图的(竹、木),乘一个色只会把贴图染脏。
   *
   * ⚠️ 材质必须 `clone()`。`SkeletonUtils.clone()` 与 `Object3D.clone()`
   *    一样**共享材质引用** —— 直接改 `material.color` 会把同一个姿态的
   *    12 个人一起改掉,而画面上只是"这一批人颜色一样",看着也说得过去。
   *
   * 幅度刻意收在 ±18% 亮度、±8% 单通道:需求写的是"低饱和度衣着",
   * 而这一档的用意是**在近景里把并排的人区分开**,不是让街上出现彩色。
   */
  function tintRobe(rig: THREE.Object3D, id: string): string {
    const rnd = mulberry32(hashId(id));
    const v = 0.82 + rnd() * 0.36; // 明度倍率
    const warm = 0.96 + rnd() * 0.10; // 红通道偏置
    const cool = 0.94 + rnd() * 0.10; // 蓝通道偏置
    let applied = '';
    rig.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !/^char_/.test(mesh.name)) return;
      const src = mesh.material as THREE.MeshStandardMaterial;
      if (!src || !src.color) return;
      const m = src.clone();
      m.color.setRGB(
        Math.min(1, src.color.r * v * warm),
        Math.min(1, src.color.g * v),
        Math.min(1, src.color.b * v * cool),
      );
      mesh.material = m;
      applied = m.color.getHexString();
    });
    return applied;
  }

  const instances: Instance[] = [];
  const missingPoses = new Set<string>();

  for (const a of actors) {
    const tpl = templates.get(a.pose);
    if (!tpl) {
      missingPoses.add(a.pose);
      continue;
    }
    const rig = cloneSkeleton(tpl);
    rig.visible = true;
    rig.name = `${a.id}_${a.pose}`;
    // userData 里留一份来源,便于在浏览器里点选时认出这是谁
    (rig.userData as Record<string, unknown>).qm_actor = a.id;
    (rig.userData as Record<string, unknown>).qm_pose = a.pose;
    // 衣色逐实例变化 —— 模板只给每个姿态一款底色(实测 48 具只有 7 种色),
    // 于是"12 个走路的人一模一样"。这里按 id 派生一档微调,并把**实际用的**
    // 色值写回 userData:诊断脚本要能读到它,而不是去猜。
    (rig.userData as Record<string, unknown>).qm_robe = tintRobe(rig, a.id);

    // —— 位置:在模板既有值上**累加** ——
    // actors.json 是 Blender 坐标 (x, y, z),导到 three 是 (x, z, −y)。
    // 用 += 保住模板烘进去的落地修正量(见文件头)。
    const baseOffsetY = rig.position.y;
    rig.position.x += a.x;
    rig.position.y += a.z;
    rig.position.z += -a.y;

    // —— 朝向:premultiply ——
    // 在**父级坐标系**里绕世界 Y 转,而不是改 `rotation.y`:
    // 模板可能带着 Blender 烘进来的局部旋转(例如 Y-up 转换),那时
    // `rotation.y += yaw` 转的是"模型自己的轴",方向会整体偏掉。
    // premultiply 加的是父级系里的旋转,与模板的局部旋转无关。
    // 另外减去模型自身的朝向偏置,让 yaw 直接就是"朝哪儿走"。
    _yawQuat.setFromAxisAngle(_up, appliedYawFor(a.yaw));
    rig.quaternion.premultiply(_yawQuat);
    // 出生即"已转到"目标朝向 —— 不这样写的话第一帧 diff = 0 也成立,
    // 但把它显式记下来才说明 curYaw 的口径与 `it.yaw` 一致(见 Instance.curYaw)。
    const curYaw = a.yaw;

    const swing = new Set(a.swing ?? []);
    const legs = swing.has('legs');
    const arms = swing.has('arms');
    const walk =
      a.anim === 'walk' && (legs || arms)
        ? createProceduralWalk(rig, { arms, legs })
        : null;

    instances.push({
      id: a.id,
      pose: a.pose,
      rig,
      walk,
      curYaw,
      speed: a.anim === 'walk' ? a.speed : 0,
      yaw: a.yaw,
      baseOffsetY,
      lastSample: new THREE.Vector3(a.x, a.z, -a.y),
      // 出生点的地面高度是 Blender 排人时就算好的,直接当第一次采样的结果用,
      // 省掉出生那一帧的射线。`needGroundSample` 因此从 false 起步。
      lastGround: baseOffsetY,
      needGroundSample: false,
      // 船上的不算"贴地":船不在 obstacles 的地面集合里,
      // 打射线会打空 -> null -> 人会被判成走出了场地而原地掉头。
      grounded: a.surface === 'terrain' || a.surface === 'bridge',
      moved: 0,
    });

    scene.add(rig);
  }

  if (missingPoses.size) {
    // 这是**必须喊**的:少一种姿态不是"少几个人",而是那一类动作全体消失。
    console.error(
      `[actors] 有姿态找不到对应模板,这些人不会被生成: ${[...missingPoses].join(', ')}` +
        `(场景里现有模板: ${[...templates.keys()].join(', ')})`,
    );
  }

  const walking = instances.filter((i) => i.speed > 0).length;

  // 出生点就落在障碍盒里的有几个人?**这个数要主动报出来。**
  // 它是上面那条"已经站在盒子里就允许往外走"规则存在的理由,
  // 也是"Blender 排人的口径与网页判挡的口径差多少"的唯一观测点。
  // 不报的话,这 9 个人只会表现为"有几个走得慢/不走",看不出是两套口径的差。
  const stuckAtSpawn = instances.filter(
    (i) =>
      i.grounded &&
      obstacles.blocked(i.rig.position.x, i.rig.position.z, BODY_RADIUS),
  );

  console.info(
    `[actors] 生成 ${instances.length} 人(其中走动 ${walking} 人),` +
      `障碍盒 ${obstacles.boxCount} 个,地面网格 ${obstacles.groundTargets} 个;` +
      `出生点落在障碍盒内的 ${stuckAtSpawn.length} 人` +
      (stuckAtSpawn.length ? `(${stuckAtSpawn.slice(0, 5).map((i) => i.id).join(', ')}…)` : ''),
  );

  return {
    update(dt) {
      for (let i = 0; i < instances.length; i++) {
        const it = instances[i]!;

        if (!it.grounded) {
          // 船上的:保持 Blender 摆好的位置与姿势,不走路(撑船人是静姿)
          it.walk?.update(dt, 0);
          continue;
        }

        let speed = it.speed;
        if (speed > 0) {
          // —— 转身:朝 yaw 平滑靠拢(撞墙掉头时用得上) ——
          //
          // ⚠️ 这里曾经减的是 `it.rig.rotation.y`(欧拉角)。那个量与 `it.yaw`
          //    **不同口径**:出生四元数带着 −180° 的朝向补偿,`rotation.y`
          //    因此恒等于 `yaw − 180°`,diff 恒为 ±180° —— 转身命令永不消失,
          //    25 具实例在加载后原地自转半圈。
          //    现在改成减**自己记的 `curYaw`**:与 `it.yaw` 同口径,
          //    收敛后 diff = 0,不再自转。顺带也不再依赖欧拉分解
          //    (那对非纯 Y 的四元数本来就会给出误导性的 y)。
          let diff = it.yaw - it.curYaw;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const turn = TURN_RATE * dt;
          const step = Math.max(-turn, Math.min(turn, diff));
          it.curYaw += step;
          // 用 quaternion 直接旋转,避免 rotation/quaternion 同步的坑
          _yawQuat.setFromAxisAngle(_up, step);
          it.rig.quaternion.premultiply(_yawQuat);

          // —— 前进 ——
          // 前向取**当前实际朝向**(而不是 actors.json 的初始 yaw) ——
          // 掉头之后如果还按初始 yaw 走,人就会横着平移。
          //
          // ⚠️ 这里曾经写死 `set(0, 0, 1)`。实测那是**反的** ——
          //    Blender 侧人物"脸朝 +Y"(见 blender/build/07_characters.py),
          //    `export_yup` 把 Blender +Y 映到 three 的 **−Z**,
          //    所以模型的前向是局部 −Z,而这行让 37 个人**全部倒着走**。
          //
          //    为什么一直没被发现:静帧里"朝前走"和"倒着走"长得一样
          //    (人是一块布,正反都是布),而 37 个人一起倒着走只是
          //    "说不上哪里怪"。它必须靠**位移**才能查出来。
          //
          //    现在不再猜轴向,直接用上面量出来的 `localFacing` ——
          //    写死常量正是这个 bug 的成因,所以修法是把常量删掉。
          _fwd.copy(localFacing).applyQuaternion(it.rig.quaternion);
          _fwd.y = 0;
          if (_fwd.lengthSq() < 1e-8) _fwd.copy(localFacing);
          _fwd.normalize();

          const dist = speed * dt;
          _next.copy(it.rig.position).addScaledVector(_fwd, dist);

          // ⚠️ 判定要分两种情况:**出生点就在盒子里**和**走出去才撞上**。
          //
          //    只写"前方被挡就掉头"的话,出生点落在膨胀后的障碍盒里的人
          //    **一辈子出不来**:原地任何方向都在盒内 → 每帧掉头 → 净位移 0。
          //    实测 48 人里有 9 个是这种(障碍盒按身宽外扩 0.28m,
          //    而 Blender 排人时用的是精确轮廓,两边差那 0.28m 就够卡住)。
          //
          //    规矩改成:已经站在盒子里的**允许往外走**(先出来再说),
          //    只有"从空地走进墙里"才拦。这样卡住的人会自己走出来,
          //    且任何情况下都不会主动走进墙里。
          const insideNow = obstacles.blocked(
            it.rig.position.x,
            it.rig.position.z,
            BODY_RADIUS,
          );
          if (!insideNow && obstacles.blocked(_next.x, _next.z, BODY_RADIUS)) {
            // 撞墙:掉头。不瞬移、不穿过去。
            it.yaw += Math.PI;
            speed = 0;
          } else {
            // —— 地面采样必须**节流**,射线不能每帧打 ——
            //
            // ⚠️ 这里曾经无条件调一次 `obstacles.groundAt`。它是没有 BVH 的
            //    `intersectObjects`,实测单次 p50 = **0.595ms**。场上 37 个
            //    走动的人 × 0.595 ≈ **22ms/帧** —— 占一帧的 85%,
            //    比整个渲染(3.9ms)贵五倍多。而 `GROUND_RESAMPLE` 那条
            //    0.3 米的节流当时只卡在**赋值高度**那一行上,射线照打。
            //
            //    也就是说:注释写着"每移动 0.3 米采一次",而代码每帧每人采一次。
            //    发现它的路径不是看图 —— 画面上完全看不出异常,人照常走;
            //    是把 `frameStep` 拆成环节逐个计时之后,「人物」一环 22.64ms
            //    顶在最上面,再乘一下单次射线成本对上了,才落到这一行。
            //
            // 采样点取 `_next`(将要走到的位置)而不是当前位置:要判断的
            // 正是"那边有没有地面",采当前位置等于永远慢一步。
            const sampled =
              it.needGroundSample ||
              it.lastSample.distanceToSquared(it.rig.position) >
                GROUND_RESAMPLE * GROUND_RESAMPLE;

            let g: number | null;
            if (sampled) {
              g = obstacles.groundAt(_next.x, _next.z);
              it.lastGround = g;
              it.needGroundSample = false;
              // 记的是**采样点**,不是当前位置:节流判据要量的是
              // "从上一次取样到现在走了多远"。
              it.lastSample.set(_next.x, it.rig.position.y, _next.z);
            } else {
              // 两次采样之间沿用上一次的高度。虹桥拱面 0.3 米里高度变
              // 约 0.075 米,肉眼不可见;这与修改前的行为一致(高度本来
              // 就是每 0.3 米才更新一次)。
              g = it.lastGround;
            }

            if (g === null) {
              // 前方没有地面(走出了地形/探到了河面):掉头。
              // 这里**不能**把 g 当 0 用 —— 那会让人走到水面上站着。
              it.yaw += Math.PI;
              speed = 0;
              // 掉头之后**必须**立刻重采:上一次的 null 是针对原来那个方向的结论,
              // 不重采的话下一帧读到它又会掉头,人就在原地无限转圈。
              it.needGroundSample = true;
            } else {
              it.rig.position.x = _next.x;
              it.rig.position.z = _next.z;
              // 高度只在**这一帧刚采过**的时候更新。没采的那几帧
              // `g` 是缓存的旧值,再赋一遍是同一个数,没必要动它。
              if (sampled) it.rig.position.y = g + it.baseOffsetY;
            }
          }
          it.moved = speed > 0 ? dist : 0;
        } else {
          it.moved = 0;
        }

        // 相位由**实际速度**推进:撞墙那几帧速度为 0,腿就停在原地,
        // 不会出现"贴着墙还在原地踏步"。
        it.walk?.update(dt, speed);
      }
    },

    get spawned() {
      return instances.length;
    },
    get walking() {
      return walking;
    },
    get templates() {
      return [...templates.keys()];
    },
    get localFacing() {
      return localFacing.clone();
    },

    snapshot() {
      return instances.map((i) => {
        // 模型前向 = 量出来的局部前向 × 实例旋转。**不再是写死的 +Z**。
        const f = localFacing.clone().applyQuaternion(i.rig.quaternion);
        f.y = 0;
        const oriented = f.lengthSq() > 1e-8;
        if (oriented) f.normalize();

        return {
          id: i.id,
          pose: i.pose,
          pos: [
            +i.rig.position.x.toFixed(3),
            +i.rig.position.y.toFixed(3),
            +i.rig.position.z.toFixed(3),
          ] as [number, number, number],
          yawDeg: +((i.yaw * 180) / Math.PI).toFixed(1),
          /** 实际已施加的朝向(自己记的 `curYaw`),与目标 `yawDeg` 分开报。 */
          curYawDeg: +((i.curYaw * 180) / Math.PI).toFixed(1),
          /**
           * 转身指令的**原始读数**:目标 − 实际,归一到 (-180, 180]。
           *
           * 这是当初唯一能看见那个自转 bug 的量。留着它,因为"朝向 vs 位移"
           * 这类自检对**整体一起转**的错是盲的(两边一起错 → 夹角 0°),
           * 只有这个差值能暴露"命令一直存在"。稳定后应当 ≈0。
           */
          turnDiffDeg: +(() => {
            let d = i.yaw - i.curYaw;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            return ((d * 180) / Math.PI).toFixed(1);
          })(),
          driven: i.walk?.driven ?? 0,
          phase: +(i.walk?.phase ?? 0).toFixed(2),
          bodyFwd: oriented
            ? ([+f.x.toFixed(3), 0, +f.z.toFixed(3)] as [number, number, number])
            : null,
          // 上臂量的朝向 —— 与 `measureFacing` 用的髋是两对不同的骨头,
          // 且这对骨头没有参与过 yaw 的推算
          armFwd: (() => {
            const s = measureArmFacing(i.rig);
            return s
              ? ([+s.x.toFixed(3), 0, +s.z.toFixed(3)] as [number, number, number])
              : null;
          })(),
          baseOffsetY: +i.baseOffsetY.toFixed(4),
          grounded: i.grounded,
        };
      });
    },
  };
}
