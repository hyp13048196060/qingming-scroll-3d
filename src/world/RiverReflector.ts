/**
 * 汴河水面 —— 真反射 + 细波 + 暖散射。
 *
 * 为什么不用 `Water.js` / `Water2.js`
 * ----------------------------------
 * `Water.js` 是海面观感(蓝色、泡沫、大浪),汴河是内河浑水;`Water2.js` 的
 * 相对路径贴图在打包后会 404,而且它开两个 RT。所以继承 `Reflector` ——
 * 反射数学、斜切裁剪、投影矩阵全部复用它,只把**片元着色器**换掉。
 *
 * ── 三个必须写下来的坑 ──────────────────────────────────────────────
 *
 * ① **`Reflector` 把反射面法线写死成局部 +Z**:
 *      `normal.set(0, 0, 1); normal.applyMatrix4(rotationMatrix);`
 *    它不是从几何算的,也**不会报错**。而 Blender 导出的 `河道_水面` 是
 *    一个 XZ 平面上的水平网格、变换是单位阵(实测:`localZWorld = (0,0,1)`,
 *    几何自身法线 `geoNormalWorld = (0,1,0)`)。照搬就是把水面当成
 *    **竖直的镜子**去算反射。
 *
 *    ⚠️ **补旋转有两种补法,而且错的那一种查不出来 —— 这是本文件最贵的一课。**
 *
 *    只补**网格**:`reflector.rotation.x = -π/2`,局部 +Z 确实对上了世界 +Y,
 *    反射数学正确。但 `Reflector` 是个 `Mesh(geometry, material)`,
 *    网格的旋转**连几何一起转** —— 水面从躺着变成站着:
 *    实测世界包围盒 `[16.5, 600, 0.06]`、`worldY = [-300, 300]`,
 *    也就是说河道成了一道 **600 m 高的墙**。而 `localZWorld` 报的是
 *    `(0,1,0)`,**一切正常** —— 只查法线永远查不出这个错。
 *
 *    正确的补法是**两段相消**:几何烘 +π/2、网格转 −π/2。
 *      · 网格转 −π/2 让 `Reflector` 假设的局部 +Z = 世界 +Y;
 *      · 几何烘 +π/2 让几何自己的法线从局部 +Y 变成局部 +Z(与假设一致);
 *      · 合起来 `M · G' = R(−90°) · R(+90°) · G = G`,**水面停在原处**。
 *    实测修好后:`worldBBoxSize = [16.5, 0.06, 600]`、`worldY = [-0.06, 0]`、
 *    `geoNormalWorld = (0,1,0)` —— 与原始的 `河道_水面` 逐项一致。
 *
 *    这个形状仍然**完全是 Blender 按河岸样条放样的那一份**(只做了一次刚体
 *    旋转的副本),没有换成大平面、也没有在着色器里抠形状 ——
 *    计划书那条"几何在 Blender 里建面"的要求依然成立。
 *
 *    材质用 `DoubleSide`:相机贴到水面以下时不至于整片消失。
 *    查这个坑的探针是 `tools/perf/once/reflframe.mjs`,判据是**世界包围盒
 *    尺寸**,不是法线 —— 法线两个候选都对。
 *
 * ② **`options.shader` 是官方留的口子**(`const shader = options.shader ||
 *    Reflector.ReflectorShader`),所以不需要 `onBeforeCompile`,更不需要
 *    改 node_modules。原版片元里那句 `blendOverlay(base.rgb, color)` 是
 *    "镜子"的观感,内河水面不要它。
 *
 * ③ **反射 RT 没有雾。** 原版着色器完全不含雾,而场景用的是 `FogExp2` ——
 *    不补雾的话,河面会一路清晰到 600 m 外,而两岸早已雾掉,像一条贴在
 *    雾里的塑料带。这里自己实现 exp2 雾(three 的 fog chunk 需要
 *    `UniformsLib.fog` 合进 ShaderMaterial 的 uniforms,显式写反而更稳),
 *    每帧从 `scene.fog` 读,不跟 `skyTime` 的内部状态耦合。
 *
 * 观感目标:土黄偏暗的内河浑水,**不是海水**。反射里那片天是灰蓝色的,
 * 原样混进来河就蓝了,所以按 `uScatter` 把它往暖里拉(原始做法见计划书
 * 「refl = mix(refl, refl*uScatterColor*1.35, 0.45)」)。
 * 这个风险有专门的 A/B 断言兜底:`?reflect=0` vs `?reflect=1`,采样河心像素
 * 判色相落在 25°~45°(土黄)。
 */

import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import type { QualityAware, QualityPlan } from '../core/quality';
import { beginReflectionPass, endReflectionPass } from '../core/passStats';

