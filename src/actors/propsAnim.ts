import * as THREE from 'three';
import { mulberry32 } from '../audio/rng';

/**
 * 道具动态:船桅/橹/舵的**刚体转动**,布幌/柳枝/雨篷的**顶点风动**。
 *
 * 这一层是阶段 4 的主体。人物走路归 `proceduralWalk.ts`,这里管的是
 * 场景里那些"被 Blender 打了 `qm_anim` 标签、但网页侧必须自己驱动"的物件。
 *
 * ## 驱动契约是**量出来的**,不是照计划书抄的
 *
 * 计划书里那张标签表是**设计意图**。真正落到 `object.userData` 上的东西
 * 用 `tools/perf/once/anim_contract.mjs` 逐条核过(applied the same script as
 * the regression check),实测结论如下 —— 有几条和计划书根本对不上:
 *
 * | 类别 | 数量 | 实测 |
 * |---|---|---|
 * | `mast_fold` | 5 | pivot/axis 齐全,全部可驱动 |
 * | `oar` | 12 | **只有 6 个是真橹**;另外 6 个是 `acc_punt_pole`(SkinnedMesh) |
 * | `rudder` | 6 | 齐全 |
 * | `wind` | 24 | 23 个有权重;**`shop_e0_1_cha_awning` 没有权重属性** |
 * | `sway` | 13 | 10 个有权重;**3 根缆绳没有权重属性** |
 *
 * 两条与计划书不符、且都属于"沉默的失败"(不报错,只是那件东西不动):
 *
 * 1. **`acc_punt_pole` 被打了 `qm_anim=oar`。** 它是船工手边那根撑篙,
 *    **蒙皮在 `hand_R` 上** —— 它的动作归骨架管。再给它叠一层刚体旋转
 *    会和水面下的骨骼变换打架。所以刚体分支**一律跳过 SkinnedMesh**,
 *    并把跳过数记进诊断。这是 Blender 侧的标签过宽,不是网页侧的取舍。
 *
 * 2. **`qm_flex` 的值(`"flex"`)在运行时是拿不到的。** Blender 写的颜色属性
 *    叫 `flex`,经 `export_attributes` 变成 `COLOR_0`,到了 three 里
 *    属性名统一叫 **`color`**(itemSize=4、normalized=true)。
 *    也就是说标签里那个名字只是**注解**,不能当查找键用。
 *
 * ## `qm_pivot` / `qm_axis` 是**世界坐标**,但坐标系是 Blender 那一套
 *
 * 两条结论,分别是两次测量得出的,第二次推翻了第一次的一半:
 *
 * ① **是世界坐标,不是物体局部坐标。** 五条船的 pivot 的 y 从 −46.7 铺到 +51.8,
 *    而船体局部坐标下应当都聚在 0 附近 —— 这个铺开本身就是证据。
 *
 * ② **但它是 Blender 的 Z 向上坐标系,必须过一遍 `toYUp` 才能用。**
 *    ① 成立**并不蕴含** ②:y 范围铺得开,在"世界坐标"和"Blender 世界坐标"
 *    两种解释下同样成立,当时只验了前者就当后者也对。真正定案的判据是
 *    "轴心该落在件自己身上",见 `toYUp` 的注释:17 件里 0 件落在自己的
 *    包围盒内,轴心到重心中位 44.9 米。
 *
 * 装载时先把轴心换算到父级空间,之后每帧都在父级空间里算 ——
 * 于是父级(船体)摇起来时,轴心跟着船一起摆,正是物理上该有的样子。
 * (写这句话时船体还不会摇,它是**为将来留的**;阶段 4 把船壳挂成
 * 桅/舵/橹的父级之后,这条路径第一次真的被走到。见文件头
 * "船体轻摇靠的是场景图的父子关系"。)
 *
 * ## 转动一律"从 rest 重算",绝不累加
 *
 * 每帧算 `M = T(p)·R(a,θ)·T(−p)·Rest`,其中 `Rest` 是装载时的局部矩阵。
 * `obj.quaternion.multiply(delta)` 那种写法会累积成麻花(计划书里点名过)。
 * 算完 `decompose` 回 position/quaternion/scale,交给 three 自己的
 * `matrixAutoUpdate` 去合成 —— **不碰 `matrixAutoUpdate`**。
 * 走"直接写 `obj.matrix`"那条路的话,还得记得设 `matrixWorldNeedsUpdate`,
 * 忘了就整件东西不动、而且不报错;少一个可以忘的开关比多一个优化值钱。
 *
 * ## 风动的权重是**普通浮点属性**,不是顶点色
 *
 * `material.vertexColors` 必须保持 `false`。权重只用来位移顶点,
 * 若被当成顶点色乘进基色,整批幌子会变成黑的。
 * 这里把权重从 `color` 里**提出来**存成单分量 `qmFlex`,原 `color` 删掉 ——
 * 留着它是个隐患:哪天有人把 `vertexColors` 打开,颜色就悄悄变了。
 * 提取而非直接读 `color`,还顺手绕开了 `itemSize=4 / normalized uint8`
 * 在着色器里没法当标量声明的麻烦。
 *
 * ## 船体轻摇靠的是**场景图的父子关系**,不是每帧重算整船
 *
 * 阶段 4 补上了整船横摇:船壳带 `qm_anim="hull_rock"`,而它的舱篷、肋骨、
 * 属具、桅、舵、橹、系缆在 Blender 里**全都挂在船壳下**(见 `03_boats.py`
 * 的 `_attach`)。所以这里每帧只需要驱动**船壳一件**,整条船跟着走 ——
 * 包括那些自己不动的静态件(舱篷 / 肋骨 / 属具):它们根本不在 `rigid[]` 里,
 * 也不需要进来。
 *
 * 于是上面第 49 行那句"父级(船体)将来若加轻摇,轴心会跟着船一起摆"
 * 从**许愿**变成了**事实**:桅/舵/橹的轴心在装载时被换算到船体坐标系,
 * 船一摇它们跟着摇,折叠与转向都发生在**已经倾斜的**船体坐标系里。
 *
 * ⚠️ 反过来说:这个正确性**不归本文件管**。哪天有人在 Blender 里新加一个
 *    船部件却忘了 `_attach`,那条船会散架(新件留在原地)。这个错误在
 *    网页侧查不出来 —— 这里只认得 `qm_anim`,看不见谁挂在谁下面。
 *    所以它由 Blender 侧的 `_check_attached()` 在构建期拦下。
 *
 * ⚠️ 已拖上岸的船(`qm_beached=1`)会被下面刚体分支的第一道闸跳过。
 *
 * ## 实测到但**没做**的事(如实记在这里,并进 docs/08)
 *
 * - **不眠桅(那段"放倒"的动作)**。英雄漕船(`船_人字桅`,`qm_folded=1`)
 *   在画里**桅已经放倒**,其余四条是泊船、桅本来就立着。没有"过桥放桅"
 *   的时机可演 —— 凭 `qm_folded` 猜一个 90° 折叠动画会把已经建好的姿态
 *   **折两遍**。
 *
 *   ⚠️ 但"桅不眠"这件事**现在已经成立**,只是靠的不是这段动作:桅挂在
 *   船壳下,船壳横摇 2° 时桅顶随之走 26cm,再叠上它自己那 0.9° 的摆动。
 *   桅顶因此**从不静止** —— 那正是"不眠桅"要的效果,而它不需要一段
 *   "放桅"动画来支撑。别把"没做那段动画"读成"桅不动"。
 * - **法线不重算**。风动只位移顶点,光照不会跟着起伏(见 docs/08)。
 */

