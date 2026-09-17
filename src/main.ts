import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import './styles/base.css';
import { createRenderer, readGpuInfo } from './core/renderer';
import { Loop } from './core/loop';
import { SkyTime, CAMERA_FAR } from './world/skyTime';

/**
 * 阶段 0 占位场景。
 *
 * 这里的虹桥只是几段直梁拼成的圆弧,用来打通
 * Blender → GLB → Three.js → 无头截图 之外的渲染链路。
 * 真实的编木拱桥由 Blender 程序化生成,在阶段 2 替换掉本函数。
 *
 * 实现上刻意先把所有构件几何体收集起来、最后合并成**单个 Mesh**:
 * 早期版本每个梁/板/柱各建一个 Mesh,结果 4300 个三角面就吃掉了 366 个
 * drawcall —— 这正是性能预算里要避免的反模式。合并后同样画面只需 1 个。
 * Blender 侧的导出策略与此一致(按材质合批,而不是按构件导出)。
 */
function buildPlaceholderBridge(): THREE.Group {
  const group = new THREE.Group();
  group.name = '占位虹桥(阶段 2 将由 Blender 生成的真实模型替换)';

  const woodMat = new THREE.MeshStandardMaterial({
    color: 0x8a6a44,
    roughness: 0.85,
    metalness: 0.0,
  });

  // 跨径 20m、拱矢 5m 的圆弧:半径 R=(c²/4+h²)/(2h)=12.5,圆心在 (0, 5-R)
  const R = 12.5;
  const cx = 0;
  const cy = 5 - R;
  const halfAngle = Math.asin(10 / R);

  const SEG = 22;
  const segLen = (2 * halfAngle * R) / SEG;

  const parts: THREE.BufferGeometry[] = [];
  const unitScale = new THREE.Vector3(1, 1, 1);
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisZ = new THREE.Vector3(0, 0, 1);
  const mat4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const noRot = new THREE.Quaternion();

  /** 把几何体按给定位移/旋转摆好后收进待合并列表。 */
  const place = (geo: THREE.BufferGeometry, p: THREE.Vector3, q: THREE.Quaternion): void => {
    mat4.compose(p, q, unitScale);
    geo.applyMatrix4(mat4);
    parts.push(geo);
  };

  // 两组拱肋
  for (const z of [-2.6, 2.6]) {
    for (let i = 0; i < SEG; i++) {
      const a0 = -halfAngle + (i / SEG) * 2 * halfAngle;
      const a1 = -halfAngle + ((i + 1) / SEG) * 2 * halfAngle;
      const x0 = cx + R * Math.sin(a0);
      const y0 = cy + R * Math.cos(a0);
      const x1 = cx + R * Math.sin(a1);
      const y1 = cy + R * Math.cos(a1);

      // 让长度为 segLen 的 X 向梁对齐到 p0→p1 方向
      rot.setFromUnitVectors(axisX, pos.set(x1 - x0, y1 - y0, 0).normalize());
      place(
        new THREE.BoxGeometry(segLen * 1.06, 0.34, 0.34),
        new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, z),
        rot,
      );
    }
  }

  // 桥面板
  for (let i = 0; i < SEG; i++) {
    const a = -halfAngle + ((i + 0.5) / SEG) * 2 * halfAngle;
    rot.setFromAxisAngle(axisZ, -a);
    place(
      new THREE.BoxGeometry(segLen * 1.02, 0.12, 7.8),
      new THREE.Vector3(cx + R * Math.sin(a), cy + R * Math.cos(a) + 0.23, 0),
      rot,
    );
  }

  // 栏杆立柱
  for (let i = 0; i <= SEG; i += 2) {
    const a = -halfAngle + (i / SEG) * 2 * halfAngle;
    const y = cy + R * Math.cos(a);
    for (const z of [-3.85, 3.85]) {
      place(
        new THREE.BoxGeometry(0.14, 1.1, 0.14),
        new THREE.Vector3(cx + R * Math.sin(a), y + 0.84, z),
        noRot,
      );
    }
  }

  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('占位虹桥几何体合并失败:各构件的属性布局不一致');
  // 合并已复制数据,原始几何体的 CPU 端数组可以立即释放
  for (const p of parts) p.dispose();

  const mesh = new THREE.Mesh(merged, woodMat);
  mesh.name = '占位虹桥合并网格';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  return group;
}

