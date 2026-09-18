/**
 * 氛围粒子:炊烟与飞鸟。
 *
 * 阶段 4 的最后一块内容。两样都属于**氛围性推断**,不是原卷上的东西 ——
 * 见下面「边界」一节,那段话必须原样进 `docs/08-已知局限与未做还原.md`。
 *
 * ## 为什么把运动写成"时刻的解析函数"而不是逐帧积分
 *
 * 粒子系统的常规写法是每帧 `v += a*dt; p += v*dt`。这里**不这么写**:
 * 每个烟团的位置是 `worldTime` 的闭式函数(`age = fract((t − 出生时刻)/寿命)`
 * 之后一路算下去),CPU 每帧只写一个 `uTime` uniform。
 *
 * 三条理由,一条比一条硬:
 *
 *   ① **不积分就不会漂移。** 逐帧积分的话,同样的世界时刻在不同帧率下
 *      会落到不同状态 —— 60Hz 与 165Hz 跑十秒之后烟的形状就不一样了。
 *      本项目的可复现判据是"同一输入 → 同一产出",粒子却是唯一一处
 *      "状态由历史决定"的地方。解析式把历史整个消掉了。
 *   ② **廉价。** 逐帧积分要遍历上百个粒子;解析式是 0 次 CPU 迭代。
 *      本文件写出来之前,`CharacterPool` 就因为每帧给 37 个人各打一条
 *      无 BVH 的地面射线,把一帧的 85%(22.6ms)吃掉过 —— 那是同一个教训。
 *   ③ **它落在 GPU 上,而 GPU 本来就闲着。** 顶点着色器算 ~100 个实例
 *      的 sin/cos 是噪声级的开销。
 *
 * ⚠️ **代价是 `uTime` 是 f32。** 在 t = 86400 秒(跑了整整一天)时
 *    相邻可表示值约 5ms,也就是烟团的相位误差约 5 毫秒 —— 看不出来。
 *    但没有实测过"跑一天之后烟还正常",所以这一句是**算出来的、不是量出来的**,
 *    别把它当成已验证的结论写进报告。
 *
 * ## 边界:哪一半是原卷里的,哪一半是我们加的
 *
 * **原卷里有的**:屋面、幌子、船、人、柳树、水纹。
 * **原卷里没有的**:本文件的全部内容。
 *
 * 做了一个可以复核的检查:把四段原卷(`public/original/section1..4.jpg`,
 * 每段 3840×732)的**上部天空带**拉对比度看了一遍 ——
 * 画面的上方是**空绢**,没有画出任何一只飞鸟;屋面也素净,没有炊烟。
 * (这一次检查的原始裁剪留在 `screenshots/ref/skyhi1.png` / `skyhi4.png`。)
 *
 * 所以:
 *   · **飞鸟**是为了"上方一大片死白的天空"加的 —— 这是构图上的补白,
 *     不是"还原了画里的鸟"。
 *   · **炊烟**是为了给静止的屋面一点生活气。宋代市井烧柴炊饭是常识,
 *     但**"这几间铺子当时在冒烟"是推断**,原卷不支持。
 *
 * 两者都**克制**:烟最浓处不透明度 0.40,鸟最多 9 只、直径不到半度视角。
 * 撤掉它们画面依然完整 —— 这是"氛围"该有的分量。
 *
 * ## 烟从哪里冒:按**规则从模型里找**,不是写死坐标
 *
 * 写死一串坐标的话,哪天 Blender 侧挪了一间铺子,烟就会**留在原地冒**
 * (冒在半空中),而且不报任何错。所以这里按标签找:
 *
 *   茶肆(`shop_e0_1_cha_roof`)、酒楼(`shop_e0_0_lou_roof`)—— 按 `qm_id` 规则找,
 *   找不到就**报警并少一处**,不是静默跳过;
 *   再加**西岸最靠近虹桥的两间**铺面(让两岸都有烟,而不是挤在一侧);
 *   再加**两艘客船**(`boat_ke_*_cover`)—— 客船载人,船上生火是常态。
 *
 * 找完之后每一条都要过一遍 `checkEmitters()`:发烟点必须落在那件东西的
 * 水平范围内、且不低于它的顶面。这条断言把"我猜了个坐标"变成"坐标对得上模型"。
 */

import * as THREE from 'three';
import { mulberry32 } from '../audio/rng';
import { FX_SEED } from '../data/seeds';
import { WIND_WORLD } from './propsAnim';
import type { QualityAware, QualityPlan } from '../core/quality';

// ---------------------------------------------------------------------------
// 常量:全部集中在这里,并且**每一个都要能说出理由**
// ---------------------------------------------------------------------------

// 随机种子 FX_SEED 不在这里定义,来自 `data/seeds.ts`(**全作品种子的唯一出口**)。
// 它由底数派生并错开,理由见那个文件:本文件原先自己写了一份字面量,
// 换了 Blender 种子重新构建时不会跟着变,而且不报错。

/**
 * 每个烟源发几团。总团数 = 本值 × 烟源数(high 档 8 处烟源 → 128 团)。
 *
 * ⚠️ 这里**没有**"总团数上限"这个常量。曾经有过一个 `SMOKE_MAX_PUFFS = 96`,
 *    它的注释还写着"取前 N 团时是每个烟源各去掉一些" —— 但全文件没有任何
 *    一处读它,团数从来就是 8 × 16 = 128。那句注释描述的机制**不存在**,
 *    而它读起来像是在解释一个已经实现了的行为,比没有注释更坏。
 *    "均匀铺开"这件事是真的,但成因不在这儿,在 `buildPuffList` 的**循环次序**
 *    (外层是轮次、内层是烟源)—— 见那里的注释。删掉常量,把理由挪到它真正
 *    生效的地方。
 */
const PUFFS_PER_EMITTER = 16;

/** 飞鸟总数上限(high 档)。9 只,分三四个高度层。 */
const BIRD_MAX = 9;

/**
 * 烟的一团从生到灭。这三个数是**观感参数**,靠截图调,不是物理量。
 * 上升到 2.6 米、活 7.5 秒 —— 一间 3 米檐高的铺面,烟从屋脊爬出六七米就不见了,
 * 远处看着是"一缕",不是"一股黑柱"。
 */
const PUFF_LIFE = 7.5;
const PUFF_RISE = 2.6;
const PUFF_R0 = 0.55;