/** 需要刚体转动的类别。`rotate` 是计划书留的通用位,场景里目前没有。 */
const RIGID_PROFILE: Record<string, { amp: number; omega: number }> = {
  // 桅:泊船随水轻摆,幅度必须小 —— 桅是长杆,1° 在桅顶就是十几厘米
  mast_fold: { amp: THREE.MathUtils.degToRad(0.9), omega: (Math.PI * 2) / 5.5 },
  // 橹:摇橹是绕**竖直轴**的横向划水(实测 axis=0,0,1),不是上下扳
  oar: { amp: THREE.MathUtils.degToRad(13), omega: (Math.PI * 2) / 4.6 },
  // 舵:泊船几乎不操舵,只做极缓的微摆
  rudder: { amp: THREE.MathUtils.degToRad(3.5), omega: (Math.PI * 2) / 7.4 },
  rotate: { amp: THREE.MathUtils.degToRad(18), omega: (Math.PI * 2) / 6.0 },
  // 整船横摇。打在**船壳**上,一件带动全船(见文件头"船体轻摇")。
  //
  // 2.0° 这个幅度是**按船的主尺度算出来再选的**,不是调到看着顺眼:
  //
  //   半宽 1.55m → 舷顶起伏 = 1.55·sin2° = **5.4cm**
  //   桅顶离轴心约 7.4m → 横向   = 7.4·sin2° = **26cm**
  //
  // 同一条曲线,舷侧几乎察觉不到、桅顶却明显 —— 这正是"轻摇"该有的
  // 样子:船身在动,但不喧宾夺主。再往上到 4° 舷顶就是 10.8cm,
  // 一条泊着的漕船晃成这样是风浪,不是"水在动"。
  //
  // 周期 6.5s(ω = 2π/6.5),落在本表其余各档 4.6~7.4s 的同一族里。
  // 真船的横摇周期其实更短(1~3s),这里取慢:它要读成**河面在起伏**,
  // 而不是船自己在抖。
  hull_rock: { amp: THREE.MathUtils.degToRad(2.0), omega: (Math.PI * 2) / 6.5 },
};

