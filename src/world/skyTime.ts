import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

export type TimePreset = 'dawn' | 'day' | 'dusk';

interface PresetDef {
  label: string;
  /** 太阳仰角(度)。小于 10° 时影子拖长,是清晨与暮色的关键特征。 */
  elevation: number;
  /** 太阳方位角(度) */
  azimuth: number;
  turbidity: number;
  rayleigh: number;
  /** 渲染器曝光补偿,用来平衡不同时段的整体亮度 */
  exposure: number;
  /** 雾色。**取值来自实测**:见下方 PRESETS 上方的说明,不是凭感觉挑的。 */
  fogColor: number;
  fogDensity: number;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
}

/**
 * 三个时辰的参数。
 *
 * 均为美术调色值,不是天文实测数据 —— 目标是"看起来像北宋汴京的清晨/正午/黄昏",
 * 而非天文精度。这一点在 docs/01-复原依据与考据.md 中同样声明。
 *
 * ── 雾色与雾浓度是量出来的,不是调出来的 ──────────────────────────
 *
 * 起因是沙盘的地坪只有 600×600m(X/Z 各 ±300),再往外就是天,画面
 * 上一道清清楚楚的水平硬边。要把这条边化掉只能用雾,而**雾色若与
 * 地平线附近的天色不一致,地是被雾成了另一种颜色,边只会从"地/天"
 * 变成"雾/天",照样看得见** —— 所以先得知道天是什么色。
 *
 * 下面三个天色由 `tools/perf/probe_horizon.mjs` 沿竖线扫描量得 ——
 * 取相邻两行色差最大的一行作为地平线,再取其一上方 12 行的中位色。
 * (那个脚本后来改过两次判定方式,原因写在它自己的注释里;这三行数是
 *  **改之前**、地边仍是全列最大色差时量的,当时它确实指向地平线。)
 *
 *     dawn   rgb(164,159,161)  #a49fa1      原雾色 #9aa4ac(偏蓝)
 *     day    rgb(243,245,246)  #f3f5f6      原雾色 #b9ad93(**土黄,差得最远**)
 *     dusk   rgb(158,137,134)  #9e8986      原雾色 #6e4a3a(暗红棕)
 *
 * 原来的三个雾色都是"土地的颜色",而地平线附近的天几乎是白的。
 * 白天那一组差得尤其离谱:雾色 rgb(185,173,147) 与天色 rgb(243,245,246)
 * 差了将近 60 个灰阶,**等于在把地面往离天空更远的方向雾**。
 *
 * 浓度 ρ 取 **0.0035**,不是算出来的最优解,是**看图比出来的折中**。
 * FogExp2 的雾量 = 1 − exp(−(ρ·d)²):
 *
 *     ρ        60m      120m      300m     地边(300m 附近)的观感
 *     0.0012   0.5%      2.1%     12.2%    硬边,与改前一样
 *     0.0035   4.3%     16.2%     66.8%    化成柔和渐变,中景细节完好  ← 取这档
 *     0.005    8.6%     30.2%     89.5%    地边几乎全消,但中景铺面开始发糊
 *     0.007   16.2%     50.6%     98.8%    中景明显洗白
 *
 * 三档都实拍过(`tools/perf/probe_horizon.mjs --sweep 0.0012,0.0035,0.005,0.007`
 * → `screenshots/web/fog_sweep_*.png`)。按"300m 处雾掉 90%"反推其实
 * 该取 0.00506,但 0.005 那一档看图就能发现**中景的铺面与彩楼欢门开始
 * 发糊** —— 而用户的要求里明写着特效"克制,不掩盖模型细节"。所以不取
 * 0.005,取 0.0035:地边已从"一条硬线"变成渐变,细节基本没损失。
 *
 * ⚠️ 这里其实是个**折中的痕迹**,记下来免得被当成调好的结果:
 *    真正的症结是**沙盘的地坪只做到 ±300m 就没了**。雾浓到能吃掉
 *    300m 处的地边,就必然会把 120m 处的铺面一起吃掉 —— 两个距离
 *    在 FogExp2 上只差一个系数,没办法分开。
 *    要根治得让地面伸得更远:同样 0.0035 的雾在约 **495m** 处就能到
 *    95%,那时地面若延伸到 500m,地边自然消失,而中景仍是 16% 的清爽。
 *    这需要改 Blender 侧的地形 builder,留给 2e(城门远景)那一趟一起做。
 *
 * ⚠️ 已知不足:清晨与暮色的地平线天色**左右相差很大**(实测 dusk 在
 *    x=400 处 rgb(242,213,201)、x=1200 处 rgb(125,113,114)),因为太阳
 *    接近地平线,一侧亮一侧暗。而雾只有**一个**颜色,不可能同时贴合
 *    两侧。这里取的是三列中位数,于是两个时辰里总有一侧的地边化不干净。
 *    要再进一步得换成带方向性的雾(或按天空纹理采样),本阶段不做。
 */