/**
 * ⚠️ 这里**删掉了一个常量** `SMOKE_DRIFT = 0.5`,和上面那个 `SMOKE_MAX_PUFFS`
 *    是同一类毛病,而且更坏一档:
 *
 *    它的注释写着"烟的横向漂移速度(米每秒),方向就是 WIND_WORLD"、
 *    "0.5 m/s 约合二级轻风,烟斜着飘出去 2~3 米" —— 读起来像在解释一个
 *    已经实现了的东西,还附了物理解释。而**全文件没有任何一处读它**:
 *    真正的漂移在顶点着色器里,是 `uWind * (aDrift.z * age * aPuff.y)`,
 *    也就是 倍率(0.75~1.30) × 年龄(0~1) × 寿命(7.5 秒) ——
 *    **最大 9.75 米,不是 2~3 米**。
 *
 *    所以那句"物理解释"不是没用,是**错的**,而且方向和量级都错:
 *    它把"每秒多少米的速度"说成了这个量的形式,而这个量根本不是速度,
 *    是随年龄线性增长的一段位移。谁要是照它去调参,会以为调 0.5 就能让烟更飘,
 *    实际上什么都不会发生。
 *
 *    删掉的理由与 `SMOKE_MAX_PUFFS` 相同:一句描述不存在之物的注释,
 *    比没有注释更坏。真正该写的数是上面那三个因子,**已挪到着色器里
 *    写漂移的那一行旁边**(那里才是它生效的地方)。
 */

/**
 * 烟最浓处的不透明度。
 *
 * 刻意压得低 —— 这一项调大很容易让画面"有特效感",而需求里写的是
 * "克制,不掩盖模型细节"。
 *
 * ⚠️ 初值 0.26 改到 0.40,依据是 `tools/perf/once/fx_ab.mjs` 的实测,
 *    **不是"看着淡就加浓"**:
 *      虹桥机位 6 个时刻,烟 6/6 出现,435~581 px,峰值 Δ27~30、平均 Δ≈9;
 *      漕船机位 6/6,4664~4948 px,峰值 Δ39~51。
 *    峰值只有 30 上下意味着烟团最浓处也只把背景压暗 12%,在静帧里
 *    读起来更像一块脏污而不是一缕烟 —— 而同一支探针量到飞鸟的峰值是
 *    Δ157~175,**同一个画面里两者差了一个数量级**。
 *    按 `a × (背景 − 烟色)` 估算:背景约 230、烟色约 148(线性 0.30 转 sRGB),
 *    0.26 × 82 ≈ 21,与量到的单团峰值 27~30 对得上 —— 也就是说这个数
 *    **完全按设计值在走**,不是管线哪里泄漏了。所以该动的是设计值本身。
 *
 * ── 改成 0.40 之后的复量:预期错了一半,要改的是理解 ────────────────────
 * 当初写下的预期是"单团峰值约 33,叠加处约 60~80,平均约 13~16",并写明
 * **预期与实测对不上就说明理解有错**。复量结果:
 *
 *   峰值那半 **中了**:虹桥 α=0.40 峰值 34~38(预期单团 33);
 *   漕船 56~69(落在预期的叠加带 60~80 的下沿)。
 *   平均那半 **没中**:虹桥 9.0~11.5、漕船 11.8~12.5,低于预期的 13~16。
 *
 * 错在哪:我把"平均 Δ"也按 `×0.40/0.26 = ×1.54` 线性外推了,而**那个平均是
 * 在"变了的像素"这个集合上算的,集合本身随 α 长大** —— α 越高,越多边缘像素
 * 的 Δ 越过 8bit 地板而进入集合。集合在动,均值就不只是 α 的函数。
 * `tools/perf/once/smoke_alpha.mjs` 在**同一个冻结时刻内**改 uAlpha
 * (烟/鸟/相机/时间全都一样,唯一的变量是 α),把集合钉死后重量:
 *   漕船 Δ ∝ α^0.96(几乎就是线性),虹桥 Δ ∝ α^0.87;
 *   钉死集合之前,同一批数据算出来是 0.72 / 0.57 —— **那一大截差距就是
 *   集合在长大造成的**,不是像素本身的响应。
 * 所以"α 在画面上有多大效果"该看钉死集合的那个数。
 *
 * ── 三条**被证伪**的成因,别再把它们当解释 ──────────────────────────────
 * 虹桥(0.87)比漕船(0.96)更亚线性,这件事目前**没有解释**。试过并否掉的:
 *   ① AgX 在亮部压缩 —— 否。漕船亮背景桶 0.96、暗背景桶 0.97,**两桶一样**;
 *      而虹桥暗桶 0.87 与漕船暗桶 0.97 是同一个桶、不同的斜率。
 *   ② 多团叠加 1−∏(1−α) —— 否,方向相反:它预测**密**的更亚线性,
 *      而密的是漕船(5/8 个发射点入画),它反而更接近线性。
 *   ③ 贴 8bit 地板的像素占比 —— 否。两个机位几乎一样(α=0.20 时都在 45~50%,
 *      α=0.50 时都落到 20~35%),斜率却不同。
 * 三条都不是,而剩下的差异**在现有的两支探针里无从分辨**,就照实写着"未解释",
 * 不要再编第四条。真要查,下一步该做的是**在一个机位内**改变烟的屏幕尺寸或
 * 团数(而不是换机位),把几何从变量里摘出去。
 *
 * 0.40 这个值本身**保留**:最浓处把背景压暗的幅度,虹桥 34~38、漕船 56~69
 * (满量程 255),已经读得出是一缕烟而不是一块脏污;而同画面里飞鸟的峰值是
 * 163~175 —— 单像素上烟仍远低于鸟,但烟铺开的面积是 500~5400 px,鸟只有几十。
 */
const SMOKE_ALPHA = 0.40;

/**
 * 烟的颜色(**线性空间**)。
 *
 * ⚠️ 渲染器是 `AgXToneMapping` + `SRGBColorSpace`,所以这个三元组不是
 *    屏幕上看到的颜色 —— AgX 会把它压下去并去饱和。初值是按"比雾稍暗一点的
 *    暖灰"定的,最终值是**量出来的**:在 `?q=high` 下截烟团中心像素,
 *    与紧邻的天空比。别照着这份代码里的数去想象屏幕上的样子。
 */
const SMOKE_COLOR = new THREE.Color().setRGB(0.30, 0.285, 0.265, THREE.LinearSRGBColorSpace);