function main(): void {
  const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('找不到 #stage 画布元素');

  const renderer = createRenderer(canvas);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.2,
    CAMERA_FAR,
  );
  camera.position.set(26, 14, 30);

  const skyTime = new SkyTime(renderer, scene);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 4, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 3;
  controls.maxDistance = 400;
  // 不允许转到地平面以下,避免看到地面网格的背面
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };

  // 地面。要足够大以延伸到雾的尽头,否则地平线外会露出黑色背景。
  // 颜色压得比"土色"更暗:AgX 色调映射会把中间调往灰里拉,
  // 反照率给高了近处地面就会糊成一片白,地平线随之消失。
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(6000, 6000),
    new THREE.MeshStandardMaterial({ color: 0x6a5a40, roughness: 1.0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // 水面(阶段 4 换成继承 Reflector 的汴河水面)。
  // roughness 不能低:低粗糙度会把天空镜面反射进来,汴河就变成"海水蓝"了。
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 17),
    new THREE.MeshStandardMaterial({ color: 0x6a5730, roughness: 0.55, metalness: 0.0 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.02;
  scene.add(water);

  scene.add(buildPlaceholderBridge());

  const loop = new Loop();
  loop.add(() => {
    skyTime.update();
    controls.update();
    renderer.render(scene, camera);
  });

  // —— 视口自适应 ——
  const onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };
  window.addEventListener('resize', onResize);

  loop.start(renderer);

  // —— 调试接口 ——
  // 截图与性能脚本依赖它;同时作为"页面已就绪"的信号源。
  const gpu = readGpuInfo(renderer);
  Object.defineProperty(window, '__QM__', {
    value: {
      THREE,
      renderer,
      scene,
      camera,
      controls,
      loop,
      skyTime,
      gpu,
      /**
       * 采样当前画面并统计。
       *
       * 用来客观判断"是不是黑屏/空白" —— 只看截图肉眼容易漏判,
       * 而纯色画面的标准差接近 0,一眼可辨。
       */
      sampleCanvas(): {
        width: number;
        height: number;
        meanColor: [number, number, number];
        stdDev: number;
        nonUniformRatio: number;
        isSoftwareRenderer: boolean;
      } {
        renderer.render(scene, camera);

        const gl = renderer.getContext();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

        let n = 0;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sq = 0;
        // 以左上角像素为背景基准,统计与之明显不同的像素比例
        const br = buf[0]!;
        const bgc = buf[1]!;
        const bb = buf[2]!;
        let different = 0;

        const step = 4;
        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const i = (y * w + x) * 4;
            const r = buf[i]!;
            const g = buf[i + 1]!;
            const b = buf[i + 2]!;
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            sr += r;
            sg += g;
            sb += b;
            sq += lum * lum;
            n++;
            if (Math.abs(r - br) > 12 || Math.abs(g - bgc) > 12 || Math.abs(b - bb) > 12) {
              different++;
            }
          }
        }

        const meanLum = (0.2126 * (sr / n) + 0.7152 * (sg / n) + 0.0722 * (sb / n));
        const varLum = sq / n - meanLum * meanLum;

        return {
          width: w,
          height: h,
          meanColor: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
          stdDev: Math.round(Math.sqrt(Math.max(0, varLum)) * 100) / 100,
          nonUniformRatio: Math.round((different / n) * 1000) / 1000,
          isSoftwareRenderer: gpu.isSoftware,
        };
      },
    },
    writable: false,
    configurable: false,
  });

  // 就绪信号:等第一帧真正画完再置位,避免脚本抢在渲染前截图
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      Object.defineProperty(window, '__QM_READY__', { value: true, writable: false });
    });
  });
}

main();