/**
 * 进反射的图层。
 *
 * 只给 `qm_reflect !== 0` 的对象打开这一位;反射相机 `layers.set(这一位)`,
 * 于是它只看见这些对象。主相机默认看第 0 层,不受影响 ——
 * 注意是 `enable` 而不是 `set`,用 `set` 会把对象从第 0 层赶出去,整个场景
 * 会在主画面里消失。
 */
export const REFLECT_LAYER = 1;

export interface RiverReflectorDeps {
  /** GLB 里的 `河道_水面`。几何与变换都从它取,形状不在着色器里编。 */
  waterMesh: THREE.Mesh;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  /** 太阳。只取方向与颜色做高光,不做阴影。 */
  sun: THREE.DirectionalLight;
}

export interface RiverReflectorDiagnostics {
  enabled: boolean;
  /** 反射 RT 尺寸;关掉反射时是 [0,0]。 */
  rtSize: [number, number];
  everyNFrames: number;
  /** 累计真正渲染了反射的帧数 */
  reflectionPasses: number;
  /** 被跳过的帧数(每 N 帧一次的策略省下来的) */
  skippedPasses: number;
  /** 打进反射图层的对象数 */
  reflectLayerObjects: number;
  /** `qm_reflect=0` 被排除的对象数 */
  excludedObjects: number;
  /** 水面半宽(米)—— 深浅过渡用它,取自几何 bbox,不是写死的常数 */
  halfWidth: number;
  /** 当前用的浪高系数 */
  ripple: number;
}

export interface RiverReflector extends QualityAware {
  /** 挂进场景的根节点。 */
  readonly object: THREE.Object3D;
  /** 每帧调用。`worldTime` 来自 Loop,不要另取时钟。 */
  update(worldTime: number): void;
  readonly diagnostics: RiverReflectorDiagnostics;
  /** 关反射时显示的替代水面;A/B 与 low 档用它。 */
  readonly fallbackMaterial: THREE.Material;
  /**
   * 重扫一遍反射层。
   *
   * 构造时扫的那一次只覆盖**当时已经在场景里**的对象。人物是阶段 4 用
   * `SkeletonUtils.clone()` 在运行时加进来的,默认只在第 0 层 —— 不重扫的话
   * 他们在**主画面里正常、在反射里不存在**,而且不会有任何报错。
   * 所以每次新增一批角色之后都要调一次。
   */
  refreshReflectLayer(): void;
  /**
   * 强制下一帧重画反射。**图形上下文恢复后调一次。**
   *
   * 反射 RT 与 PMREM 不同:它每帧(或每 N 帧)都在被重画,所以**会自愈** ——
   * 但 mid 档是每 3 帧一次,恢复后最长有两帧水面上是那张刚建出来、
   * 内容还没写过的帧缓冲(多数驱动上读出来是黑的)。
   * 一行 `forceUpdate` 把这两帧去掉,没有别的代价。
   */
  invalidateReflection(): void;
  /**
   * A/B 测量用:绕过画质档位强制开/关反射。`null` = 撤销覆盖。
   *
   * 为什么需要一个**绕过档位**的开关:计划书里那条「水面会不会变成海水蓝」
   * 要用 A/B 采样河心像素来判,而 low 档本来就是关反射的。如果只能靠切档位来
   * 制造对照组,两组样本就会同时差着分辨率、阴影、景深 —— 比出来的不是反射的
   * 差异。所以覆盖位只动"开不开反射"这一件事。
   */
  setReflectOverride(on: boolean | null): void;
}

// ---------------------------------------------------------------------------
// 着色器
// ---------------------------------------------------------------------------

/**
 * 顶点着色器。比原版多一个 `vWorld` —— 波纹、深浅、雾都要世界坐标。
 *
 * ⚠️ `vUv = textureMatrix * vec4(position, 1.0)` 这一行**不能动**:
 *    它是反射贴图的投影采样坐标,由 `Reflector` 每帧算好塞进 `textureMatrix`。
 */
const VERT = /* glsl */ `
uniform mat4 textureMatrix;
varying vec4 vUv;
varying vec3 vWorld;

#include <common>
#include <logdepthbuf_pars_vertex>

void main() {
  vUv = textureMatrix * vec4( position, 1.0 );

  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;

  #include <logdepthbuf_vertex>
}
`;