/**
 * 顶点风动的类别。
 *
 * `ampK` 是**位移幅度相对布面自身高度的比例**,不是一个固定米数。
 * 理由是量出来的:场景里的布件尺寸差 12 倍 ——
 * 幌子高 1.075 米,彩楼欢门布帘高 2.9 米,茶肆雨篷高 2.9 米、长 12.3 米。
 * 早先给所有布件同一个 0.20 米,结果
 * (`tools/perf/once/flex_scale.mjs`):
 *   幌子  位移 / 面内最短边 = **45%** —— 扯得像折叠,不是飘;
 *   布帘  7~10%、雨篷 12% —— 又偏轻。
 * 同一个数不可能同时对。真实布面在气流里的摆幅本来就与布的**自由边长**
 * 成正比(旗越大摆得越远),所以按高度取比例既治好了尺寸错配,
 * 也让这条曲线有个物理出处,而不是"调到好看为止"。
 *
 * 取 0.12:大约是布面被吹到能看出飘、又还没到"破"的量。
 *
 * ## 改完之后实测(tools/perf/once/flex_motion.mjs)
 *
 * 工具取**各自类别的半周期**两帧(风 +1.85s、柳 +3.75s),即该件一个周期内的
 * 最大变化;三块静止参照区在两帧里逐像素为 0,证明量具可信。
 * 变化>6 亮度的像素占比:
 *   willow_000/001_leaf   27.1% / 31.9%   柳枝由"几乎不动"变成明显可见
 *   banner_012/014/015    13.8% / 6.9% / 10.6%
 *   cel_e00_cloth         11.0%
 *   shop_e0_1_cha_awning   7.9%
 * 无一被标为"扯成折叠"(最大 0.293,阈值 0.40)。
 *
 * ⚠️ 但**看得见运动 ≠ 看得清形状**:幌子实测在动,可在 4× 放大图里仍几乎
 *    融进背后墙面 —— 它是接近白的低对比布片,而整个场景压着一层白雾。
 *    那是调色/雾的问题,不是幅度的问题,别拿它来加幅度。
 */
const FLEX_PROFILE: Record<string, { ampK: number; ampMin: number; ampMax: number; omega: number; vert: number }> = {
  // 布幌布篷:快、飘、偏水平
  wind: { ampK: 0.12, ampMin: 0.05, ampMax: 0.40, omega: 2.2, vert: 0.30 },
  // 柳条:慢、柔、带下垂。
  // 柳树冠幅 5~7 米,若也按 12% 算是 0.7 米,对一棵柳树是狂风;
  // 而且它们尺寸本来就齐(5~7 米),不需要按尺寸缩放。固定 0.30 米,
  // 约等于冠幅的 5%,是一阵能看见、但不喧宾夺主的风。
  sway: { ampK: 0, ampMin: 0.30, ampMax: 0.30, omega: 0.95, vert: 0.45 },
};

const RIGID_ANIMS = new Set(Object.keys(RIGID_PROFILE));
const FLEX_ANIMS = new Set(Object.keys(FLEX_PROFILE));

/**
 * 风的世界方向。斜着吹过河面 —— 与河岸成角比顺着河轴更看得出层次。
 *
 * ⚠️ **导出给 `ParticleFx` 的炊烟用。** 两者必须是同一个向量:
 *    柳枝往北飘、炊烟往东倒的话,不看不知道、一看出戏。
 *    这个耦合**不能靠"两处都写 0.78/−0.63"来维持** —— 改一处忘另一处
 *    不会报错,只会让两套风悄悄分家,而分家之后各自看着都正常。
 */
export const WIND_WORLD = new THREE.Vector3(0.78, 0, -0.63).normalize();

export interface PropsRuntime {
  mounted: true;
  /** 真的被驱动起来的刚体件数(按类别) */
  rigid: Record<string, number>;
  /** 真的被驱动起来的风动件数(按类别) */
  flex: Record<string, number>;
  /** 权重是 Blender 写的,还是这里按包围盒推的 */
  flexWeightSource: { authored: number; derived: number };
  /** 被跳过的东西与**原因** —— 计数不为零不等于出错,但必须看得见 */
  skipped: Record<string, number>;
  wind: [number, number, number];
}

/**
 * 一条船的摇晃读数。给探针用。
 *
 * `childXyz` 取的是一件**自身没有任何动画**的部件(舱篷/肋骨/属具),
 * 这是整个读数里最关键的一处设计:
 *
 *   它自己不动,所以它**动了**只可能有一个原因 —— 父级(船壳)在动,
 *   且 three 的父子链把它带上了。
 *
 * 换句话说这个读数直接验的是"整船轻摇"这个机制本身,而不是"某个数
 * 写对了"。若改成读桅(它本来就有 0.9° 属于它自己的摆动),那桅在动
 * 这件事**在船壳完全没摇的情况下也成立**,读数就是无效的 ——
 * 这正是 memory 里第 31 条那个错误(拿一个部件代表整帧)。
 *
 * 同时它在反面也是判据:上岸船(`qm_beached=1`)的同一个读数
 * **必须一步不动**。
 */
export interface BoatReading {
  id: string;
  /**
   * 船壳当前横摇角(度)。正负号只是相位,不代表左右。
   *
   * `null` = 这条船**没有被驱动**(被 `qm_beached` 挡下了,没进刚体表)。
   * 刻意不报 0:0 读作"量到了,此刻正在零位",与"根本没摇它"是两回事,
   * 而这两种状态在截图里完全一样 —— 本项目吃过的"没量到 ≠ 量到 0"。
   */
  rockDeg: number | null;
  /** 见证件名 —— 船上某个**不带自己动画**的部件。见 Witness。 */
  child: string;
  /**
   * 见证件的**材质点**世界坐标(几何包围盒中心),不是它的原点。
   *
   * ⚠️ 用原点会量出恒等于 0 的读数:船部件的原点普遍落在船壳锚点上,
   *    而锚点就是横摇的轴心 —— 旋转的不动点。这么量过一次,
   *    5 条船全是 0,同批样本的角度极差却有 1.1~1.8°。
   */
  childXyz: [number, number, number];
  /**
   * 见证件到横摇**轴线**的垂直距离(m) —— 绕轴转动的真力臂。
   *
   * 刚体挂接下它**恒定**,而位移应等于 `2·rPerp·sin(Δθ/2)`。
   * 探针拿这两条核对"船壳转了,船上的东西真的跟着转了";
   * 轴心/轴向若标错了,力臂跟着错,这条也核不上 —— 它同时是轴线的判据。
   */
  rPerp: number;
}