/**
 * 飞鸟的盘旋中心与尺度。中心压在河心、虹桥与街市之间 —— 那里是画面的纵深轴。
 *
 * ⚠️ **高度与半径是按实测改过的,不是拍脑袋定的。** 初值是「半径 55~125、
 *    高度 30~43」,理由是"鸟该在天上飞"。`tools/perf/once/fx_coverage.mjs`
 *    把整条航线对着五个景点机位投影之后,量出来的是:
 *
 *        机位      俯仰      画面顶端最高到      航线落在画面内的比例
 *        虹桥      22.9°     水平上方 2.1°       0/216
 *        漕船      12.6°     水平上方 12.4°      0/216
 *        茶肆      11.5°     水平上方 13.5°      1/216
 *        城门      12.6°     水平上方 12.4°      29/216
 *        街市       7.4°     水平上方 17.6°      3/216
 *
 *    五个机位**都是俯视**(7°~23°),画面顶端只到水平线上方 2°~18°;
 *    而 30~43 米高、55~125 米远的鸟,仰角是 19°~29° —— **全部在画面上沿之外**。
 *    `fx_ab.mjs` 在城门机位拍到了 Δ165/Δ174 的两只鸟,证明渲染本身没问题:
 *    问题从来不是"鸟太淡",而是**航线整个在取景之外**。
 *    (若当时照着"看不见鸟"去加浓加粗,会把一个正常工作的东西改坏,
 *     而真正的毛病原封不动。)
 *
 *    改法由上面那张表反推:低机位在水平线上方 12°~18° 才看得见,
 *    于是把航线压到 **9~18 米高**,距离压到 **45~80 米** ——
 *    仰角约 3°~16°,正好落进那条天空带里。近处的鸟仍会被高机位俯视看到。
 */
const BIRD_CENTER_X = 0;
const BIRD_CENTER_Z = 5;
const BIRD_R_MIN = 45;
const BIRD_R_MAX = 80;
const BIRD_Y_MIN = 9;
const BIRD_Y_MAX = 18;

// ---------------------------------------------------------------------------
// 程序化贴图
// ---------------------------------------------------------------------------

/**
 * 一团烟的贴图。**没有外部素材** —— 需求禁止生成式 API,而一张 128² 的
 * 柔斑用 canvas 2D 画出来是几行的事,还免了许可问题。
 *
 * 画法:先铺一圈大范围的柔边(保证方片四条边一定衰减到 0,否则会看到
 * **正方形的接缝** —— 这是粒子贴图最常见的翻车方式),再叠若干偏移的小柔斑
 * 把轮廓打散。最后用 `destination-in` 拿同一个柔边**收口**:叠加那一步
 * (`lighter`)会让斑块溢出到方片角上,不收口的话四角会亮起来。
 */
function makePuffTexture(seed: number): THREE.CanvasTexture {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  if (!g) throw new Error('拿不到 2D 上下文,炊烟贴图无法生成');

  const rnd = mulberry32(seed);
  const soft = (r: number): CanvasGradient => {
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.88)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.40)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    return gr;
  };

  g.fillStyle = soft(S / 2);
  g.fillRect(0, 0, S, S);

  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2;
    const d = (0.10 + rnd() * 0.26) * (S / 2);
    const x = S / 2 + Math.cos(a) * d;
    const y = S / 2 + Math.sin(a) * d;
    const r = (0.16 + rnd() * 0.22) * S;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${(0.10 + rnd() * 0.16).toFixed(3)})`);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  // 收口:把溢出到四角的部分按同一条柔边裁掉
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = soft(S / 2);
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(cv);
  // 只读它的 `.a`,色度不参与 —— 所以不做色彩空间转换。
  // 若哪天有人改成读 `.rgb`,这里要跟着改,否则会白得发灰。
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.name = 'fx_puff';
  return tex;
}

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------

/** 中心在原点的 2×2 方片。烟团用它在视图空间里做公告板。 */
function quadGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
  );
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// ---------------------------------------------------------------------------
// 着色器
// ---------------------------------------------------------------------------

/**
 * 烟的顶点着色器。
 *
 * ⚠️ `mvPosition` 这个名字**不能改**:`<fog_vertex>` 里写的就是
 *    `vFogDepth = - mvPosition.z;`。改名不会有任何编译错误(除非定义了
 *    USE_FOG),而雾一旦不生效,远处的烟会比周围亮一截 —— 静默的错。
 *
 * ⚠️ `fract` 而不是 `mod`。GLSL 的 `fract(x) = x - floor(x)`,对负数也落在
 *    [0,1);`mod(x,1.0)` 同样可以,但 `x - floor(x)` 少一次函数调用,
 *    而且对"出生时刻还没到"的团(`uTime < aPuff.x`)给出的也是同一个结果。
 */
const SMOKE_VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec4 aPuff;   // x=出生时刻 y=寿命 z=初始半径 w=上升高度
attribute vec3 aDrift;  // x=摆动相位 y=摆动幅度 z=风漂倍率

uniform float uTime;
uniform float uAlpha;
uniform vec3 uWind;
uniform vec3 uPerp;

varying float vAlpha;
varying vec2 vUv;

#include <fog_pars_vertex>

void main() {
  float age = fract( ( uTime - aPuff.x ) / aPuff.y );

  vec3 wp = aOrigin;
  // 上升用 ease-out:烟出锅时快、升高后慢,线性上升像被匀速拽上去的
  float ease = 1.0 - ( 1.0 - age ) * ( 1.0 - age );
  wp += vec3( 0.0, aPuff.w * ease, 0.0 );

  // 风漂与自身摆动。摆动幅度乘 age —— 刚出烟囱的一瞬不该左右晃
  //
  // ⚠️ 这一项的**量级要在这里说清**(曾经有个 SMOKE_DRIFT = 0.5 m/s
  //    的常量声称烟"飘出去 2~3 米",那是错的,见文件上方那段删除说明)。
  //    这里是 倍率 × 年龄 × 寿命:aDrift.z ∈ [0.75, 1.30](见 buildPuffList)、
  //    age ∈ [0,1]、aPuff.y = PUFF_LIFE = 7.5 秒,于是
  //      age=0.16(淡入刚完成) → 约 1.2~1.6 米
  //      age=0.40(开始淡出)   → 约 2.3~3.9 米
  //      age=1.00              → 最大 9.75 米(但此时 vAlpha 已为 0,不可见)
  //    可见的那一段大致落在 **1.2~5 米**的横漂上,而抬升只有 3.12 米封顶
  //    —— 所以这条烟整体是**斜着走**的,不是直着冒。
  //
  // ⚠️ 上面这几行里**一个反引号都不能有**。这条注释住在模板字面量里面,
  //    一对反引号会把着色器源码从中间截断:后面的中文被当成 JS 表达式去解析,
  //    而**报错位置指不到这里** —— tsc 报的是文件末尾的"未终止的模板字面量",
  //    rolldown 报的是"这里应该有个分号"。照着报错的位置去找是找不到的,
  //    只会去怀疑文件最后那几十行。踩过一次,记在这里。
  wp += uWind * ( aDrift.z * age * aPuff.y );
  wp += uPerp * ( sin( age * 3.4 + aDrift.x ) * aDrift.y * age );

  vec4 mvPosition = modelViewMatrix * vec4( wp, 1.0 );

  // 公告板:在**视图空间**里把方片撑开,于是它永远正对相机
  float r = aPuff.z * ( 0.55 + 1.9 * age );
  mvPosition.xy += position.xy * r;

  // 淡入快、淡出慢。直接线性淡出的话烟会"消失得很突然"
  vAlpha = uAlpha * smoothstep( 0.0, 0.16, age ) * ( 1.0 - smoothstep( 0.40, 1.0, age ) );
  vUv = uv;

  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
`;