/**
 * 片元着色器。
 *
 * 顺序是刻意的:先算水自身的颜色(深浅 + 菲涅耳混反射),再叠太阳高光,
 * 再上雾,最后才走三的 tonemapping 与色彩空间。中间所有混合都在线性空间里做。
 *
 * ⚠️ 「反射 RT 里装的是**未经 tonemapping 的线性值**」这一条是**查过源码**的,
 *    不是推测。`three/src/renderers/webgl/WebGLPrograms.js:177-187`:
 *
 *        let toneMapping = NoToneMapping;
 *        if ( material.toneMapped ) {
 *            if ( currentRenderTarget === null || currentRenderTarget.isXRRenderTarget === true ) {
 *                toneMapping = renderer.toneMapping;
 *            }
 *        }
 *
 *    —— 渲染进 RT 时**任何材质都不做色调映射**;同文件 213 行,
 *    RT 的输出色彩空间是 `ColorManagement.workingColorSpace`(线性),不是 sRGB。
 *    所以:采样回来的 `refl` 是线性、未映射的,直接与水体颜色线性混合,
 *    最后在**本着色器里只做一次** tonemapping 与色彩空间转换 —— 恰好对上。
 *    如果它反过来(RT 里已映射过),这里就会二次映射,画面会整体发灰发亮,
 *    而且看上去像"配色没调好",极难反查到这一行。
 *
 * 为什么不沿用原版的 `blendOverlay(base.rgb, color)`:那是**镜子**的观感,
 * 内河浑水不该是一面镜子。这里换成菲涅耳加权混合。
 */
const FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec3 color;              // Reflector 构造后会用 options.color 覆盖它
varying vec4 vUv;
varying vec3 vWorld;

uniform float uTime;
uniform vec3  uSunDir;           // 指向太阳的单位向量(世界空间)
uniform vec3  uSunColor;
uniform vec3  uDeep;             // 河心深水
uniform vec3  uShallow;          // 近岸浅滩
uniform vec3  uScatter;          // 散射色,用来压掉反射里的蓝
uniform float uHalfWidth;        // 河道半宽(米)
uniform float uRipple;           // 浪高系数,远处衰减到 0 免得闪
uniform float uReflMix;          // 反射占比:1 = 全开,0 = 只留水体与高光
uniform float uReflCompress;     // 反射的软压缩系数,见下面 refl 那一段的量纲说明
uniform float uSpecPower;
uniform float uSpecStrength;
uniform vec3  uFogColor;
uniform float uFogDensity;

#include <logdepthbuf_pars_fragment>

/**
 * 三组方向不同、频率不同的行波叠加,解析求梯度得法线。
 *
 * 方向刻意偏向 Z 轴:汴河沿 Z 流淌,波纹的波峰要**横着河走**。
 * 三组方向如果对称分布,水面会呈现方格状的"浴缸纹",一眼假。
 */
vec3 waterNormal( vec2 p, float t ) {
  vec2 d1 = normalize( vec2(  0.20, 1.00 ) );
  vec2 d2 = normalize( vec2(  0.55, 1.00 ) );
  vec2 d3 = normalize( vec2( -0.35, 1.00 ) );

  float k1 = 0.55, k2 = 1.30, k3 = 3.10;   // 波数
  float a1 = 0.055, a2 = 0.026, a3 = 0.009; // 振幅(米)
  float w1 = 0.85, w2 = 1.60, w3 = 3.20;    // 角频率

  vec2 g = vec2( 0.0 );
  g += a1 * k1 * cos( dot( p, d1 ) * k1 + t * w1 ) * d1;
  g += a2 * k2 * cos( dot( p, d2 ) * k2 + t * w2 ) * d2;
  g += a3 * k3 * cos( dot( p, d3 ) * k3 + t * w3 ) * d3;

  // h = Σ A sin(k·p + ωt) → ∇h = Σ A k cos(...) d,法线 = (-∂h/∂x, 1, -∂h/∂z)
  return normalize( vec3( -g.x * uRipple, 1.0, -g.y * uRipple ) );
}