export const PRESETS: Record<TimePreset, PresetDef> = {
  dawn: {
    label: '清晨',
    elevation: 8,
    azimuth: 100,
    turbidity: 3.2,
    rayleigh: 2.4,
    exposure: 1.0,
    fogColor: 0xa49fa1,
    fogDensity: 0.0035,
    sunColor: 0xffd9b0,
    sunIntensity: 1.6,
    hemiSky: 0xa8bdd4,
    hemiGround: 0x6b5a44,
    hemiIntensity: 0.26,
  },
  day: {
    label: '暖日',
    elevation: 48,
    azimuth: 140,
    turbidity: 4.5,
    rayleigh: 2.2,
    exposure: 0.92,
    fogColor: 0xf3f5f6,
    fogDensity: 0.0035,
    sunColor: 0xfff2dc,
    sunIntensity: 1.9,
    hemiSky: 0xbcd0e6,
    hemiGround: 0x7a6647,
    hemiIntensity: 0.28,
  },
  dusk: {
    label: '暮色',
    elevation: 3,
    azimuth: 250,
    turbidity: 6.0,
    rayleigh: 3.2,
    exposure: 1.05,
    fogColor: 0x9e8986,
    fogDensity: 0.0035,
    sunColor: 0xff9d5c,
    sunIntensity: 1.35,
    hemiSky: 0x8f7fa0,
    hemiGround: 0x4a3a2c,
    hemiIntensity: 0.24,
  },
};

/** 阴影相机半宽(米)。越小越清晰,但要能罩住当前观察区域。 */
const SHADOW_EXTENT = 60;

/**
 * 在两个相邻预设之间按 k∈[0,1] 插值出一组参数。
 *
 * 颜色走 `THREE.Color.lerp`,数值直接线性插值。
 *
 * ⚠️ **插值发生在色相之前,而不是之后。** 直接对两个 16 进制色做位运算
 *    平均(或对 RGB 三个分量各取平均)在 `sunColor` 上勉强能看,
 *    但这其实是在 sRGB 空间里做混合;而 `Color.setHex()` 会先把 sRGB
 *    换算到线性工作空间,`lerp` 也就在线性空间里进行,`getHex()` 再换回来。
 *    两端一致,所以这里不需要额外的色彩空间处理 —— 但**要知道它发生在哪**,
 *    否则将来有人把 `getHex()` 换成 `getHexString()` 时会以为只是换了个格式。
 */
