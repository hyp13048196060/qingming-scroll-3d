# 第三方素材与许可

本文件回答一个问题:**这个仓库里,哪些东西不是我自己做的,它们各自的授权是什么,
拿来做什么用。** 每一条都尽量给出可核对的出处,核不到的会明写「未核实」。

总览:

| 素材 | 许可 | 在本作品里的用途 |
|---|---|---|
| 本项目代码 | MIT | 全部 |
| three.js 生态(three / @types/three) | MIT | 渲染 |
| TypeScript | Apache-2.0 | 构建期,不进产物 |
| Vite / vite-plugin-static-copy | MIT | 构建期,不进产物 |
| LXGW WenKai 霞鹜文楷 | **SIL OFL 1.1**(有附加条件,见下) | 界面字体 |
| 《清明上河图》张择端本扫描件 | 公有领域 | 对照原画与切片贴图 |
| Draco / Basis / Meshopt 解码器 | MIT(随 three.js) | GLB 压缩解码 |

---

## 1. 本项目代码 —— MIT

见仓库根目录 [`LICENSE`](LICENSE)。`package.json` 的 `license` 字段声明为 `MIT`,
两者一致。

> ⚠️ **版权人待确认。** `LICENSE` 里的版权行写的是 `hyp13048196060`,
> 取自本仓库的 git 提交者身份 —— 因为 `package.json` 里没有 `author` 字段,
> 我没有别的依据可填。**这不是一个核实过的结论,是一个占位。** 你要是想用自己的
> 真名或别的署名,直接改 `LICENSE` 第一行即可,别的地方没有引用它。
> 公开发布前请确认这一行。

---

## 2. 运行期依赖

以下版本号与许可字段读自 `node_modules/<包>/package.json` 本体(不是从
文档或搜索结果抄的):

| 包 | 版本 | 许可 | 上游 |
|---|---|---|---|
| `three` | 0.186.0 | MIT | https://github.com/mrdoob/three.js |
| `@types/three` | 0.186.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `typescript` | 7.0.2 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| `vite` | 8.3.0 | MIT | https://github.com/vitejs/vite |
| `vite-plugin-static-copy` | 4.1.1 | MIT | https://github.com/sapphi-red/vite-plugin-static-copy |

TypeScript 与 Vite 只在构建期使用,不会出现在 `dist/` 产物里。`three` 会进产物。

### Draco / Basis / Meshopt 解码器

`dist/draco/`、`dist/basis/`、`dist/meshopt/` 三个目录**不是**独立第三方素材,
它们由 `vite-plugin-static-copy` 在构建时从
`node_modules/three/examples/jsm/libs/` 复制而来(配置见
[`vite.config.ts`](vite.config.ts) 的 `targets`),因此适用 three.js 自身的 MIT 许可,
不需要单独署名。

**仓库里不提交这些二进制**,靠 `npm ci` + `npm run build` 现取 ——
这既满足了「解码器包含在运行资产中」,又不用把 wasm 塞进 git。
细节与踩过的坑见 [`docs/04-离线部署说明.md`](docs/04-离线部署说明.md)。

---

## 3. 字体:LXGW WenKai 霞鹜文楷 ⚠️ 有附加条件

这是本文件里唯一**带条件**的许可,请读完这一节再用。

### 基本信息

| 项 | 值 | 依据 |
|---|---|---|
| 字体 | LXGW WenKai(霞鹜文楷) | — |
| 版本 | 1.522(2026-03-17) | 源字体 `name` 表 `nameID 5` |
| 版权 | Copyright 2021-2026 LXGW;Copyright 2020 The Klee Project Authors | 源字体 `name` 表 `nameID 0` |
| 上游 | https://github.com/lxgw/LxgwWenKai | `nameID 0` 内网址 |
| 许可 | SIL Open Font License 1.1 | 源字体 `nameID 13`:「This Font Software is licensed under the SIL Open Font License, Version 1.1.」 |
| 许可全文 | https://openfontlicense.org | 源字体 `nameID 14` |

