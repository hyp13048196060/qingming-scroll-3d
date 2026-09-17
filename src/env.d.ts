/**
 * 资源导入的环境声明。
 *
 * 这里**没有**引入 `vite/client`:那份声明会把 `import.meta.env`、HMR API、
 * 以及一堆用不到的资产类型一并带进全局命名空间。本作品只用到下面几种,
 * 显式写出来更容易看出"哪些非常规导入被允许"。
 */

/** 副作用导入的样式表(`import './styles/base.css'`),由 Vite 处理。 */
declare module '*.css' {
  const css: string;
  export default css;
}

/** `?url` 后缀:拿到资源 URL 而不是内容。AudioWorklet 处理器用它引入。 */
declare module '*?url' {
  const url: string;
  export default url;
}

/** `?raw` 后缀:拿到文件原始文本。Worklet 的 Blob 回退路径用它内联源码。 */
declare module '*?raw' {
  const source: string;
  export default source;
}
