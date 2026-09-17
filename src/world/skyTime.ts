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
 */
export const PRESETS: Record<TimePreset, PresetDef> = {
  dawn: {
    label: '清晨',
    elevation: 8,
    azimuth: 100,
    turbidity: 3.2,
    rayleigh: 2.4,
    exposure: 1.0,
    fogColor: 0x9aa4ac,
    fogDensity: 0.0018,
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
    fogColor: 0xb9ad93,
    fogDensity: 0.0012,
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
    fogColor: 0x6e4a3a,
    fogDensity: 0.0022,
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
    cam.near = 1;
    cam.far = 900;
    this.sun.shadow.mapSize.set(2048, 2048);
    // 阴影痤疮与彼得潘现象之间的常用折中
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;

    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbcd0e6, 0x7a6647, 0.32);
    scene.add(this.hemi);

    this.fog = new THREE.FogExp2(0xc0b49a, 0.0018);
    scene.fog = this.fog;

    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.setPreset('day');
  }

  get preset(): TimePreset {
    return this._preset;
  }

  setPreset(preset: TimePreset): void {
    this._preset = preset;
    const d = PRESETS[preset];

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

    this.sun.position.copy(this.sunPos).multiplyScalar(250);
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
   * 每帧调用。环境贴图只在参数变化后重建一次 ——
   * PMREM 是六个面的多级卷积,绝不能每帧做。
   */
  update(): void {
    if (!this.environmentDirty) return;
    this.environmentDirty = false;

    // 显式传 near/far:fromScene 默认 far=100,会裁掉天空盒导致环境全黑。
    const rt = this.pmrem.fromScene(this.pmremScene, 0, 1, SKY_SCALE * 2);
    this.scene.environment = rt.texture;
    // 环境光只作补光,主光仍是太阳。
    // 实测教训:0.85 会把土色地面冲成灰白、地平线完全糊掉;0.35 才有明暗层次。
    this.scene.environmentIntensity = 0.35;
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