const SMOKE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;

varying float vAlpha;
varying vec2 vUv;

#include <fog_pars_fragment>

void main() {
  float a = texture2D( uMap, vUv ).a * vAlpha;
  // 阈值丢弃:绝大多数片元是几乎全透明的方片边缘。不丢的话,
  // 128 张半透明方片会把填充率白白吃掉一大块,而画面上看不出区别。
  if ( a < 0.004 ) discard;

  gl_FragColor = vec4( uColor, a );

  // ⚠️ 这三行的顺序是照抄 three 的 meshbasic 片元着色器的,不能换。
  //    ShaderMaterial **不会自动**做色调映射与输出色彩空间转换 ——
  //    漏掉这两行的表现是"烟的颜色和周围对不上",而没有任何报错。
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * 鸟的顶点着色器。位置、朝向、拍翅**全部按时刻解析算**。
 *
 * 朝向由圆周运动的切向给出:位置 `(cos, ·, sin)·R` 求导得切向
 * `(−sin, ·, cos)`。所以局部 +Z 映射到切向、+X 映射到半径方向,
 * 鸟永远头朝飞行的方向 —— 不需要存任何"上一帧的位置"。
 */
const BIRD_VERT = /* glsl */ `
attribute vec4 aOrbit;  // x=相位 y=半径 z=高度 w=角速度
attribute vec3 aWing;   // x=拍翅频率 y=拍翅幅度 z=拍翅相位
attribute float aBob;   // 上下起伏的相位

uniform float uTime;
uniform vec2 uCenter;
uniform float uBobAmp;

varying vec3 vTint;

#include <fog_pars_vertex>

void main() {
  float ang = aOrbit.x + uTime * aOrbit.w;

  vec3 wp;
  wp.x = uCenter.x + cos( ang ) * aOrbit.y;
  wp.z = uCenter.y + sin( ang ) * aOrbit.y;
  wp.y = aOrbit.z + sin( uTime * 0.35 + aBob ) * uBobAmp;

  // 切向(飞行方向)与半径方向(翼展方向)
  vec3 fwd = vec3( -sin( ang ), 0.0, cos( ang ) );
  vec3 right = vec3( cos( ang ), 0.0, sin( ang ) );

  // 拍翅:绕局部 Z 轴(飞行方向)转。鼻尖与尾的 x 都是 0,转不动,
  // 只有翼尖在动 —— 正是"拍翅膀"该有的样子
  float flap = aWing.y * sin( uTime * aWing.x + aWing.z );
  float cf = cos( flap );
  float sf = sin( flap );
  vec3 local = vec3( position.x * cf, position.x * sf + position.y, position.z );

  wp += right * local.x + vec3( 0.0, 1.0, 0.0 ) * local.y + fwd * local.z;

  vec4 mvPosition = modelViewMatrix * vec4( wp, 1.0 );
  vTint = vec3( 1.0 );

  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
`;

const BIRD_FRAG = /* glsl */ `
uniform vec3 uColor;

varying vec3 vTint;

#include <fog_pars_fragment>

void main() {
  gl_FragColor = vec4( uColor * vTint, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// ---------------------------------------------------------------------------
// 烟源
// ---------------------------------------------------------------------------

interface SmokeEmitter {
  /** 从哪个对象上取的 —— 诊断要能把这个 id 原样印出来 */
  from: string;
  origin: THREE.Vector3;
  /** 该对象包围盒的水平中心。**与 `origin` 分开存**是自检能成立的前提 */
  cx: number;
  cz: number;
  /** 该对象的水平半宽/半深与顶面高度,供 `checkEmitters()` 断言 */
  hx: number;
  hz: number;
  topY: number;
}

interface Box3Like {
  box: THREE.Box3;
  id: string;
  x: number;
}

/**
 * 按规则从场景里找烟源。
 *
 * 规则是**先找候选集合、再断言想要的都在里面**,而不是写死一串 id:
 * 写死的话,Blender 侧改了命名,这里会静默地少冒一处烟。
 * 找不到就进 `warnings`,由 `diagnostics()` 露出来、由测试断言为零。
 */
function collectEmitters(
  scene: THREE.Object3D,
  warnings: string[],
): SmokeEmitter[] {
  const buildings: Box3Like[] = [];
  const boats: Box3Like[] = [];

  scene.traverse((o) => {
    const u = o.userData as { qm_kind?: string; qm_id?: string };
    const id = u.qm_id;
    if (!id) return;
    if (u.qm_kind !== 'building' && u.qm_kind !== 'boat') return;
    // ⚠️ 只认**末端件**:铺面是一组对象(roof/gable/frame/facade/plinth…),
    //    取到 facade 的话烟会从门脸上冒出来。
    const isRoof = u.qm_kind === 'building' && id.endsWith('_roof');
    const isCover = u.qm_kind === 'boat' && id.endsWith('_cover');
    if (!isRoof && !isCover) return;

    const box = new THREE.Box3().setFromObject(o);
    if (box.isEmpty()) return;
    const rec: Box3Like = { box, id, x: box.getCenter(new THREE.Vector3()).x };
    (isRoof ? buildings : boats).push(rec);
  });

  const pick = (list: Box3Like[], needle: string): Box3Like | null => {
    const hit = list.filter((b) => b.id.includes(needle));
    if (hit.length === 0) {
      warnings.push(`没有找到含「${needle}」的屋面,该处炊烟不会出现`);
      return null;
    }
    if (hit.length > 1) warnings.push(`含「${needle}」的屋面有 ${hit.length} 处,取 z 最小的一个`);
    hit.sort((a, b) => a.box.min.z - b.box.min.z);
    return hit[0]!;
  };

  const chosen: Box3Like[] = [];
  const push = (b: Box3Like | null): void => {
    if (b && !chosen.includes(b)) chosen.push(b);
  };

  // ① 茶肆与酒楼:这两处是有理由的 —— 一间卖茶、一间卖酒,都要烧火
  push(pick(buildings, '_cha_'));
  push(pick(buildings, '_lou_'));

  // ② 沿街铺开:铺面按 z 排序后**头尾各取一处**,再在 z 的三分点各取一处,
  //    且这两处**强制与上一处不同岸**。
  //
  //    ⚠️ 这一条是**量出来之后改的**。原来写的是"西岸最靠近虹桥的两间",
  //       理由是"让两岸都有烟"。`tools/perf/once/fx_coverage.mjs` 把六处烟源
  //       对着五个景点机位投影,量出的可见数是 **1 / 5 / 1 / 0 / 2**,
  //       而六处里有五处的 z 挤在 [−35, −20] 这一段(茶肆 −34.7、酒楼 −20.7、
  //       西岸 −23.1、两艘客船 −21.5 与 −35)。街区明明从 z≈−37 一直铺到 +46,
  //       烟却全冒在虹桥以北那一截 —— 于是"虹桥机位只看得到 1 处"。
  //       加浓能让已有的烟更显眼,**但加不出画面外的烟**。
  //
  //    ⚠️ 两岸交替是**显式写出来的**,不是"排序后等间隔取自然就会交替"。
  //       我原来就是在注释里这么写的 —— 然后按 8 处铺面 [0, 2, 5, 7] 取,
  //       拿到的是 w/w/w/e 三西一东,根本不对称。**规则里没写的事,
  //       不要用一句"自然就会"搪塞过去**:那种句子读起来像推理,其实是许愿,
  //       而且它会让人不去验算。
  const czOf = new Map<Box3Like, number>();
  for (const b of buildings) czOf.set(b, b.box.getCenter(new THREE.Vector3()).z);
  const cz = (b: Box3Like): number => czOf.get(b) ?? 0;
  const byZ = [...buildings].sort((a, b) => cz(a) - cz(b) || a.id.localeCompare(b.id));

  if (byZ.length >= 2) {
    const zLo = cz(byZ[0]!);
    const zHi = cz(byZ[byZ.length - 1]!);
    push(byZ[0]!);
    push(byZ[byZ.length - 1]!);
    let lastSide = Math.sign(byZ[0]!.x);
    for (const t of [zLo + (zHi - zLo) / 3, zLo + (2 * (zHi - zLo)) / 3]) {
      const rest = byZ.filter((b) => !chosen.includes(b));
      const otherBank = rest.filter((b) => Math.sign(b.x) !== lastSide);
      // 对岸没有可用的就退回全部 —— 宁可两岸不均,也不要少一处烟源
      const pool = otherBank.length ? otherBank : rest;
      pool.sort((a, b) => Math.abs(cz(a) - t) - Math.abs(cz(b) - t) || a.id.localeCompare(b.id));
      const p = pool[0];
      if (!p) break;
      push(p);
      lastSide = Math.sign(p.x);
    }
  } else {
    warnings.push(`可用的屋面只有 ${byZ.length} 处,炊烟无法沿街铺开`);
  }

  // ③ 两艘客船。`ke` = 客船(载人,船上生火是常态);
  //    漕船(`cao`)运粮,船工也在船上吃饭,但数量上克制一些 —— 只取客船。
  //
  //    一度只取一艘(理由:两艘的 z 是 −21.5 与 −35,挨得太近)。后来改回两艘:
  //    `fx_coverage.mjs` 量出"只取一艘"把漕船机位从 5/7 压到 4/7,而**船上的烟
  //    恰恰是那个机位最有看头的一处**(它就在水面上、正对相机)。既然 ② 已经把
  //    岸上的烟铺开到 z −37~+46,这两艘船就不再是"又堆厚北段",而是水上仅有的两处。
  //    教训是具体的:**"减少聚集"这个理由在铺开之后就不成立了**,不能因为
  //    当初写下的理由还留在注释里就继续照着它做。
  const ke = boats.filter((b) => b.id.includes('_ke_')).sort((a, b) => a.id.localeCompare(b.id));
  push(ke[0] ?? null);
  push(ke[1] ?? null);

  if (chosen.length < 5) {
    // 设计值是 7 处:茶肆 + 酒楼 + 沿街 4 处 + 客船 1 艘。但茶肆/酒楼与
    // 沿街选中的可能是同一间,去重之后会掉一到两处,所以门限压在 5 ——
    // 门限写 7 会让一个正常的结果每次都报缺陷,而**天天报的警告等于没警告**。
    warnings.push(`只找到 ${chosen.length} 处烟源(期望 ≥5 处),炊烟会比设计稀疏`);
  }

  return chosen.map((b) => {
    const c = b.box.getCenter(new THREE.Vector3());
    const size = b.box.getSize(new THREE.Vector3());
    return {
      from: b.id,
      // 冒烟点取**屋脊中点**:水平居中、高度贴在顶面上
      origin: new THREE.Vector3(c.x, b.box.max.y, c.z),
      cx: c.x,
      cz: c.z,
      hx: size.x / 2,
      hz: size.z / 2,
      topY: b.box.max.y,
    };
  });
}

/**
 * 烟源自检。
 *
 * 这一条把"我按规则猜了一个位置"变成"这个位置对得上模型":
 *   · 发烟点的 x/z 必须落在**那件东西**的水平范围内(容差 10%,
 *     因为屋脊中点未必是包围盒中心);
 *   · 发烟点不得低于它的顶面。
 *
 * ⚠️ 但**烟源是烟源自己的包围盒算出来的**,这两条断言因此是**自证**的 ——
 *    水平位置本来就是盒中心、高度本来就取 `max.y`,它们**不可能**不过。
 *    留着它们的理由是防将来有人改 `origin` 的算式(比如改成"屋檐外挑 0.5 米"),
 *    那时它们才会生效。真正外部的检查在 `tests/effects.mjs` 里:
 *    那里比对的是**渲染出来的像素**。
 *    自证的断言不能当证据 —— 这条在 `07_characters.py` 的角点法上已经吃过一次。
 */
function checkEmitters(list: SmokeEmitter[]): string[] {
  const bad: string[] = [];
  for (const e of list) {
    if (e.origin.y < e.topY - 1e-3) {
      bad.push(`${e.from}:发烟点 ${e.origin.y.toFixed(2)} 低于顶面 ${e.topY.toFixed(2)}`);
    }
    if (Math.abs(e.origin.x - e.cx) > e.hx) {
      bad.push(`${e.from}:发烟点 x=${e.origin.x.toFixed(2)} 超出件本身的半宽 ${e.hx.toFixed(2)}`);
    }
    if (Math.abs(e.origin.z - e.cz) > e.hz) {
      bad.push(`${e.from}:发烟点 z=${e.origin.z.toFixed(2)} 超出件本身的半深 ${e.hz.toFixed(2)}`);
    }
  }
  return bad;
}

/**
 * 把烟团排成一张**能等比缩减**的列表。
 *
 * ⚠️ 顺序有讲究:按"第 k 团 × 第 i 个烟源"的**外内**顺序铺,而不是
 *    "烟源在外、团在内"。后者在 mid 档(取前一半)会让**后两个烟源
 *    整块消失** —— 画面上是"船上的烟没了",而不是"烟淡了一半"。
 *    前者每个烟源各留一半,降级是均匀的。
 */
interface PuffSpec {
  origin: THREE.Vector3;
  birth: number;
  life: number;
  r0: number;
  rise: number;
  swayPhase: number;
  swayAmp: number;
  drift: number;
}

function buildPuffList(emitters: SmokeEmitter[]): PuffSpec[] {
  const rnd = mulberry32(FX_SEED);
  const out: PuffSpec[] = [];
  // ⚠️ **循环次序是外轮次、内烟源,不能换成外烟源、内轮次。**
  //    降画质时走的是 `instanceCount = round(总数 × ratio)`,也就是**截断数组尾部**。
  //    按现在这个次序,截到任何长度都刚好丢掉若干个完整的"轮次":
  //    8 处烟源截到 64 团 → 每处各剩 8 团;截到 70 → 前 6 处各 9 团、后 2 处各 8 团,
  //    **各烟源之间最多差 1 团**。换成另一种次序,截断会变成"前面几处烟源整整齐齐、
  //    后面几处整片消失",低画质下就会看到半边街市没有烟。
  for (let k = 0; k < PUFFS_PER_EMITTER; k++) {
    for (const e of emitters) {
      // 出生时刻均匀铺在寿命上 —— 否则同一烟源的团会**同生同灭**,
      // 看起来是"一坨一坨地闪",而不是连续的一缕
      const birth = (k / PUFFS_PER_EMITTER) * PUFF_LIFE;
      out.push({
        origin: e.origin,
        birth,
        life: PUFF_LIFE,
        r0: PUFF_R0 * (0.8 + rnd() * 0.45),
        rise: PUFF_RISE * (0.85 + rnd() * 0.35),
        swayPhase: rnd() * Math.PI * 2,
        swayAmp: 0.22 + rnd() * 0.30,
        drift: 0.75 + rnd() * 0.55,
      });
    }
  }
  return out;
}

function smokeGeometry(puffs: PuffSpec[]): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const base = quadGeometry();
  g.index = base.index;
  g.setAttribute('position', base.getAttribute('position'));
  g.setAttribute('uv', base.getAttribute('uv'));

  const n = puffs.length;
  const origin = new Float32Array(n * 3);
  const puff = new Float32Array(n * 4);
  const drift = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = puffs[i]!;
    origin.set([p.origin.x, p.origin.y, p.origin.z], i * 3);
    puff.set([p.birth, p.life, p.r0, p.rise], i * 4);
    drift.set([p.swayPhase, p.swayAmp, p.drift], i * 3);
  }
  g.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origin, 3));
  g.setAttribute('aPuff', new THREE.InstancedBufferAttribute(puff, 4));
  g.setAttribute('aDrift', new THREE.InstancedBufferAttribute(drift, 3));
  g.instanceCount = n;
  return g;
}

interface BirdSpec {
  phase: number;
  radius: number;
  height: number;
  speed: number;
  flapW: number;
  flapAmp: number;
  flapPhase: number;
  bob: number;
}

function buildBirds(): BirdSpec[] {
  const rnd = mulberry32(FX_SEED + 77);
  const out: BirdSpec[] = [];
  for (let i = 0; i < BIRD_MAX; i++) {
    out.push({
      phase: rnd() * Math.PI * 2,
      radius: BIRD_R_MIN + rnd() * (BIRD_R_MAX - BIRD_R_MIN),
      height: BIRD_Y_MIN + rnd() * (BIRD_Y_MAX - BIRD_Y_MIN),
      // 角速度**同向**且量级接近 —— 一群鸟朝同一侧转,不是各飞各的
      speed: 0.055 + rnd() * 0.045,
      flapW: 6.2 + rnd() * 3.4,
      flapAmp: 0.80 + rnd() * 0.40,
      flapPhase: rnd() * Math.PI * 2,
      bob: rnd() * Math.PI * 2,
    });
  }
  return out;
}

function birdGeometry(birds: BirdSpec[]): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const base = birdGeometryBase();
  g.index = base.index;
  g.setAttribute('position', base.getAttribute('position'));

  const n = birds.length;
  const orbit = new Float32Array(n * 4);
  const wing = new Float32Array(n * 3);
  const bob = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const b = birds[i]!;
    orbit.set([b.phase, b.radius, b.height, b.speed], i * 4);
    wing.set([b.flapW, b.flapAmp, b.flapPhase], i * 3);
    bob[i] = b.bob;
  }
  g.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orbit, 4));
  g.setAttribute('aWing', new THREE.InstancedBufferAttribute(wing, 3));
  g.setAttribute('aBob', new THREE.InstancedBufferAttribute(bob, 1));
  g.instanceCount = n;
  return g;
}

/**
 * 一只鸟:两块三角,共四个点。
 *
 * 局部坐标:**+Z 是飞行方向、+X 是翼展、+Y 是上**。
 *   鼻尖 (0, 0, +0.30) / 尾 (0, 0, −0.55) / 左右翼尖 (∓1, −0.22, −0.30)
 * 翼尖的 y = −0.22 是**静态下反角** —— 完全不反角的平板从正下方看是一条线,
 * 加上 12° 才有一点"鸟"的意思。拍翅由顶点着色器在它上面叠加。
 *
 * ⚠️ 所以这里只是**基础几何**;真正的 `InstancedBufferGeometry` 由
 *    `birdGeometry()` 在它上面挂实例属性装出来。两个函数分工不同,
 *    名字也刻意分开 —— 早先两者都叫 `birdGeometry`,重名会让后者顶掉前者,
 *    而 TypeScript 的函数声明重名**只在同一次编译里报错**,
 *    改到一半的文件很容易带着这个错跑起来。
 */
function birdGeometryBase(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        0, 0, 0.30,
        -1, -0.22, -0.30,
        0, 0, -0.55,
        1, -0.22, -0.30,
      ]),
      3,
    ),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

export interface ParticleFxRuntime {
  mounted: true;
  /** 当前真的在画的烟团数与飞鸟数(**不是**上限) */
  puffs: number;
  birds: number;
  /** 烟源明细。报告直接印这张表 —— 烟冒在哪儿必须看得见 */
  emitters: Array<{ from: string; at: [number, number, number] }>;
  /**
   * 飞鸟的盘旋空域(环形:中心 + 内外半径 + 高度带)。
   *
   * ⚠️ 露出来不是为了调试,是因为**"看不见鸟"有两个相反的成因**:
   *    航线定得太高太远、相机压根框不到天(要改航线),或者鸟没画出来
   *    (要改代码)。静帧分辨不了这两者 —— 把空域交给探针去和相机的视锥
   *    求交,才能说清是哪一个。数字写死在探针里做不到这件事:
   *    那样探针量的是它自己抄的那份常数,而不是着色器真正在用的那份。
   */
  birdBand: {
    center: [number, number];
    rMin: number;
    rMax: number;
    yMin: number;
    yMax: number;
  };
  /** 找烟源过程中的异常。非空即缺陷 */
  warnings: string[];
  /** 当前画质档位给的密度倍率 */
  effectsRatio: number;
  time: number;
}

/**
 * 覆盖位要盖哪一族粒子。`both` 是默认(与旧行为一致)。
 *
 * 之所以是两族而不是一个开关:烟与鸟在画面上都是"一小块变了色的像素",
 * 但**修法相反** —— 烟不显眼要挪烟源或加浓,鸟不显眼要改航线。
 * 混在一个开关里量,就只能靠猜来分配像素(见 `setEffectsOverride` 的注释)。
 */
export type EffectsFamily = 'both' | 'smoke' | 'birds';

export interface ParticleFx extends QualityAware {
  readonly object: THREE.Object3D;
  /** 唯一的每帧入口:`worldTime` 是循环里那个**唯一**的时间源。 */
  update(worldTime: number): void;
  /**
   * A/B 测量用:绕过画质档位强制设一个密度倍率。`null` = 撤销覆盖。
   *
   * 与 `RiverReflector.setReflectOverride` 是同一个理由、同一个形状:
   * "粒子到底有没有画出来、有多显眼"这件事只能**减掉它再比**才知道,
   * 而三档画质里 low 本来就是全关的 —— 拿 low 当对照组的话,
   * 两组会同时差着阴影、反射、分辨率,比出来的不是粒子的差异。
   * 这个开关只动粒子这一件事。
   *
   * ⚠️ `which` 存在的理由,是**归因**而不是调试方便:画面上一块变化的像素,
   *    既可能是烟也可能是鸟,而这两者的修法完全不同(烟要挪烟源,鸟要改航线)。
   *    只做"两族一起开关"的 A/B,就只能靠**别的线索**去猜那块像素属于谁 ——
   *    第一版正是拿"这块在地平线以上,所以是鸟"去猜的,而它把船机位那三团
   *    **升起在屋脊之上的烟**全判成了鸟(相机 2.9m、屋面 6.7~8.8m,烟一升
   *    就在地平线以上)。分开开关之后,归因就成了构造上的事实:
   *    这两帧之间**只有炊烟的 instanceCount 不一样**,变了的像素就是炊烟。
   *    不需要阈值,也不需要把烟团的几何常数在探针里再抄一份。
   */
  setEffectsOverride(ratio: number | null, which?: EffectsFamily): void;
  runtime(): ParticleFxRuntime;
  dispose(): void;
}

export function createParticleFx(scene: THREE.Object3D): ParticleFx {
  const warnings: string[] = [];
  const emitters = collectEmitters(scene, warnings);
  warnings.push(...checkEmitters(emitters));

  const puffs = buildPuffList(emitters);
  const birds = buildBirds();

  const puffTex = makePuffTexture(FX_SEED);

  const wind = WIND_WORLD.clone();
  // 与风垂直、水平的方向 —— 烟团的左右摆动沿它走。
  // `(x,z) → (−z, x)` 是水平面内的 90° 旋转。
  const perp = new THREE.Vector3(-wind.z, 0, wind.x).normalize();

  const smokeMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uAlpha: { value: SMOKE_ALPHA },
      uMap: { value: puffTex },
      uColor: { value: SMOKE_COLOR },
      uWind: { value: wind },
      uPerp: { value: perp },
      // 雾的 uniform 由 three 在 `fog:true` 时自动填,这里必须给个占位,
      // 否则第一帧(在 three 填进去之前)会读到 undefined
      fogColor: { value: new THREE.Color(0xffffff) },
      fogDensity: { value: 0 },
    },
    vertexShader: SMOKE_VERT,
    fragmentShader: SMOKE_FRAG,
    transparent: true,
    // 烟不写深度:团与团之间互相遮挡会在边缘留下硬边。
    // 代价是团之间的**先后顺序**由实例顺序决定,而顺序是固定的。
    // 当初的取舍是"不排序" —— 理由是团数多、每团又很淡,顺序错看不出来。
    // ⚠️ 但那个理由**是按 0.26 的不透明度写下的**,而现在已经加到 0.40:
    //    越浓的团越可能把排序痕迹显出来。所以这句话目前在待验状态,
    //    不是结论。要验就看烟团密集处有没有**横向的硬边** ——
    //    那正是公告板互相切出来的边,而不是烟该有的柔边。
    //    现有证据只有一张:`fx_ab_smoke_only.png`(虹桥机位)上没看到硬边,
    //    一张静帧不足以证明这件事。
    depthWrite: false,
    depthTest: true,
    fog: true,
    side: THREE.DoubleSide,
    name: 'fx_smoke',
  });

  const birdMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector2(BIRD_CENTER_X, BIRD_CENTER_Z) },
      uBobAmp: { value: 2.2 },
      uColor: { value: new THREE.Color().setRGB(0.045, 0.047, 0.055, THREE.LinearSRGBColorSpace) },
      fogColor: { value: new THREE.Color(0xffffff) },
      fogDensity: { value: 0 },
    },
    vertexShader: BIRD_VERT,
    fragmentShader: BIRD_FRAG,
    // 鸟是薄片,从下方看是背面 —— 必须双面,否则下半圈一只都看不见
    side: THREE.DoubleSide,
    fog: true,
    name: 'fx_birds',
  });

  const smoke = new THREE.Mesh(smokeGeometry(puffs), smokeMat);
  smoke.name = 'FxSmoke';
  const flock = new THREE.Mesh(birdGeometry(birds), birdMat);
  flock.name = 'FxBirds';

  // ⚠️ 关掉视锥裁剪,而不是去算包围球。
  //    烟的可视体积是"烟源 + 上升高度 + 风漂",鸟的是"整圈轨道";
  //    两者都算得出来,但**算错了不会报错**,只会整块消失。
  //    全场只有 2 个 draw call,裁剪省不下什么 —— 用不着拿"整块静默消失"
  //    的风险去换那点开销。
  smoke.frustumCulled = false;
  flock.frustumCulled = false;

  // 两者都不进水面反射:它们是**薄片**,映在水里会随视角闪成一片碎点,
  // 而反射 pass 是全场最贵的一笔。`qm_reflect = 0` 是给反射器的正式标签,
  // `layers.set(0)` 是**兜底** —— 反射层的分配是"扫场景时默认 enable 第 1 层",
  // 所以只要这两件东西是在那次扫描**之后**才进场的,`set(0)` 就够;
  // 而万一将来有人把创建顺序提前,标签也能拦住它。
  smoke.userData.qm_reflect = 0;
  flock.userData.qm_reflect = 0;
  smoke.layers.set(0);
  flock.layers.set(0);

  const object = new THREE.Group();
  object.name = 'ParticleFx';
  object.add(smoke, flock);

  let ratio = 1;
  /** A/B 覆盖位,**烟与鸟各一个**。`null` = 听档位的。 */
  let overrideSmoke: number | null = null;
  let overrideBirds: number | null = null;
  let shownPuffs = puffs.length;
  let shownBirds = birds.length;

  /**
   * 把"这一档要画多少"落到几何与显隐上。
   *
   * ⚠️ 这一段必须**幂等**:同一档位连调 10 次,结果与调 1 次相同。
   *    只写"计数"与"显隐"这两件事,不新建任何对象、不改任何属性缓冲 ——
   *    所以它天然幂等,也被 `tests/state_invariants.mjs` 的
   *    "切换前后 uuid 集合逐项相同"覆盖。
   *
   * ⚠️ 记的是**档位给的 ratio**,不是生效的 ratio。覆盖位是被
   *    `applyQuality` 之后的 `settle()` 叠加的 —— 若把覆盖值写进 `ratio`,
   *    撤销覆盖(`setEffectsOverride(null)`)之后就再也回不到档位本身的值,
   *    而这个错**没有任何表现**,只会在下一次切档时露出来。
   */
  const settle = (): void => {
    const rs = overrideSmoke === null ? ratio : overrideSmoke;
    const rb = overrideBirds === null ? ratio : overrideBirds;
    shownPuffs = Math.round(puffs.length * rs);
    shownBirds = Math.round(birds.length * rb);

    (smoke.geometry as THREE.InstancedBufferGeometry).instanceCount = shownPuffs;
    smoke.visible = shownPuffs > 0;
    (flock.geometry as THREE.InstancedBufferGeometry).instanceCount = shownBirds;
    flock.visible = shownBirds > 0;
  };

  const fx: ParticleFx = {
    object,

    update(worldTime: number): void {
      const t = smokeMat.uniforms.uTime as { value: number };
      t.value = worldTime;
      const bt = birdMat.uniforms.uTime as { value: number };
      bt.value = worldTime;
    },

    applyQuality(plan: QualityPlan): void {
      ratio = plan.effectsRatio;
      settle();
    },

    setEffectsOverride(r: number | null, which: EffectsFamily = 'both'): void {
      if (which !== 'birds') overrideSmoke = r;
      if (which !== 'smoke') overrideBirds = r;
      settle();
    },

    runtime(): ParticleFxRuntime {
      return {
        mounted: true,
        // 读的是**当前真的在画的数**,不是上限 —— 否则 low 档(ratio=0)
        // 的报告里就会写着一个和画面对不上的团数。
        // (这里刻意不写具体数字:上限改过两次,而每次都要回来改注释的那种
        //  数字,本来就不该写进注释里。)
        puffs: smoke.visible ? shownPuffs : 0,
        birds: flock.visible ? shownBirds : 0,
        emitters: emitters.map((e) => ({
          from: e.from,
          at: [e.origin.x, e.origin.y, e.origin.z] as [number, number, number],
        })),
        birdBand: {
          center: [BIRD_CENTER_X, BIRD_CENTER_Z],
          rMin: BIRD_R_MIN,
          rMax: BIRD_R_MAX,
          yMin: BIRD_Y_MIN,
          yMax: BIRD_Y_MAX,
        },
        warnings: [...warnings],
        effectsRatio: ratio,
        time: (smokeMat.uniforms.uTime as { value: number }).value,
      };
    },

    dispose(): void {
      object.remove(smoke, flock);
      smoke.geometry.dispose();
      flock.geometry.dispose();
      smokeMat.dispose();
      birdMat.dispose();
      puffTex.dispose();
    },
  };

  // 先按 high 初始化一次计数,再由 `quality.register()` 立刻按当前档位改。
  // 不初始化的话,`instanceCount` 停在 `Infinity`(three 的默认值),
  // 渲染器会把它夹到属性里的实例数 —— 看着"也对",但那是**碰巧对**。
  fx.applyQuality({
    quality: 'high',
    pixelRatio: 1,
    shadowMapSize: 4096,
    characterShadows: 16,
    reflector: { enabled: true, width: 1024, height: 512, everyNFrames: 1 },
    effectsRatio: 1,
  });

  return fx;
}
