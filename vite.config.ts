import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

/**
 * 解码器随构建产物一起落盘到 dist/。
 *
 * 背景:DRACOLoader / KTX2Loader 默认会去 CDN 取解码器 wasm。一旦启用
 * 几何压缩或 KTX2 贴图,断网环境就必须靠这份本地副本才能打开页面。
 *
 * ⚠️ 实测口径(2026-09-18):**当前产物并没有用到这三个解码器。**
 *    - `src/` 里没有任何一处 import DRACOLoader / KTX2Loader / MeshoptDecoder;
 *    - 四个 GLB 的 `extensionsRequired` 都只有 `EXT_texture_webp`
 *      (three 的 GLTFLoader 原生支持,不需要额外解码器);
 *    - 运行时抓包:三个目录一次都没被请求过。
 *
 *    所以这 1.6 MB 目前是**备用**而不是**必需** —— 它在 dist/ 里但不参与首屏。
 *    保留它有两个理由:①交付要求明确把"解码器"列为随运行资产一起提供的东西;
 *    ②真要开 Draco/Meshopt 压缩时,路径已经是对的,不必再查一遍 404。
 *    别把它当成"页面离线运行依赖了它"的证据,这两件事不是一回事。
 *
 * 路径已实测确认存在(three 0.186.0):
 *   node_modules/three/examples/jsm/libs/draco/*.{js,wasm}
 *   node_modules/three/examples/jsm/libs/basis/*.{js,wasm}
 *   node_modules/three/examples/jsm/libs/meshopt_decoder.module.js
 */
export default defineConfig({
  // 相对路径,使 dist/ 可以直接被静态服务器托管在任意子路径下
  base: './',

  plugins: [
    viteStaticCopy({
      // ⚠️ `rename: { stripBase: true }` 不是可选项,少了它产物路径是错的。
      //
      //    vite-plugin-static-copy 4.x 一律保留匹配文件相对 root 的**整条目录**:
      //    collectCopyTargets 里是 `destDir = path.join(dest, dirClean)`,而
      //    dirClean 就是 `node_modules/three/examples/jsm/libs/draco`。
      //    (v2 曾有 `structured: false` 可以压平,4.x 已移除该选项。)
      //
      //    结果就是解码器落到
      //      dist/draco/node_modules/three/examples/jsm/libs/draco/draco_decoder.js
      //    而 DRACOLoader 按 `./draco/` 去取 —— 必然 404,且只在真正
      //    需要解压时才暴露,是那种"上线才发现"的坑。
      //
      //    stripBase 让插件用 `../../..` 把中间目录抵消掉,
      //    经 path.join 归一化后正好落回 dest 根。已实测确认路径。
      targets: [
        {
          src: 'node_modules/three/examples/jsm/libs/draco/*.{js,wasm}',
          dest: 'draco',
          rename: { stripBase: true },
        },
        {
          src: 'node_modules/three/examples/jsm/libs/basis/*.{js,wasm}',
          dest: 'basis',
          rename: { stripBase: true },
        },
        {
          src: 'node_modules/three/examples/jsm/libs/meshopt_decoder.module.js',
          dest: 'meshopt',
          rename: { stripBase: true },
        },
      ],
    }),
  ],

  optimizeDeps: {
    // 不预打包 three:addons 从 'three' 导入,预打包会产生第二份实例,
    // 导致 instanceof 判断与共享单例(如 Timer、UniformsLib)失效
    exclude: ['three'],
  },

  build: {
    target: 'es2022',
    // 禁止内联,保证解码器与贴图始终是独立文件,便于离线校验
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // 注意:Vite 8 底层是 rolldown,manualChunks 只接受函数形式,
        // 对象形式({ three: ['three'] })会直接抛 "manualChunks is not a function"。
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          return undefined;
        },
      },
    },
  },
});