export interface PropsAnim {
  update(worldTime: number): void;
  readonly runtime: PropsRuntime;
  /** 按需算的船只摇晃快照。**不进每帧路径** —— 别在 update 里调它。 */
  boatSnapshot(): BoatReading[];
}

interface Rigid {
  obj: THREE.Object3D;
  rest: THREE.Matrix4;
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  amp: number;
  omega: number;
  phase: number;
  /** 上一帧真正用过的角度(弧度)。给 boatSnapshot 读,省得反解四元数。 */
  lastAngle: number;
  /** 只有 hull_rock 有:船上挑出来那个"被船壳带走"的见证件。见 pickWitness。 */
  witness?: Witness;
}

/**
 * 船体横摇的见证件 —— 船上某个**不带自己动画**的部件,用来在网页侧
 * 核对"船壳转了,船上的东西真的跟着转了"。
 *
 * 为什么不能随手拿 `obj.children[0]`,也不能拿它的 `getWorldPosition()`:
 *
 *   1. **原点常常落在旋转轴上**。船部件的对象原点普遍落在船壳的锚点上
 *      (几何体自己带偏移),而那个锚点**就是**横摇的轴心。旋转的不动点
 *      位移恒为 0 —— 量出来是"船没动",而船动得好好的。实测过一次:
 *      5 条船全部读数 0,同批样本里的角度极差却有 1.1~1.8°。
 *   2. **力臂要量到轴线,不是量到轴心点**。绕轴转动时,位移来自点在
 *      **垂直于轴**那个平面里的分量;沿轴向的分量再大也一步不走。
 *      实测里 `cover` 离轴心 2.16 m 却只走 8.6 mm,`fit` 离轴心 0.84 m
 *      反而走 10.6 mm —— 因为前者 2.16 m 大多沿着艏向。
 *      真力臂:`cover` 0.686 m,`fit` 0.840 m,大小关系正好反过来。
 */
interface Witness {
  obj: THREE.Mesh;
  /** 几何包围盒中心,在**见证件自己的局部空间**里的位置。装载时算一次。 */
  local: THREE.Vector3;
  /**
   * 它到横摇**轴线**的垂直距离(m)。绕轴转动的真力臂。
   * 刚体挂接下这个量恒定 —— 探针拿它当"是不是真的刚体"的判据。
   */
  rPerp: number;
}
interface Flex { obj: THREE.Object3D; uniforms: Record<string, THREE.IUniform>; }

/** 名字 → 稳定相位。与 CharacterPool.tintRobe 同一个理由:全局 RNG 会让
 *  演员表一变、整条街的幌子相位全洗一遍,而"相位变了"在截图里根本看不出来。 */
function hashId(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function parseVec(s: unknown): THREE.Vector3 | null {
  if (typeof s !== 'string') return null;
  const p = s.split(',').map(Number);
  if (p.length !== 3 || !p.every((v) => Number.isFinite(v))) return null;
  return new THREE.Vector3(p[0], p[1], p[2]);
}

/**
 * Blender 的 Z 向上 → three 的 Y 向上:`(x, y, z) → (x, z, −y)`。
 *
 * ⚠️ **这一步是必须的,而且漏掉它不会报错。**
 *
 * `qm_pivot` / `qm_axis` 是 Blender 侧的**自定义属性**,经 `export_extras`
 * 原样搬进 `userData`。导出器的 `export_yup` 转的是**几何体**;
 * 自定义属性是一串不透明的元数据,导出器没有理由、也没有能力知道
 * 它里面装的是坐标 —— 所以它**原样搬运**。
 *
 * 实测(`tools/perf/once/rigid_pivot_check.mjs`,修复前后各跑一次):
 *   船_舵    pivot [1.6, −15.26, 1.07] ↔ 世界重心 [1.33, −0.10, **15.26**]
 *   船_舵005 pivot [12.1, −46.7, 2.39] ↔ 世界重心 [9.75, 1.16, **46.7**]
 *   船_人字桅 pivot [1.6, −6.65, 0.45] ↔ 世界重心 [1.6, 1, **10.12**]
 * x 完全相等、`pivot.y == −重心.z` 精确成立、`pivot.z` 落在件的顶端
 * (件高 2.37 时 1.07 − 1.185 ≈ −0.1,与重心 y 相符)。
 * 三个分量互相对上,这个映射就不是猜的了。
 *
 * 漏掉它的后果:**物体会绕着一个几十米外的点公转**。实测轴心到重心
 * 的距离中位数是 44.9 米、最大 74 米,17 件里 0 件的轴心落在自己的
 * 包围盒内。
 *
 * 而最阴的一点是它**不一定看得出来**:桅的摆幅只有 0.9°,绕一个
 * 偏了 6.7 米的点转,和绕正确的点转,静帧里几乎一样;
 * 橹的摆幅是 13°,同一个错误就把它甩到了河对岸。
 * 也就是说"桅看着没问题"从来不是证据 —— 是摆幅太小把它盖住了。
 *
 * 这个映射的行列式是 +1(绕 x 轴 −90°),是**真旋转**而非镜像,
 * 所以方向向量(轴)用同一个映射即可,不需要再翻符号。
 */
function toYUp(v: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.z, -v.y);
}

