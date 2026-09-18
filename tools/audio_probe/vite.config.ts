import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * 探针专用构建配置。
 *
 * ⚠️ 为什么不复用根 vite.config.ts
 * ------------------------------
 * 根配置带 viteStaticCopy(拷 draco/basis 解码器)与 three 的 manualChunks ——
 * 对一个只有音频模块的探针来说全是无关负重,而且那些插件的行为会随版本漂移,
 * 探针一旦跟着坏掉就没人看了。这里只保留**对音频这一块有意义**的三条:
 *
 *   · base: './'        —— 与作品一致的部署形态,worklet 走相对路径取
 *   · assetsInlineLimit: 0 —— 与作品一致,**禁止内联**。太小的资源被 Vite
 *                          内联成 data: URL 之后,worklet 的 ?url 就不再是
 *                          一次真实的网络请求 —— Blob 回退那条路永远不会
 *                          被触发,探针也就测不到它。
 *   · outDir 独立        —— 不覆盖 dist/,作品构建与探针构建互不干扰
 *
 * root 指向本目录:index.html 与 main.ts 是唯一入口,src/audio 通过相对路径
 * 引进来(在 root 之外,Vite 允许,构建期不涉及 dev server 的 fs 白名单)。
 */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  build: {
    target: 'es2022',
    outDir: resolve(here, '../../dist-audio-probe'),
    // 输出目录在 root 之外,必须显式声明否则 Vite 拒绝清空
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