function lerpPreset(u: number): PresetDef {
  const a = u <= 0.5 ? PRESETS.dawn : PRESETS.day;
  const b = u <= 0.5 ? PRESETS.day : PRESETS.dusk;
  const k = u <= 0.5 ? u / 0.5 : (u - 0.5) / 0.5;

  const n = (x: number, y: number): number => x + (y - x) * k;
  const c = (x: number, y: number): number =>
    new THREE.Color().setHex(x).lerp(new THREE.Color().setHex(y), k).getHex();

  return {
    // 标签取更近的那一端的名字。它只用于显示,不参与渲染。
    label: k < 0.5 ? a.label : b.label,
    elevation: n(a.elevation, b.elevation),
    azimuth: n(a.azimuth, b.azimuth),
    turbidity: n(a.turbidity, b.turbidity),
    rayleigh: n(a.rayleigh, b.rayleigh),
    exposure: n(a.exposure, b.exposure),
    fogColor: c(a.fogColor, b.fogColor),
    fogDensity: n(a.fogDensity, b.fogDensity),
    sunColor: c(a.sunColor, b.sunColor),
    sunIntensity: n(a.sunIntensity, b.sunIntensity),
    hemiSky: c(a.hemiSky, b.hemiSky),
    hemiGround: c(a.hemiGround, b.hemiGround),
    hemiIntensity: n(a.hemiIntensity, b.hemiIntensity),
  };
}

/**
 * 太阳的摆放距离(米)。
 *
 * 平行光的 position 只决定**阴影视锥从哪里开始投影**,与光照方向无关
 * (方向由 position → target 决定)。所以这个数不是"太阳有多远",
 * 而是"阴影相机架多远"。
 */
const SUN_DISTANCE = 250;

/**
 * 阴影视锥的 near / far。
 *
 * ⚠️ 必须由 SUN_DISTANCE 推导,不能各写各的。
 *    场景内容分布在以原点为中心、半径约 85m 的球内,
 *    所以沿光线方向的跨度是 SUN_DISTANCE ± 85。
 *    取 250−130 与 250+150 留出余量;收紧 near/far 能让 2048 的
 *    深度缓冲把精度集中在真正有内容的区间上。
 *
 *    这里曾经写成 far=220 —— 比 SUN_DISTANCE 还小 30m,
 *    结果整个场景落在视锥之外,全画面一道影子都没有。
 */
const SHADOW_NEAR = SUN_DISTANCE - 130;
const SHADOW_FAR = SUN_DISTANCE + 150;

/**
 * 环境贴图强度。
 *
 * Sky 着色器输出的辐亮度很高,PMREM 出来的环境光比想象中强得多。
 * 0.35 会把太阳压成配角、把色彩冲淡成灰白。0.10 让太阳回到主光位置,
 * 环境只负责天光补面(暗部带一点天空蓝,而不是死黑)。
 */
const ENV_INTENSITY = 0.10;

/**
 * 天空盒缩放。
 *
 * 天空着色器只按视线方向取色(normalize(vWorldPosition - cameraPos)),
 * 与盒子大小无关,所以可以自由缩放而不影响画面。
 *
 * 这里必须缩小到能塞进相机远裁剪面之内:
 * three 官方示例用 45000,配套的是 camera.far = 2000000,
 * 那样深度精度会崩掉,近处模型会 z-fighting。
 * 缩放 2000 → 顶点在 ±1000,相机 far 取 4000 即可完整包住。
 */
export const SKY_SCALE = 2000;

/** 相机远裁剪面。必须大于 SKY_SCALE,否则天空会被切掉(会导致背景全黑)。 */
export const CAMERA_FAR = 4000;

export class SkyTime {
  /** 主场景里的可见天空盒,充当背景 */
  readonly sky: Sky;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: THREE.FogExp2;

  /**
   * 用于烘 PMREM 的独立天空实例。
   *
   * 必须独立 —— Object3D 只能有一个父级,把同一个 Sky 同时 add 进两个场景
   * 会让它从前者被摘走,PMREM 就会烘出全黑的环境贴图。
   */
  private readonly skyForEnv: Sky;

  private readonly sunPos = new THREE.Vector3();
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly pmremScene = new THREE.Scene();