const QM_GLSL_DECL = `
attribute float qmFlex;
uniform float uQmTime;
uniform vec3  uQmWind;
uniform float uQmAmp;
uniform float uQmOmega;
uniform float uQmPhase;
uniform float uQmVert;
`;

/**
 * 位移在 `begin_vertex` 之后**追加**,而不是替换这个 include。
 * 替换就得把 three 自己的 `begin_vertex` 内容(含 `USE_ALPHAHASH` 分支)照抄一遍 ——
 * 抄的那份会随 three 升级悄悄过期。
 *
 * 权重平方:根部附近的点位移压得更死,梢头才有明显摆动。
 * 相位里的 `position.y` 让波沿高度**行进**,否则整片布是整体平移,
 * 看着像被人推着走而不是在风里颤。
 */
const QM_GLSL_BODY = `
{
  float w = qmFlex * qmFlex;
  float t = uQmTime * uQmOmega + uQmPhase;
  float s = sin(t + position.y * 0.55) * 0.72 + sin(t * 1.83 + 1.1) * 0.28;
  transformed += uQmWind * (uQmAmp * w * s);
  transformed.y += uQmAmp * uQmVert * w * sin(t * 1.31 + 0.7);
}
`;

/**
 * 从对象的 `qm_pivot` / `qm_axis` 标签算出**父级空间**的转动轴心与轴向。
 *
 * 抽出来是因为**有两个消费者**:`update()` 拿它做转动,`pickWitness` 拿它
 * 算力臂。两边必须用同一套换算 —— 各写一份的话,哪天 `toYUp` 或父级空间的
 * 口径改了,只有一边跟着改,力臂就会算在一个**不是转动轴**的轴上,
 * 于是"位移 = 2·力臂·sin(Δθ/2)"这条判据会以"挂接有问题"的面目报错,
 * 而真正错的是换算。这是本仓库最贵的一类缺陷。
 *
 * 返回 `'no-pivot'` / `'no-axis'` 而不是 null:调用方要按缺哪个分别计数,
 * 合成一个 null 会把两种标签缺失混成一条诊断。
 */
function rigidAxes(
  obj: THREE.Object3D,
): { pivot: THREE.Vector3; axis: THREE.Vector3 } | 'no-pivot' | 'no-axis' {
  const u = obj.userData as Record<string, unknown>;
  const pivotRaw = parseVec(u.qm_pivot);
  if (!pivotRaw) return 'no-pivot';
  const axisRaw = parseVec(u.qm_axis);
  if (!axisRaw || axisRaw.lengthSq() < 1e-12) return 'no-axis';

  // Blender 空间 → three 空间。见 toYUp 的注释:漏掉它不报错,只是绕着别处转。
  const pivot = toYUp(pivotRaw);
  const axis = toYUp(axisRaw).normalize();

  const parent = obj.parent;
  if (parent) {
    // 世界 → 父级空间。父级是刚体自己所在的坐标架,转动要在这里做。
    pivot.applyMatrix4(new THREE.Matrix4().copy(parent.matrixWorld).invert());
    const q = new THREE.Quaternion();
    parent.getWorldQuaternion(q);
    axis.applyQuaternion(q.invert()).normalize();
  }
  return { pivot, axis };
}

/**
 * 给一条整船横摇挑见证件:船上**不带自己动画**的部件里,真力臂最大的那个。
 *
 * 挑最大不是为了把读数做大,是为了**信噪比**:力臂越大,同样的横摇角走得
 * 越远,越不容易被浮点抖动和采样时机淹没。而"不带自己动画"是硬条件:
 * 桅/橹/舵都有自己的转动,它们的位移里混着自己的那一份,核不出
 * "被船壳带走"这件事 —— 实测里橹的真力臂会在 1.06 m 和 0.58 m 之间漂
 * 482 mm,那是它自己在转,不是挂接松了。
 *
 * 力臂取的是到**轴线**的垂直距离(理由见 Witness)。这里用的 `r.pivot` /
 * `r.axis` 就是 `update()` 里真正拿来转的那两个量 —— 拿别的量算力臂,
 * 核出来的就不是这套转动。反过来说,如果轴心/轴向标错了,这里的力臂
 * 会跟着错,于是"位移 = 2·力臂·sin(Δθ/2)"核不上 —— 这条判据同时也
 * 是轴心轴向的判据。
 */
