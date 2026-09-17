import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

/**
 * 解码器必须随构建产物一起落盘到 dist/。
 *
 * 背景:DRACOLoader / KTX2Loader 默认会去 CDN 取解码器 wasm。
 * 本作品要求「全新 clone → npm ci → build → 打开网页」在断网时也能运行,
 * 所以解码器必须在构建期从 node_modules 复制出来,运行时按相对路径加载。
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
      targets: [
        {
          src: 'node_modules/three/examples/jsm/libs/draco/*.{js,wasm}',
          dest: 'draco',
        },
        {
          src: 'node_modules/three/examples/jsm/libs/basis/*.{js,wasm}',
          dest: 'basis',
        },
        {
          src: 'node_modules/three/examples/jsm/libs/meshopt_decoder.module.js',
          dest: 'meshopt',
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