  private _preset: TimePreset = 'day';
  private _tod = 0.5;
  private _envRevision = 0;
  private environmentDirty = true;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
  ) {
    this.sky = new Sky();
    this.sky.scale.setScalar(SKY_SCALE);
    scene.add(this.sky);

    this.skyForEnv = new Sky();
    this.skyForEnv.scale.setScalar(SKY_SCALE);
    this.pmremScene.add(this.skyForEnv);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.1);
    this.sun.castShadow = true;

    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = SHADOW_NEAR;
    cam.far = SHADOW_FAR;
    // 改完 near/far 必须显式重算投影矩阵,否则改动不生效
    cam.updateProjectionMatrix();
    this.sun.shadow.mapSize.set(2048, 2048);
    // 阴影痤疮与彼得潘现象之间的常用折中
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;

    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbcd0e6, 0x7a6647, 0.32);
    scene.add(this.hemi);

    // 初始值只是占位:下一行 setPreset('day') 会立刻按 PRESETS 覆盖掉。
    // 但仍然照 day 的值写 —— 免得将来有人把 setPreset 挪走或提前截图,
    // 拿到的是一组谁也说不清出处的数字。
    this.fog = new THREE.FogExp2(PRESETS.day.fogColor, PRESETS.day.fogDensity);
    scene.fog = this.fog;

    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.setPreset('day');
  }

  get preset(): TimePreset {
    return this._preset;
  }

  /** 当前时辰 0..1(0=拂晓, 0.5=白昼, 1=黄昏)。 */
  get timeOfDay(): number {
    return this._tod;
  }

  /**
   * 环境贴图**重建次数**。
   *
   * ⚠️ 这个计数器存在的唯一理由是让"PMREM 确实重建了"成为一条能失败的断言。
   *    要是测试只断言"`store.tod` 变了",那它证明的只是**状态改了**,
   *    完全没碰渲染侧 —— setter 里哪怕整个函数体是空的也照样通过。
   *    计数只在 `update()` 真正走完 that rebuild 分支时 +1,所以它
   *    没法被"我只是调了一下 setter"骗过去。
   */
  get environmentRevision(): number {
    return this._envRevision;
  }

  /**
   * 按时辰预设设置。三个预设是离散的锚点,连续控制在 `setTimeOfDay`。
   *
   * ⚠️ `preset` 现在由 `setTimeOfDay` **推导**出来,不再是独立存的一份状态。
   *    早先它是独立字段、由这个 setter 直接赋值 —— 于是"preset 说 day、
   *    实际参数在黄昏"这种不一致是可以存在的,而且看不出来。
   *    一份状态两个来源,迟早对不上。
   */
  setPreset(preset: TimePreset): void {
    this.setTimeOfDay(preset === 'dawn' ? 0 : preset === 'day' ? 0.5 : 1);
  }

  /**
   * 按连续时辰 0..1 设置(0=拂晓, 0.5=白昼, 1=黄昏)。
   *
   * 为什么是插值而不是"就近取一个预设":用户要的是一个可以拖的时辰滑块。
   * 若滑块只切三个档,拖动时画面会在三个点之间跳变,那不是滑块,是三个按钮 ——
   * 而 UI 上摆一个拖不出中间态的滑块,属于"无响应的装饰性控件"。
   *
   * 插值在**相邻两个预设之间**分段进行(拂晓→白昼、白昼→黄昏),
   * 不是三点同时加权。同时加权的话,`t=0.5` 处三个预设都会贡献一点,
   * 白昼那一档就被两侧稀释了 —— 滑块正中间反而是最不像白昼的位置。
   */
  setTimeOfDay(t: number): void {
    const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
    this._tod = u;
    // 四分之一与四分之三处是"看着像哪一档"的分界,取整档只用于显示。
    this._preset = u < 0.25 ? 'dawn' : u < 0.75 ? 'day' : 'dusk';
    this.applyParams(lerpPreset(u));
  }

  /** 把一组参数应用到天空、太阳、半球光、雾与曝光。 */
  private applyParams(d: PresetDef): void {
    // 由仰角与方位角求太阳方向。
    // setFromSphericalCoords 的 phi 从 +Y 轴起算,故用 90° - 仰角。
    const phi = THREE.MathUtils.degToRad(90 - d.elevation);
    const theta = THREE.MathUtils.degToRad(d.azimuth);
    this.sunPos.setFromSphericalCoords(1, phi, theta);

    // 可见天空与烘环境用的天空必须同步,否则背景与反射会对不上
    for (const s of [this.sky, this.skyForEnv]) {
      s.material.uniforms.sunPosition!.value.copy(this.sunPos);
      s.material.uniforms.turbidity!.value = d.turbidity;
      s.material.uniforms.rayleigh!.value = d.rayleigh;
    }

    this.sun.position.copy(this.sunPos).multiplyScalar(SUN_DISTANCE);
    this.sun.color.setHex(d.sunColor);
    this.sun.intensity = d.sunIntensity;
    this.sun.target.position.set(0, 0, 0);

    this.hemi.color.setHex(d.hemiSky);
    this.hemi.groundColor.setHex(d.hemiGround);
    this.hemi.intensity = d.hemiIntensity;

    this.fog.color.setHex(d.fogColor);
    this.fog.density = d.fogDensity;

    this.renderer.toneMappingExposure = d.exposure;

    this.environmentDirty = true;
  }

  /**
   * 标记环境贴图需要重建。**图形上下文恢复后必须调一次。**
   *
   * 为什么非得是这里:`scene.environment` 拿的是 PMREM 渲染目标的**贴图**,
   * 而渲染目标的 GPU 侧内容不会随上下文一起回来 —— 上下文一丢,
   * 那张环境贴图就成了空贴图。偏偏 three 的 `WebGLTextures.setTexture2D`
   * 有一条 `texture.isRenderTargetTexture === false` 的判断,渲染目标贴图
   * **走不进重新上传的分支**,于是它会安安静静地 bind 一张空贴图:
   * 画面整体发黑、不报错、控制台干净。
   *
   * 而且这张贴图**没有别的机会被重画**:PMREM 只在这一处重建,
   * 平时靠 `environmentDirty` 一次性触发。丢了不标脏,它就永远是空的。
   *
   * 实测有多黑(`tools/perf/once/env_stale_ab.mjs`,把本方法换成空函数
   * 再走一遍丢失→恢复):恢复后 / 丢失前 的亮度比 **0.8107**,stdDev
   * 从 64.73 涨到 81.62(环境补光没了,暗部塌下去,对比反而变强)。
   * 控制台上没有任何输出 —— 不量就只能看到"今天画面好像有点暗"。
   */
  invalidateEnvironment(): void {
    this.environmentDirty = true;
  }

  /**
   * 每帧调用。环境贴图只在参数变化后重建一次 ——
   * PMREM 是六个面的多级卷积,绝不能每帧做。
   */
  update(): void {
    if (!this.environmentDirty) return;
    this.environmentDirty = false;
    // 只在真正重建的那条路径上计数 —— 见 environmentRevision 的说明。
    this._envRevision++;

    // 显式传 near/far:fromScene 默认 far=100,会裁掉天空盒导致环境全黑。
    const rt = this.pmrem.fromScene(this.pmremScene, 0, 1, SKY_SCALE * 2);
    this.scene.environment = rt.texture;
    // 环境光只作补光,主光仍是太阳。
    //
    // ⚠️ 这个数是被实测按下来的,不是拍脑袋:
    //    diag.mjs 的单变量对照(逐路关灯后采样画面)显示,
    //    0.35 时关掉环境贴图会让均值从 rgb(176,175,171) 掉到
    //    rgb(124,112,94)、标准差从 38.5 升到 73.1 ——
    //    也就是说画面亮度的一大半、以及全部的色彩层次感,
    //    都被这层环境光贡献的反而是"抹平"的效果。
    //    根因是 Sky 的辐亮度很高,0.35 的系数乘上去仍然盖过太阳。
    //    降到 0.10,让太阳重新成为主光。
    this.scene.environmentIntensity = ENV_INTENSITY;
  }

  dispose(): void {
    this.pmrem.dispose();
    for (const s of [this.sky, this.skyForEnv]) {
      s.geometry.dispose();
      (s.material as THREE.Material).dispose();
    }
    this.sun.shadow.map?.dispose();
  }
}