function pickWitness(
  obj: THREE.Object3D,
  pivot: THREE.Vector3,
  axis: THREE.Vector3,
): Witness | undefined {
  const parent = obj.parent;
  const invParent = new THREE.Matrix4();
  if (parent) invParent.copy(parent.matrixWorld).invert();

  const best: Witness = { obj: null as unknown as THREE.Mesh, local: new THREE.Vector3(), rPerp: 0 };
  const center = new THREE.Vector3();
  const inParent = new THREE.Vector3();
  const radial = new THREE.Vector3();

  obj.traverse((d) => {
    const mesh = d as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    // 船壳自己不做见证 —— 它的材质点离轴心只有 ~0.10 m(力臂太小,
    // 而且"船壳自己动"正是待证的那件事,不能拿它当自己的证据)。
    // 一个静态子件都挑不出来时返回 undefined,那条船于是没有读数,
    // 探针会**少一条**而不通过 —— 比悄悄退化成一个小力臂读数好。
    if (mesh === obj) return;

    // 子树里只要有人带自己的动画,这个候选就不干净。
    for (let a: THREE.Object3D | null = mesh; a && a !== obj; a = a.parent) {
      const av = (a.userData as Record<string, unknown>).qm_anim;
      if (typeof av === 'string' && av !== '' && av !== 'none') return;
    }

    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb) return;
    bb.getCenter(center);

    mesh.updateWorldMatrix(true, false);
    inParent.copy(center).applyMatrix4(mesh.matrixWorld);
    if (parent) inParent.applyMatrix4(invParent);

    radial.copy(inParent).sub(pivot);
    const rPerp = radial
      .sub(axis.clone().multiplyScalar(radial.dot(axis)))
      .length();

    if (rPerp > best.rPerp) {
      best.obj = mesh;
      best.local.copy(center);
      best.rPerp = rPerp;
    }
  });

  return best.obj ? best : undefined;
}

