/**
 * 资源加载。三段式进度,分母来自 manifest.json 的**真实字节数**。
 *
 * 为什么要自己写 fetch 而不用 GLTFLoader.load()
 * -------------------------------------------------
 * `GLTFLoader.load()` 的 onProgress 依赖响应的 Content-Length。静态服务器
 * 若用了 chunked 编码或 gzip 动态压缩,就没有 Content-Length,进度会一直
 * 停在 0 然后突然跳到 1。本作品把每块的字节数写进了 manifest,自己按
 * ReadableStream 累计,分母就与服务器行为无关了。
 *
 * 三段式
 * ------
 *     0    → 0.75   取 manifest + 逐块下载(按字节加权)
 *     0.75 → 0.97   GLTFLoader.parse
 *     0.97 → 1.0    renderer.compileAsync —— 编译着色器
 *
 * 最后一段不能省:它不是"等待",而是**真正会卡住主线程**的一步。
 * 把它算进进度,进度条才不会在 97% 处凭空停住几秒然后突然完成。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import * as A from '../ui/actions';
import type { LoadFailure } from '../ui/store';

// --------------------------------------------------------------------------
// manifest
// --------------------------------------------------------------------------

export interface ManifestFile {
  name: string;
  bytes: number;
  sha256: string;
  tris: number;
  objects: number;
  collections: string[];
}

export interface Manifest {
  schema: number;
  seed: number;
  unit: string;
  builtAt: string;
  blender: string;
  files: ManifestFile[];
  totalBytes: number;
  totalTris: number;
  objects: number;
  meshes: number;
  materials: number;
  textures: number;
  counts: { byKind: Record<string, number>; objects: number };
}

/** 进度预算。三段之和为 1。 */
const W_MANIFEST = 0.02;
const W_FETCH = 0.73;
const W_PARSE = 0.22;
const W_COMPILE = 0.03;

const T0 = 0;
const T1 = T0 + W_MANIFEST;
const T2 = T1 + W_FETCH;
const T3 = T2 + W_PARSE;

function assetUrl(rel: string): string {
  // 相对 document.baseURI 解析:这样 dev(/)与 dist(./)以及
  // 部署在任意子路径下都能取到,不需要构建期注入 base。
  return new URL(rel, document.baseURI).href;
}

function toFailure(
  url: string,
  stage: LoadFailure['stage'],
  err: unknown,
  status?: number,
): LoadFailure {
  return {
    url,
    stage,
    status,
    message: err instanceof Error ? err.message : String(err),
  };
}

// --------------------------------------------------------------------------
// 取字节(带进度)
// --------------------------------------------------------------------------

async function fetchArrayBuffer(
  url: string,
  onBytes: (n: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`), {
      status: res.status,
    });
  }

  const total = Number(res.headers.get('content-length') ?? '0');
  // 有的服务器不给 Content-Length。此时退化成"整块读完再报一次总量",
  // 进度会一顿一跳,但终值仍然是准的 —— 分母本来就来自 manifest。
  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    onBytes(buf.byteLength);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onBytes(value.byteLength);
  }

  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

// --------------------------------------------------------------------------
// 解析
// --------------------------------------------------------------------------

const loader = new GLTFLoader();

function parseGlb(buffer: ArrayBuffer, url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    loader.parse(
      buffer,
      '',
      (gltf) => {
        // ⚠️ r186 的 GLTFLoader 只要发现 COLOR_0,就会把 material.vertexColors
        //    置为 true,把我们当"普通浮点属性"用的顶点色乘进基色,整个场景发脏。
        //    阶段 0 实测确认过这个行为(见 blender/API_NOTES.md)。
        //    本作品的风动权重属性名叫 flex,不走 alpha,所以必须改回来。
        gltf.scene.traverse((o) => {
          if (!(o as THREE.Mesh).isMesh) return;
          const mesh = o as THREE.Mesh;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            if (m && (m as THREE.MeshStandardMaterial).vertexColors) {
              (m as THREE.MeshStandardMaterial).vertexColors = false;
              m.needsUpdate = true;
            }
          }
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        });
        resolve(gltf.scene);
      },
      (err) => reject(new Error(`${url} 解析失败:${String(err)}`)),
    );
  });
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

export interface LoadedAssets {
  manifest: Manifest;
  /** 分块名 → 场景图。key 如 "scene_core" */
  chunks: Map<string, THREE.Group>;
}

/**
 * 加载全部资源。
 *
 * 失败**不抛异常**,而是写进 store.load.failures 并返回 null ——
 * 因为要显示"哪个文件、哪一步、什么错",抛出到顶层就只剩一个红叉。
 */
export async function loadAssets(): Promise<LoadedAssets | null> {
  const base = { loaded: 0, total: 0 };

  // —— 第一段:manifest ——
  A.loadPhase('manifest', 'manifest.json');
  const manifestUrl = assetUrl('models/manifest.json');
  let manifest: Manifest;
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`), {
        status: res.status,
      });
    }
    manifest = (await res.json()) as Manifest;
  } catch (err) {
    A.loadFailed(toFailure(manifestUrl, 'manifest', err, (err as { status?: number }).status));
    return null;
  }

  base.total = manifest.totalBytes;
  A.loadProgress(T1, `已就绪,共 ${manifest.files.length} 个分块`, [0, base.total]);

  // —— 第二段:逐块下载 ——
  A.loadPhase('fetching');
  const chunks = new Map<string, THREE.Group>();
  const buffers = new Map<string, { buf: ArrayBuffer; url: string }>();

  for (const f of manifest.files) {
    const url = assetUrl(`models/${f.name}`);
    A.loadProgress(T1 + W_FETCH * (base.loaded / Math.max(1, base.total)), f.name, [
      base.loaded,
      base.total,
    ]);
    try {
      const buf = await fetchArrayBuffer(url, (n) => {
        base.loaded += n;
        A.loadProgress(T1 + W_FETCH * (base.loaded / Math.max(1, base.total)), f.name, [
          base.loaded,
          base.total,
        ]);
      });
      buffers.set(f.name, { buf, url });
    } catch (err) {
      A.loadFailed(toFailure(url, 'fetch', err, (err as { status?: number }).status));
      return null;
    }
  }

  // —— 第三段:解析 ——
  A.loadPhase('parsing');
  const files = manifest.files;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const entry = buffers.get(f.name)!;
    A.loadProgress(T2 + W_PARSE * (i / files.length), f.name);
    try {
      chunks.set(f.name.replace(/\.glb$/, ''), await parseGlb(entry.buf, entry.url));
    } catch (err) {
      A.loadFailed(toFailure(entry.url, 'parse', err));
      return null;
    }
  }

  A.loadProgress(T3, '编译着色器');
  return { manifest, chunks };
}

/**
 * 第四段:预编译着色器。
 *
 * 单列出来是因为它需要 renderer,而 assets.ts 不该依赖 renderer。
 * 调用方在场景装配完成后调它,进度从 0.97 推到 1.0。
 */
export async function warmUp(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Promise<void> {
  A.loadPhase('compiling', '编译着色器');
  try {
    await renderer.compileAsync(scene, camera);
  } catch (err) {
    // 编译失败不致命:首帧会退化成同步编译(会卡一下,但能显示)
    console.warn('[assets] compileAsync 失败,退回首帧同步编译:', err);
  }
  A.loadProgress(T3 + W_COMPILE, '');
  A.loadReady();
}