void main() {
  #include <logdepthbuf_fragment>

  vec3 N = waterNormal( vWorld.xz, uTime );
  vec3 V = normalize( cameraPosition - vWorld );

  // 双面:从上往下看时几何法线是朝下的(见文件头 ①),所以显式翻正,
  // 水面从下方(比如相机掠过水面)看也不会突然全黑。
  if ( dot( N, V ) < 0.0 ) N = -N;

  // —— 反射 ——
  vec4 reflSample = texture2DProj( tDiffuse, vUv );
  vec3 refl = reflSample.rgb;

  // —— 量纲对齐:反射必须先压回"可比的量级" ——
  //
  // 这是阶段 4 花了最久才定位的一处,记清楚再动它。
  //
  // 反射 RT 是 HalfFloat、存的是**线性且未做色调映射**的辐射值,天空那一片
  // 可以远大于 1。而 uDeep/uShallow 是照 **sRGB 十六进制**作者化的:
  // #2a1f14 的线性值只有 0.023,而实测反射一侧的量级在 10 上下 ——
  // **差 400 倍**。
  //
  // 后果:菲涅耳在近处(俯视角约 37°)只有 0.021,看着"才 2%",
  // 可 2% × 10 = 0.2 远大于 98% × 0.023 = 0.023,近处水面因此成了
  // **天空的镜子**。剂量-反应实测(只拨 uReflMix):
  //     uReflMix=0    近处 H=33° S=0.61   土黄
  //     uReflMix=0.05 近处 H=28° S=0.30   饱和度掉一半 ← 权重才 0.1%
  //     uReflMix=1    近处 H=216° S=0.13  天蓝
  // **权重小不等于贡献小 —— 只有两边同量纲时"2%"才是 2%。**
  //
  // 修法不是调菲涅耳(那个公式是对的),也不是拧波纹(Σ(a·k)≈0.092,
  // 法线最多偏 5°,把 0.020 抬到 0.025,数量级根本不够),而是先把
  // 反射压到与基色可比的范围内。这里用最省的软压缩 r/(1+k·r):
  // 天空从 10 压到约 0.9,而本来就不亮的倒影(桥、船,量级 0.5)只被
  // 压掉三成 —— **保留暗部对比的同时削掉天空的支配地位**,这正是
  // 色调映射该干的事,只是 RT 里没有替我们做。
  //
  // ⚠️ 这是**量纲对齐,不是物理**。真实水面不会把白色船帆的倒影压暗,
  //    也不会把它染成土黄。本作品要的是"土黄、低饱和的内河",倒影是
  //    为这个观感服务的;这一点如实写在 docs/08-已知局限里。
  refl = refl / ( 1.0 + refl * uReflCompress );

  // 压蓝暖化。1.35 的上限是防它把暗部拉爆,0.45 是混合量。
  refl = mix( refl, refl * uScatter * 1.35, 0.45 );

  // —— 水体本身的颜色:近岸浅、河心深 ——
  float edge = clamp( abs( vWorld.x ) / uHalfWidth, 0.0, 1.0 );
  vec3 body = mix( uDeep, uShallow, pow( edge, 2.2 ) );

  // —— 菲涅耳:F0 = 0.02(水的折射率 1.33) ——
  float F0 = 0.02;
  float fres = F0 + ( 1.0 - F0 ) * pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 5.0 );

  // —— 阳光高光 ——
  vec3 H = normalize( uSunDir + V );
  float spec = pow( max( dot( N, H ), 0.0 ), uSpecPower ) * uSpecStrength;

  vec3 col = mix( body, refl, fres * uReflMix );
  col += uSunColor * spec;

  // —— FogExp2 ——
  //
  // three 对 ShaderMaterial 不会自动注入 fog uniforms(要自己把
  // UniformsLib.fog 合进来),所以这里显式实现。雾量 = 1 − exp(−(ρ·d)²),
  // 与 three 的 exp2 分支一致。
  float fogDist = length( cameraPosition - vWorld );
  float fogAmount = 1.0 - exp( - pow( uFogDensity * fogDist, 2.0 ) );
  col = mix( col, uFogColor, clamp( fogAmount, 0.0, 1.0 ) );

  gl_FragColor = vec4( col, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * `Reflector` 要的 shader 描述结构。
 *
 * 它**必须**提供 `tDiffuse` / `color` / `textureMatrix` 三个 uniform ——
 * `Reflector` 构造时直接写 `material.uniforms['tDiffuse'].value = ...`,
 * 少一个就是运行时 `Cannot set properties of undefined`。
 * 类型里写不出"必须含这三个键",所以这条只能靠注释和下面的 UNIFORMS 保证。
 */
interface ReflectorShaderShape {
  name: string;
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

/**
 * uniform 的**模板**,不是活的表。
 *
 * ⚠️ `Reflector` 里是 `UniformsUtils.clone(shader.uniforms)`,会深拷贝一份 ——
 *    所以运行时改 `UNIFORMS.uXxx.value` **不会有任何效果**,也没有报错。
 *    真正要改的是 `reflector.material.uniforms`(下面的 `u`)。
 *    反过来说,这也是它能同时给多条河用的原因:每条河各拿一份独立的拷贝。
 */
const UNIFORMS = {
  color: { value: null as THREE.Color | null },
  tDiffuse: { value: null as THREE.Texture | null },
  textureMatrix: { value: null as THREE.Matrix4 | null },

  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() },
  uSunColor: { value: new THREE.Color(0xfff2e0) },
  // 深水 / 浅滩 / 散射:取自计划书的配色,都是土黄褐色系,低饱和
  uDeep: { value: new THREE.Color(0x2a1f14) },
  uShallow: { value: new THREE.Color(0x8a7440) },
  uScatter: { value: new THREE.Color(0xa8863f) },
  uHalfWidth: { value: 8.25 },
  uRipple: { value: 1 },
  uReflMix: { value: 1 },
  // 反射软压缩系数。1.0 = 标准 Reinhard(把量级 10 的天空压到约 0.9),
  // 与渲染器自己施加的那条压缩曲线同族 —— 反射先过一遍同类的曲线,
  // 才能和**按显示域作者化**的基色放在一个 mix 里。
  //
  // 取值来自 `tools/perf/once/reflmix.mjs` 的剂量-反应实测(uReflMix 保持 1,
  // 只拨这一个值),连同逐档截图一起定的:
  //     0    H=216° S=0.18   天蓝,即修复前的样子
  //     0.5  H= 31° S=0.10   色相对了但太灰,卡在判据 S>0.15 之下
  //     1    H= 32° S=0.19   ← 采用
  //     2    H= 30° S=0.31   数字更好看,但见下
  //     4    H= 30° S=0.43
  //
  // ⚠️ **这里没有取数字最好的那个。** k=2 的 S=0.31 离判据门槛最远,
  //    可是逐档截图看下来,它把近处水面变成了一大片没有内容的平涂土黄
  //    —— 读起来是"泥滩"而不是"水";远处则被压成一片灰白,桥的倒影糊掉。
  //    k=1 的 S 只有 0.19,离门槛 0.04,但它保住了倒影里桥拱与栏杆格眼,
  //    **一眼能看出这是水面**,这才留住反射这个功能存在的理由。
  //
  //    判据是**下限,不是目标**:一个能靠"把水调成泥"来满足的判据,
  //    满足了也不等于做对了。这条留在这里,免得以后有人只看着 S 往上调。
  //    若将来某个机位真的需要更大余量,拨这个值即可,不必改判据。
  uReflCompress: { value: 1 },
  uSpecPower: { value: 48 },
  uSpecStrength: { value: 0.35 },
  uFogColor: { value: new THREE.Color(0xa49fa1) },
  uFogDensity: { value: 0.0035 },
};

/** 反射相机只看的层。`set` = 只留这一层(见文件头关于 enable/set 的说明)。 */
function scopeReflectionCamera(cam: THREE.Camera): void {
  cam.layers.set(REFLECT_LAYER);
}

export function createRiverReflector(deps: RiverReflectorDeps): RiverReflector {
  const { waterMesh, scene, renderer, sun } = deps;

  // —— 几何与变换 ——
  //
  // 复用水面网格的几何:形状是 Blender 按河岸样条放样的,**不在着色器里编**。
  // 变换不能直接抄 —— 抄了就是上面 ① 说的那个竖直镜子的坑。
  const src = waterMesh.geometry;
  src.computeBoundingBox();
  const bb = src.boundingBox ?? new THREE.Box3();
  // 半宽取 X 方向的一半(实测河道沿 Z 流、宽度落在 X 上,16.5 m)。
  // 取 max(0.5) 是防止退化几何把除法变成 inf。
  const halfWidth = Math.max(0.5, (bb.max.x - bb.min.x) * 0.5);

  // 几何烘 +90°(见文件头 ①)。
  //
  // 用 `clone()` 而不是原地改 `src`:那份几何是 GLB 里的共享资源,
  // 原地改会连带把探针看到的"原始水面网格"一起转掉 —— 那样
  // `reflframe.mjs` 的对照项就没了,而"对照项消失"比"对照项不对"更难发现。
  // `BufferGeometry.rotateX` 走的是 `applyMatrix4`,position 与 normal 都会
  // 被转(`normal` 用 normalMatrix),所以烘完法线也是对的。
  const surface = src.clone();
  surface.rotateX(Math.PI / 2);

  // `@types/three@0.186.0` 把 `ReflectorOptions.shader` 声明成 `object`,
  // 并且**没有** `ReflectorShader` 这个静态成员的声明(运行时它确实存在,
  // 见 Reflector.js 末尾)。所以这里不去引用那个静态成员 ——
  // 引用了就只有 `as unknown as` 一条路,那等于把类型关掉。
  // 自己声明一个结构类型,既过检查,也把"这个 shader 必须提供哪四项"写下来。
  const high: ReflectorShaderShape = {
    name: 'RiverReflectorShader',
    uniforms: UNIFORMS,
    vertexShader: VERT,
    fragmentShader: FRAG,
  };

  const reflector = new Reflector(surface, {
    shader: high,
    clipBias: 0.0035,
    textureWidth: 1024,
    textureHeight: 512,
    color: 0xffffff,
    // 0 = 关 MSAA。反射图只有 1024×512 且被细波打散,MSAA 的收益看不见,
    // 却要一份额外的多重采样缓冲。这个取舍在 docs/05 里如实写。
    multisample: 0,
  });
  // ⚠️ 这里是"两段相消"的后半段,与上面几何烘的 +90° 配对。
  //    **单独把这一行去掉**(或单独留着它而不烘几何)都会得到一道
  //    600 m 高的水墙,而且不报错。改这个数之前先读文件头 ①。
  reflector.rotation.x = -Math.PI / 2;
  reflector.name = 'RiverReflector';

  const mat = reflector.material as THREE.ShaderMaterial;
  mat.side = THREE.DoubleSide;
  // 材质要拿到雾与太阳的实时值,所以在外面持有 uniform 引用。
  const u = mat.uniforms;
  u.uHalfWidth!.value = halfWidth;

  // —— 反射相机限层 ——
  //
  // `getReflectionCamera` 是构造函数里赋的**实例属性**(不是原型方法),
  // 所以这里包一层是安全的:先拿原函数,再替换。
  const origGetCam = reflector.getReflectionCamera.bind(reflector);
  reflector.getReflectionCamera = (camera: THREE.Camera): THREE.Camera => {
    const cam = origGetCam(camera);
    scopeReflectionCamera(cam);
    return cam;
  };

  // —— 反射层的对象清点 ——
  //
  // ⚠️ **这里是"默认进、显式出",不是"打了标签才进"。两个独立的理由:**
  //
  // 1) **灯。** `WebGLRenderer.projectObject`(src/renderers/WebGLRenderer.js:1864)
  //    先算一次 `object.layers.test(camera.layers)`,不通过就整块跳过 ——
  //    而收集灯光正在那块里(`pushLight`)。所以反射相机一旦只认第 1 层,
  //    **第 0 层上的太阳和天光就全被滤掉**,反射 pass 会在"无光"状态下渲染:
  //    反射里是一片近乎全黑的世界。而水面反射的颜色主要来自天光,
  //    结果是河面又黑又脏 —— 不报错,只是难看。
  //
  // 2) **天。** 天空是 `Sky.js`(以及 `scene.background` 的 PMREM 环境)在
  //    **运行时**建的,**身上没有任何导出标签**。按"有标签才 enable"写,
  //    反射里同样没有天。
  //
  //    (顺带:`scene.background` 的 boxMesh / planeMesh 自己调了
  //     `enableAll()`(WebGLBackground.js:165/230),所以背景不依赖这段逻辑;
  //     但 `Sky.js` 那个网格是场景里的普通子节点,依赖。)
  //
  // `qm_reflect` 是 Blender 侧写的导出标签:`0` = 小物件,不进反射(省反射 pass)。
  // 于是规则是:**没被明确标成 0 的,都进反射层**。
  let reflectLayerObjects = 0;
  let excludedObjects = 0;
  const scanReflectLayer = (): void => {
    reflectLayerObjects = 0;
    excludedObjects = 0;
    scene.traverse((o) => {
      const r = (o.userData as { qm_reflect?: number }).qm_reflect;
      if (r === 0) {
        excludedObjects++;
        return;
      }
      o.layers.enable(REFLECT_LAYER);
      reflectLayerObjects++;
    });
    // 水面自己必须留在第 0 层 —— 否则它会反射自己(视觉上的无限递归)。
    // 上面那次遍历是按"默认进、显式出"写的,**任何**场景子节点都会被
    // enable 第 1 层,所以这里显式收口。`object` 由调用方加进场景,
    // 所以这一步也要跟着重扫走,不能只在构造时做一次。
    object.traverse((o) => o.layers.set(0));
  };

  // —— 关反射时的替代水面 ——
  //
  // 不沿用原 MeshStandardMaterial(它 roughness 0.16、没有贴图,看着像路面 ——
  // 那正是要做反射的原因),而是给一个更接近"哑光浑水"的材质:粗糙度高、
  // 带一点自发光似的浅褐色,至少有别于路面。它的观感明显不如反射版,
  // 这是**如实的设计取舍**:low 档与 A/B 对照组就用它,并且 A/B 报告里要写清。
  const fallbackMaterial = new THREE.MeshStandardMaterial({
    name: 'water_flat_low',
    color: 0x6b5a38,
    // ⚠️ 粗糙度必须接近 1,不能用"水看着光溜"那个直觉给的 0.42。
    //    MeshStandardMaterial 会吃 `scene.environment`(Sky.js 烘的 PMREM),
    //    0.42 的粗糙度意味着一瓣很窄的镜面 —— **反射天空盖过基色**,河又变成
    //    灰的。实测(`probe_water_color.mjs`):0.42 时中景 S=0.03,几乎无色相,
    //    报出来就是一片中性灰。抬到 0.95 后同一处回到土黄系。
    //    这与本文件片元里那段"量纲对齐"是**同一件事的两种表现**:
    //    亮的天空一旦进了反射项,不压下去就会盖过深色基色。
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  // 与反射体同一份几何、同一个旋转 —— 两个网格必须在**同一个世界位置**,
  // 否则 A/B 的两组图不只是"有没有反射"的差别,连水面位置都变了,
  // 那组对照就失去意义了。
  const flat = new THREE.Mesh(surface, fallbackMaterial);
  flat.rotation.x = -Math.PI / 2;
  flat.name = 'RiverFlatFallback';
  flat.visible = false;

  const object = new THREE.Group();
  object.name = 'RiverWater';
  object.add(reflector, flat);

  // 第一次扫描。放在 `object` 定义**之后**:定义处调会报 "Block-scoped
  // variable 'object' used before its declaration"。(这类顺序错误在有类型
  // 检查时是幸运的;同样的错写进着色器里就没有任何保护了 —— 那正是本文件
  // 反复强调 `local +Z` 那个坑的原因。)
  //
  // 两种调用顺序都成立:调用方若已经 `scene.add(object)`,这次遍历会连水面
  // 自己一起 enable 第 1 层,但 `scanReflectLayer` 末尾那句
  // `object.traverse(o => o.layers.set(0))` 会把它收回来;若还没 add,
  // 遍历压根碰不到它。也就是说"水面不反射自己"这条**不依赖调用顺序** ——
  // 依赖顺序的写法是迟早要出事的写法。
  scanReflectLayer();

  // 原始水面网格退场(它的几何还在被上面两个网格复用,只是不再渲染)
  waterMesh.visible = false;

  // —— 画质契约 ——
  let plan: QualityPlan['reflector'] = { enabled: true, width: 1024, height: 512, everyNFrames: 1 };
  let reflectionPasses = 0;
  let skippedPasses = 0;
  let frameCounter = 0;

  /**
   * A/B 覆盖位:`null` = 听画质档位,`true/false` = 强制。
   *
   * ⚠️ **覆盖位必须活在 `applyQuality` 内部,不能由外面调完之后再补一刀。**
   *    因为 `quality.ts` 是个 reconciler,切档、装配完成、`register` 各会推一次
   *    计划;外面补的那一刀会被下一次 `applyQuality` 悄悄冲掉 ——
   *    而 A/B 脚本的结果是"两组图看起来一样",很容易被当成"反射没效果"。
   */
  let override: boolean | null = null;
  const reflectionOn = (): boolean => override ?? plan.enabled;

  /**
   * RT 尺寸的**幂等**对齐:目标尺寸取自当前档位,而不是"和上一次比变了没变"。
   *
   * ⚠️ 这里返过一次工。"只在变了的时候 resize"这个写法有**两个**坑,
   *    实测都踩到了(读数见 docs/05 的 A/B 一节):
   *
   *   坑 1:**关着反射时跳过 resize,却已经把 `plan` 更新掉了** ——
   *        于是"变没变"下次永远答"没变",尺寸再也补不回去。
   *        实测 `?q=high&reflect=0`:plan 报 high(everyNFrames=1),
   *        RT 却停在 mid 的 512×256,两个档位的读数拼在同一行里。
   *
   *   坑 2:low 档的反射计划当时写的是 `{enabled:false, width:0, height:0}` ——
   *        "这一档用不上"被编码成了"尺寸是 0",而下游照它做算术,得到
   *        `max(2, 0) = 2`,也就是一张 **2×2** 的反射贴图。
   *        实测 `?q=low&reflect=1`:RT 2×2、而且每帧都在画(693 次),
   *        画面上是一块 4 像素的糊斑,不报任何错。
   *        ⚠️ 这个坑**修在 `quality.ts`**(那一档现在填真实尺寸),
   *        不在这里 —— 根因是"计划里存了个没有意义的数",
   *        在消费端加保护只是把症状盖住。
   *
   * 所以这里改成:只要反射开着,就把尺寸对齐到当前档位。
   * 下面那个 64 的下限是**保险丝**,不是修复:它只防"将来又有人往计划里
   * 塞个 0",真到那一步应该去改计划,而不是靠它兜住。
   */
  const applyRtSize = (): void => {
    const rt = reflector.getRenderTarget();
    const w = Math.max(64, plan.width);
    const h = Math.max(64, plan.height);
    if (rt.width !== w || rt.height !== h) {
      rt.setSize(w, h);
      // RT 换了尺寸,里面的内容是旧的 —— 强制下一次重画,免得第一帧
      // 显示的是上一档分辨率下的画面被拉伸。
      reflector.forceUpdate = true;
    }
  };

  /** 把"开/关"这一件事收敛到一处:一个开关,三个后果。 */
  const syncVisibility = (): void => {
    const on = reflectionOn();
    reflector.visible = on;
    flat.visible = !on;
    (u.uReflMix as { value: number }).value = on ? 1 : 0;
    if (on) {
      // 尺寸必须在**打开的时候**对齐,不能只在切档的时候对齐:
      // 覆盖位一开(或 low 档切回来),尺寸可能还是上一档留下来的。
      applyRtSize();
      // 关着的时候材质里还留着上一次的反射图(或者是空的),
      // 重新打开必须重画一帧,否则第一帧的水面是旧的。
      reflector.forceUpdate = true;
    }
  };

  // 每 N 帧一次的节流。包住的是 Reflector 自己的 onBeforeRender ——
  // 跳过 = 不重画 RT,材质继续采样上一次的结果。代价是反射最多滞后
  // N−1 帧(船从桥下过的时候能看出来),换来反射 pass 的开销除以 N。
  // 这个取舍写进 docs/05,不藏着。
  const origOnBefore = reflector.onBeforeRender;
  reflector.onBeforeRender = (r, s, c, geo, m, g) => {
    if (!reflectionOn()) return;
    if (plan.everyNFrames > 1 && frameCounter % plan.everyNFrames !== 0) {
      skippedPasses++;
      frameCounter++;
      return;
    }
    frameCounter++;
    reflectionPasses++;
    // 夹住这一趟,让性能探针能把反射的 drawcall / 三角面从总量里分出来。
    // 见 core/passStats.ts —— 没有这个夹子,"主 pass"这个数根本不存在。
    beginReflectionPass();
    try {
      origOnBefore.call(reflector, r, s, c, geo, m, g);
    } finally {
      // 用 finally:反射渲染中途抛错时若不配对,夹子会永久停在"进"上,
      // 之后每一帧的增量都会算到反射头上,报告全错。宁可少算也不要算错。
      endReflectionPass();
    }
  };

  const applyQuality = (p: QualityPlan): void => {
    // ⚠️ 这里**只记计划,不做副作用**。
    //    早先这里顺手 resize 了 RT,于是"档位""覆盖位""RT 实际尺寸"
    //    三份状态各自为政 —— 关着反射切档时 resize 被跳过、计划却已经
    //    往前走了,那个尺寸就永远补不回来。
    //    尺寸对齐是 `syncVisibility()` 的事(见上面 `applyRtSize`),
    //    因为**开/关是唯一能改变尺寸需求的事件**,而它必经那里。
    plan = { ...p.reflector };
    syncVisibility();
  };

  /**
   * A/B 覆盖。`null` 撤销覆盖,回到画质档位说了算。
   * 立刻生效一次,不用等下一次切档。
   */
  const setReflectOverride = (on: boolean | null): void => {
    override = on;
    syncVisibility();
  };

  const update = (worldTime: number): void => {
    (u.uTime as { value: number }).value = worldTime;

    // 太阳方向与颜色每帧同步 —— 时辰会变,太阳会走。
    const sunPos = sun.getWorldPosition(new THREE.Vector3());
    const sunTarget = sun.target.getWorldPosition(new THREE.Vector3());
    (u.uSunDir as { value: THREE.Vector3 }).value.copy(sunPos).sub(sunTarget).normalize();
    (u.uSunColor as { value: THREE.Color }).value
      .copy(sun.color)
      .multiplyScalar(Math.min(1, sun.intensity * 0.6));

    // 雾从场景实际值读,不跟 skyTime 内部状态耦合。
    const fog = scene.fog;
    if (fog && (fog as THREE.FogExp2).density !== undefined) {
      (u.uFogColor as { value: THREE.Color }).value.copy(fog.color);
      (u.uFogDensity as { value: number }).value = (fog as THREE.FogExp2).density;
    } else if (fog) {
      // 线性雾:用等效密度近似(远平面处雾量对齐),免得完全不雾。
      const f = fog as THREE.Fog;
      const d = f.far > 1 ? 1.2 / f.far : 0;
      (u.uFogColor as { value: THREE.Color }).value.copy(f.color);
      (u.uFogDensity as { value: number }).value = d;
    }
  };

  return {
    object,
    update,
    applyQuality,
    fallbackMaterial,
    refreshReflectLayer: scanReflectLayer,
    invalidateReflection(): void {
      reflector.forceUpdate = true;
    },
    setReflectOverride,
    /**
     * 诊断读数。**全部现场读取,不缓存** ——
     * 早先在 `quality.ts` 里踩过"缓存一个此刻还不存在的东西"的坑(见那个
     * 文件里 `collectSkinned` 的注释),这里同样的错不再犯第二遍。
     * 性能探针要的是"跑完这一轮之后的真实计数",缓存值会让报告说谎。
     */
    get diagnostics(): RiverReflectorDiagnostics {
      const rt = reflector.getRenderTarget();
      return {
        // ⚠️ 必须是 `reflectionOn()` 而**不是** `plan.enabled`。
        //    `plan.enabled` 是"当前画质档位想不想开",不是"反射现在开没开" ——
        //    用 `?reflect=0` 覆盖时两者正好相反,于是仪表报"开"、而 pass 一次
        //    都没跑(实测:已渲染 0 次、替代面在画面上)。一个会撒谎的仪表比
        //    没有仪表更坏:报告的读者会拿它当作"A 组确实开着反射"的证据。
        enabled: reflectionOn(),
        rtSize: [rt.width, rt.height],
        everyNFrames: plan.everyNFrames,
        reflectionPasses,
        skippedPasses,
        reflectLayerObjects,
        excludedObjects,
        halfWidth,
        ripple: (u.uRipple as { value: number }).value,
      };
    },
  };
}