export function createPropsAnim(scene: THREE.Scene): PropsAnim {
  const rigid: Rigid[] = [];
  const flex: Flex[] = [];
  const skipped: Record<string, number> = {};
  const rigidCount: Record<string, number> = {};
  const flexCount: Record<string, number> = {};
  let authoredWeight = 0;
  let derivedWeight = 0;

  const skip = (why: string): void => {
    skipped[why] = (skipped[why] || 0) + 1;
  };

  const seenGeom = new WeakSet<THREE.BufferGeometry>();
  const tmpMat = new THREE.Matrix4();
  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpScale = new THREE.Vector3();

  // 父级矩阵要在换算轴心之前是最新的。整棵场景一次就够。
  scene.updateMatrixWorld(true);

  scene.traverse((obj) => {
    const u = obj.userData as Record<string, unknown>;
    const anim = typeof u.qm_anim === 'string' ? u.qm_anim : '';
    if (!anim || anim === 'none') return;
    if (RIGID_ANIMS.has(anim) === false && FLEX_ANIMS.has(anim) === false) return;

    const mesh = obj as THREE.Mesh;

    // —— 刚体转动 ——
    if (RIGID_ANIMS.has(anim)) {
      if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
        // 蒙皮件的动作归骨骼。见文件头第 1 条:acc_punt_pole 被误打成 oar。
        skip('刚体·蒙皮件归骨骼管');
        return;
      }
      // 已拖上岸的船不摇。它架在垫木上,底下不是水。
      //
      // ⚠️ 这条闸是 `qm_beached` 的**第一个也是唯一一个消费者**。
      //    此前该标签打满了每一只船壳,却没有任何地方读它 ——
      //    "上岸的船不摇"当时成立,只是因为**所有**船都没有摇的标签,
      //    不是因为读了它。现在船壳真的会摇了,这条闸才第一次生效:
      //    没有它,`船_修`(z = 吃水 + 垫木高,整个架在岸上)会跟着
      //    水面一起摇,那是很显眼的假。
      //
      // 跳过数会进 `runtime.skipped`,探针看得见 —— 不是静默丢弃。
      if (Number(u.qm_beached) === 1) {
        skip('刚体·已拖上岸,不随水摇');
        return;
      }
      const axes = rigidAxes(obj);
      if (axes === 'no-pivot') { skip('刚体·缺 qm_pivot'); return; }
      if (axes === 'no-axis') { skip('刚体·缺 qm_axis'); return; }
      const { pivot, axis } = axes;
      const parent = obj.parent;
      if (parent) {
        // 世界 → 父级空间。父级是刚体自己所在的坐标架,转动要在这里做。
        tmpMat.copy(parent.matrixWorld).invert();
        pivot.applyMatrix4(tmpMat);
        parent.getWorldQuaternion(tmpQuat);
        axis.applyQuaternion(tmpQuat.invert()).normalize();
      }

      obj.updateMatrix();
      const prof = RIGID_PROFILE[anim];
      const entry: Rigid = {
        obj,
        rest: obj.matrix.clone(),
        pivot,
        axis,
        amp: prof.amp,
        omega: prof.omega,
        phase: (hashId(obj.name) % 10000) / 10000 * Math.PI * 2,
        lastAngle: 0,
      };
      if (anim === 'hull_rock') entry.witness = pickWitness(obj, pivot, axis);
      rigid.push(entry);
      rigidCount[anim] = (rigidCount[anim] || 0) + 1;
      return;
    }

    // —— 顶点风动 ——
    const prof = FLEX_PROFILE[anim];
    const geom = mesh.geometry;
    if (!geom) { skip('风动·没有几何体'); return; }

    // 布面的**自由长度** = 局部 Y 向尺寸。
    // 依据不是猜的:权重沿局部 Y 线性(实测 corr = −1.000,顶端 0、下缘 1),
    // 也就是说这块布就是朝局部 −Y 垂下来的,Y 向尺寸正是它从固定点
    // 到自由端的长度 —— 摆幅该跟这个长度成比例。
    geom.computeBoundingBox();
    const bb = geom.boundingBox!;
    const freeLen = bb.max.y - bb.min.y;
    const amp = THREE.MathUtils.clamp(prof.ampK * freeLen, prof.ampMin, prof.ampMax);

    const src = geom.getAttribute('color') as THREE.BufferAttribute | undefined;
    let weights: Float32Array;

    if (src) {
      weights = new Float32Array(src.count);
      for (let i = 0; i < src.count; i++) weights[i] = src.getX(i);
      authoredWeight++;
    } else {
      // 4 个对象被标了动态却没有权重。见文件头。
      //
      // `wind`(布篷)推一条包围盒斜坡:顶端固定、下缘自由 ——
      // 这正是 Blender 给另外 23 件布幌用的同一套规则,所以这不是另发明一套,
      // 是把漏掉的同一件事补上,并在诊断里标成 `derived` 与 authored 分开计数。
      //
      // `sway`(缆绳)**不推**。绷紧的系船缆本身不该自己晃;它的位移来自
      // 它挂在船上。硬加一层摆动是往物理上做减法。
      if (anim !== 'wind') { skip('风动·无权重属性(类别不适合推导)'); return; }
      if (freeLen < 0.05) { skip('风动·无权重且Y向过薄,推不出斜坡'); return; }
      const pos = geom.getAttribute('position');
      weights = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        weights[i] = THREE.MathUtils.clamp((bb.max.y - pos.getY(i)) / freeLen, 0, 1);
      }
      derivedWeight++;
    }

    // 权重只提一次。几何体可能被多个对象共用 —— 重复 setAttribute 会白跑,
    // 而且第二次读到的 color 已经被我们删掉了。
    if (!seenGeom.has(geom)) {
      seenGeom.add(geom);
      const m = mesh.material as THREE.MeshStandardMaterial;
      const attr = geom.getAttribute('color');
      if (attr && m && m.vertexColors === false) geom.deleteAttribute('color');
      else if (attr) skip('风动·材质开了 vertexColors,权重属性不敢删');
      geom.setAttribute('qmFlex', new THREE.Float32BufferAttribute(weights, 1));
      geom.computeBoundingSphere();   // 位移会顶出原包围球,不重算会被视锥体误剔除
    }

    // 材质**必须克隆**:同名的幌子共用一份材质,共用就共用一组 uniform,
    // 于是 16 面幌子同相摆动 —— 看着像整排被一只手推。克隆之后每个对象
    // 一组 uniform,程序对象仍然只有一份(注入的 GLSL 文本完全相同,
    // customProgramCacheKey 默认取 onBeforeCompile.toString(),所以命中同一缓存)。
    const base = mesh.material as THREE.MeshStandardMaterial;
    const material = base.clone();
    const uniforms: Record<string, THREE.IUniform> = {
      uQmTime: { value: 0 },
      // 风向要换算到**物体**空间:着色器里的 `transformed` 是局部坐标。
      // 每帧重算(见 update),这样父级转了风向也跟着转,不用假设父级静止。
      uQmWind: { value: new THREE.Vector3(0, 0, 1) },
      uQmAmp: { value: amp },
      uQmOmega: { value: prof.omega },
      uQmPhase: { value: (hashId(obj.name) % 10000) / 10000 * Math.PI * 2 },
      uQmVert: { value: prof.vert },
    };
    material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms) => {
      shader.vertexShader = QM_GLSL_DECL + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>' + QM_GLSL_BODY,
      );
      for (const [k, v] of Object.entries(uniforms)) shader.uniforms[k] = v;
    };
    material.needsUpdate = true;
    // 把这组 uniform 挂到材质上,**只为可观测**。
    //
    // 风动的位移发生在顶点着色器里,而着色器**不会把结果写回 CPU 端的
    // position 数组** —— 探针读 `geometry.attributes.position` 永远是原值。
    // 也就是说"幌子在不在动"这件事,从 CPU 侧根本量不到。
    // 唯一能验的是它的**输入**:时间有没有在推进、风向算得对不对。
    // 不给这个引用,风动这一路就只能靠肉眼看静帧,而静帧里
    // "在动"和"卡住"长得一模一样。
    material.userData.qmFlexUniforms = uniforms;
    mesh.material = material;

    flex.push({ obj, uniforms });
    flexCount[anim] = (flexCount[anim] || 0) + 1;
  });

  const runtime: PropsRuntime = {
    mounted: true,
    rigid: rigidCount,
    flex: flexCount,
    flexWeightSource: { authored: authoredWeight, derived: derivedWeight },
    skipped,
    wind: [WIND_WORLD.x, WIND_WORLD.y, WIND_WORLD.z],
  };

  // —— 给探针用的船只观测表 ——
  //
  // ⚠️ **从场景扫,不从 `rigid[]` 扫。** 这一条是这次差点写错的:
  //    上岸船被上面那道 `qm_beached` 闸跳过,它**根本不进 `rigid[]`**。
  //    若观测表从 `rigid[]` 出发去建,上岸船就**静默地没有读数** ——
  //    探针那边比不到它,"上岸船一步不动"那条断言于是自动成立,
  //    而它恰恰是这道闸唯一的反面判据。少一条读数比少一条船难发现得多。
  //
  //    所以判据取"场景里带 `qm_anim=hull_rock` 的对象",与它有没有被
  //    登记成刚体**无关**;角度则按需去 `rigid[]` 里配一次(配不到就是
  //    `null` —— 那正是"被闸挡住了"。不上报成 0:`0` 会被读成
  //    "量到了,没摇",而真相是"根本没在摇它")。
  //
  // 子件专门挑**自身没有任何动画**的(舱篷/肋骨/属具),理由见 BoatReading。
  const boatProbes: {
    id: string;
    witness: Witness;
    rigid: Rigid | null;
  }[] = [];
  scene.traverse((obj) => {
    if ((obj.userData as Record<string, unknown>).qm_anim !== 'hull_rock') return;
    const r = rigid.find((x) => x.obj === obj) ?? null;
    if (r) {
      // 会摇的船:见证件在 `update()` 里跟它一起登记,直接用。
      if (r.witness) boatProbes.push({ id: String(obj.name), witness: r.witness, rigid: r });
      return;
    }
    // 被 qm_beached 挡下的船**不进刚体表**,所以没人给它挑过见证件。
    // 但它照样要有读数:它是这道闸唯一的反面判据,而"没有读数"会让
    // "它一步没动"变成一句空话。
    //
    // 这里现挑一个,用的轴心/轴向与 `update()` 里那一套同源
    // (`rigidAxes`,同一份换算)—— 挑不出就直接不登记,由探针的
    // "6 条船都有读数"把那一条船**报出来**,而不是静默少一条。
    const axes = rigidAxes(obj);
    if (axes === 'no-pivot' || axes === 'no-axis') return;
    const w = pickWitness(obj, axes.pivot, axes.axis);
    if (w) boatProbes.push({ id: String(obj.name), witness: w, rigid: null });
  });

  const rot = new THREE.Matrix4();
  const tA = new THREE.Matrix4();
  const tB = new THREE.Matrix4();
  const tmpWorld = new THREE.Vector3();

  return {
    runtime,
    boatSnapshot(): BoatReading[] {
      // ⚠️ 这里读的是**上一帧渲染后**的矩阵。loop 在跑时它永远是最新的;
      //    loop 被 stop 掉的那一小段里会读数停滞 —— 所以探针要么在
      //    循环跑着的时候取,要么自己先确认帧号动过。别在 stop 之后
      //    拿它断言"没动",那会把"没渲染"读成"没摇晃"。
      return boatProbes.map((p) => {
        const w = p.witness;
        // 材质点 = 局部包围盒中心 → 世界。**不是** getWorldPosition():
        // 那给的是原点,而原点常常就压在横摇轴上(见 BoatReading.childXyz)。
        w.obj.updateWorldMatrix(true, false);
        tmpWorld.copy(w.local);
        w.obj.localToWorld(tmpWorld);
        return {
          id: p.id,
          // null = 这条船被 `qm_beached` 挡下了,压根没进刚体表。
          // **不报 0** —— 0 的意思是"量到了,此刻正好在零位"。
          rockDeg: p.rigid ? +(p.rigid.lastAngle * (180 / Math.PI)).toFixed(4) : null,
          child: String(w.obj.name),
          childXyz: [
            +tmpWorld.x.toFixed(5),
            +tmpWorld.y.toFixed(5),
            +tmpWorld.z.toFixed(5),
          ] as [number, number, number],
          rPerp: +w.rPerp.toFixed(4),
        };
      });
    },
    update(worldTime: number): void {
      // 刚体:每帧从 rest 重算 —— 见文件头"绝不累加"
      for (const r of rigid) {
        const angle = r.amp * Math.sin(worldTime * r.omega + r.phase);
        r.lastAngle = angle;
        rot.makeRotationAxis(r.axis, angle);
        rot.premultiply(tA.makeTranslation(r.pivot.x, r.pivot.y, r.pivot.z));
        rot.multiply(tB.makeTranslation(-r.pivot.x, -r.pivot.y, -r.pivot.z));
        rot.multiply(r.rest);
        // decompose 回 pos/quat/scale,让 three 自己合成矩阵。
        // 直接写 obj.matrix 就得手动置 matrixWorldNeedsUpdate,漏了就不动。
        rot.decompose(tmpPos, tmpQuat, tmpScale);
        r.obj.position.copy(tmpPos);
        r.obj.quaternion.copy(tmpQuat);
        r.obj.scale.copy(tmpScale);
      }

      // 风动:时间 + 物体空间风向
      for (const f of flex) {
        f.uniforms.uQmTime.value = worldTime;
        f.obj.updateWorldMatrix(true, false);
        // 用 decompose 而不是 setFromRotationMatrix:后者在带缩放的矩阵上会给出错的方向
        tmpMat.copy(f.obj.matrixWorld).decompose(tmpPos, tmpQuat, tmpScale);
        (f.uniforms.uQmWind.value as THREE.Vector3)
          .copy(WIND_WORLD)
          .applyQuaternion(tmpQuat.invert())
          .normalize();
      }
    },
  };
}
