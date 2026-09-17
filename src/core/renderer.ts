import * as THREE from 'three';

/**
 * 渲染器创建。这里集中了三条容易踩坑的 r18x 约束,改动前请先读注释。
 */
export interface RendererOptions {
  /** devicePixelRatio 上限。高分屏上按性能档位下调。 */
  pixelRatioCap?: number;
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  options: RendererOptions = {},
): THREE.WebGLRenderer {
  const { pixelRatioCap = 2 } = options;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    // 本作品不用模板缓冲,关掉可省一点显存与带宽
    stencil: false,
  });

  // —— 色彩管理 ——
  // r186 起 toneMapping 默认是 NoToneMapping。不显式设置的话,
  // 太阳直射与水面高光会直接削平到纯白,整体发白发灰。
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;

  // 输出到 sRGB。注意:这只管最终输出,
  // 贴图各自的 colorSpace 要单独设,否则法线/粗糙度会被错误地做伽马变换。
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // —— 阴影 ——
  renderer.shadowMap.enabled = true;
  // r182 起 PCFSoftShadowMap 已废弃并回退到 PCF。
  // 需要更软的边缘应改用 VSM 或增大 shadow radius,而不是这个枚举。
  renderer.shadowMap.type = THREE.PCFShadowMap;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // 反射、阴影、深度等额外 pass 会持续累加到 renderer.info.render。
  // 必须关掉自动重置,改由每帧开头手动 reset,否则 drawcall / 三角面读数会虚高十倍。
  renderer.info.autoReset = false;

  return renderer;
}

/**
 * 读取真实的 GPU 标识串。
 *
 * 性能数据可信度的前提:无头 Chrome 有时会退到 SwiftShader 软件渲染,
 * 那样测出来的帧率毫无意义。所有性能采集都必须先过这一关。
 */
export function readGpuInfo(renderer: THREE.WebGLRenderer): {
  renderer: string;
  vendor: string;
  isSoftware: boolean;
} {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');

  const rendererStr = dbg
    ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));
  const vendorStr = dbg
    ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL))
    : String(gl.getParameter(gl.VENDOR));

  return {
    renderer: rendererStr,
    vendor: vendorStr,
    isSoftware: /swiftshader|software|llvmpipe|basic render/i.test(rendererStr),
  };
}