字体本身派生自 FONTWORKS 的 Klee One(`nameID 0` 里的第二行版权),
霞鹜文楷是它的中文衍生版。

### 我们做了什么:子集化

界面字体栈原本只写 `"LXGW WenKai", "Noto Sans CJK SC", …, system-ui` ——
**同一份代码在装了字体和没装字体的机器上长相不同**,这对一个交付出去给人看的
项目是不能接受的(这是它进「已知局限」的原因,见
[`docs/08-已知局限与未做还原.md`](docs/08-已知局限与未做还原.md))。
所以把字体本身放进运行资产。

但源字体两个字重各 24 MB(合计约 49 MB),对网页首屏不可接受。
因此用 [`tools/build_font_subset.py`](tools/build_font_subset.py) 子集化:
扫描 `index.html` 与 `src/` 下全部 `.ts/.js/.json/.css/.html` 的字面量,
只保留界面真正用得到的字。

- 产物:`src/assets/fonts/lxgw-wenkai-{regular,medium}.woff2`
- 当前子集:**1697 个字形**,两个文件各约 344 KB(源字体 24.4 MB → 缩小约 70 倍)
- 子集化后逐个字符回查 cmap,确认界面用字全覆盖;有 4 个非汉字符号
  (`∘ ▸ ◂ ️`)源字体本身就没有字形,回退到系统字体,属已知边界

> 一个可能反直觉的性质:**子集是按 `src/` 里的字面量算的,而注释也算字面量。**
> 所以改一段源码注释里的中文,重新构建出来的字体字节数会跟着变。
> 方向是安全的(只会多收,不会漏字),但看到 woff2 大小变动时不必惊讶。
> 想核实某个 woff2 到底收了哪些字,用前面那条回查逻辑即可。

### ⚠️ 附加条件:保留字体名

上游 OFL 的版权行声明了 **Reserved Font Name**:

> Copyright 2021-2026 LXGW (https://github.com/lxgw/LxgwWenKai),
> with Reserved Font Name '霞鹜', '霞鶩', '落霞孤鹜', '落霞孤鶩' and 'LXGW'.

OFL 第 3 条本来禁止修改版使用保留名。**但上游给了一条附加许可**,
恰好覆盖本项目的用法:

> **[ADDITIONAL PERMISSION]** The Reserved Font Names '霞鹜', '霞鶩', '落霞孤鹜',
> '落霞孤鶩' and 'LXGW' may continue to be used in Modified Versions recompiled
> from the Original Version, without modifications to the font source code;
> or in Modified Versions subsetted or converted to other formats
> (e.g., WOFF/WOFF2) **solely for web font delivery**, provided such Modified
> Versions are **not made available as installable desktop fonts**
> (e.g., on mainstream platforms like Google Fonts, or third-party
> non-commercial platforms recognized by the author @lxgw; other web font
> platforms please contact the author @lxgw for confirmation).

对照本项目的实际用法:

| 附加许可的要求 | 本项目 |
|---|---|
| 子集化 / 转成 WOFF2 | ✅ 正是这么做的 |
| **仅用于网页字体分发** | ✅ 随本站点作为网页字体加载,无其他分发 |
| **不得作为可安装的桌面字体提供** | ✅ 未上传到 Google Fonts 或任何字体平台 |

**所以保留 `LXGW WenKai` 这个名字是允许的,不需要改名。**

> 这条许可的边界要留给后来人:**它只覆盖「网页字体分发」。**
> 如果你把这个 `.woff2` 抠出来挂到某个字体站、放进字体包、或做成可安装的桌面字体,
> 那就超出了这条附加许可,需要另找 @lxgw 确认。删掉这行字并不会让限制消失。

### 许可全文的存放位置

OFL 要求「每一份副本都带有上述版权声明与本许可」。本项目从两处满足:

1. **仓库存全文**:[`public/fonts/LXGW-WenKai-OFL.txt`](public/fonts/LXGW-WenKai-OFL.txt)
   (5171 字节,含上游版权行与附加许可,以及 OFL 1.1 全文)。
   放在 `public/` 是为了构建后原样出现在 `dist/fonts/`,跟着站点一起分发。
2. **字体文件内部也留一份**:子集产物保留了 `name` 表的 `nameID 13`(许可描述)
   与 `nameID 14`(许可网址),所以单独把 `.woff2` 拷走的人,文件里仍然写着它是什么许可。

第 2 条不是天然就有的 —— `pyftsubset` 的 `--name-IDs` 默认值是 `0,1,2,3,4,5,6`,
**不含 13/14,许可声明会被静默删掉**。构建脚本里已显式补上并写了原因。

---

## 4. 《清明上河图》扫描件 —— 公有领域

画作本身属公有领域(北宋张择端,作者逝世逾千年)。

本项目使用的扫描件来自 Wikimedia Commons 的
`Alongtheriver_QingMing.jpg`(38414×1800,18.43 MB),
经 [`tools/slice_qingming.py`](tools/slice_qingming.py) 切成 4 段
3840×732 的 JPG,存放在 `public/original/`。

**完整的版本考证、许可依据、以及两处与原要求不符之处的记录
(高度是 732 不是 900;画卷方向与要求中所述相反,本卷自右向左读),
见 [`public/original/CREDITS.md`](public/original/CREDITS.md)。**
那份文件还写明了它自己的核实深度,不再在这里重复。

---

## 5. 仓库里**没有**的东西

按「交付一个可 clone 可构建的仓库」的要求,以下内容不入库,并说明各自如何获得:

| 未入库 | 原因 | 如何获得 |
|---|---|---|
| `node_modules/` | 依赖目录 | `npm ci` |
| `dist/` | 构建产物 | `npm run build` |
| `.fontbuild/`(源字体 24 MB ×2) | 体积 | 见 `build_font_subset.py` 顶部的下载命令 |
| `blender/out/`、`blender/assets_src/` | Blender 中间产物,可重新生成 | 跑 `blender/run_all.py` |
| `screenshots/_local/`(约 300 MB) | 迭代截图,非交付证据 | 重建方式见 [`docs/07-录制剪辑.md`](docs/07-录制剪辑.md) |
| `recordings/` | 录屏素材体积大 | 同上 |
| 软件安装包(Blender 等) | 体积与许可 | 自行从官网安装 |

---

## 6. 核实到什么程度

按本项目的规矩,把「我怎么知道的」也写清楚,免得后来人把转述当成一手证据:

- **依赖许可**(第 2 节表):**一手**。读的是 `node_modules/<包>/package.json`
  里的 `license` 字段与版本号,不是转述。
- **字体许可**(第 3 节):**一手**。三条互相独立的证据互相印证 ——
  ① 源字体 TTF 的 `nameID 13/14` 自述;
  ② `raw.githubusercontent.com` 取的 `OFL.txt`;
  ③ jsDelivr CDN 取的 `OFL.txt`。
  ②③ 两个镜像的字节**完全一致**(均 5171 字节,
  SHA-256 `1a25e35da1031c6c3436fde545bb9cb5aca954e9873afe510c834b8b79bd21a0`)。
  用的是 `main` 分支快照,不是某个 tag —— 上游若改动该文件,值会变。
- **原画扫描件**(第 4 节):**转述**,依据是
  `public/original/CREDITS.md`,而那份文件已自陈其许可引文来自搜索摘要、
  未能直接读取 Wikimedia 页面(本机网络对 Wikimedia 会重置连接)。此处不重复背书。
- **本项目版权人**(第 1 节):**未核实**,是从 git 身份取的占位值,见该节提示。
- **`LICENSE` 的 MIT 文本**:标准 MIT 正文,未经法律审查 —— 这不是法律意见。

如果你发现这里任何一条与实际不符,**以实际为准**,并请提 issue 或直接改 —
本文件的价值在于可核对,不在于说得肯定。
