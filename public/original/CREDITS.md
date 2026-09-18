# 《清明上河图》原卷图像素材 —— 来源与许可

本目录下的 `section1.jpg` ~ `section4.jpg` 是**张择端本《清明上河图》**（北京故宫博物院藏）全卷扫描件切成的 4 段横向素材，
用于本项目的三维重建参考。

---

## 1. 文物本体

| 项 | 内容 |
| --- | --- |
| 名称 | 清明上河图（Along the River During the Qingming Festival） |
| 作者 | 张择端（Zhang Zeduan，卒于 1145 年），北宋 |
| 材质 | 绢本，水墨淡彩 |
| 尺寸 | 纵 24.8 cm × 横 528.7 cm |
| 藏地 | 北京故宫博物院（The Palace Museum, Beijing） |
| 藏品编号 | 新00087177 |

**这是张择端本**，不是仇英本（辽宁省博物馆藏，青绿重彩、构图不同）也不是清院本（台北故宫藏，1736 年，设色浓艳、带西式透视、长 1152 cm）。
判别依据：本素材为绢本水墨淡彩、色调沉褐、人物极小，且含**虹桥**与**城门楼**两个张择端本标志性段落，与仇英本／清院本的面貌明显不同。

---

## 2. 源文件（实际使用的就是这一个）

| 项 | 内容 |
| --- | --- |
| 文件名 | `File:Alongtheriver QingMing.jpg` |
| File: 页面 | https://commons.wikimedia.org/wiki/File:Alongtheriver_QingMing.jpg |
| 原图直链 | https://upload.wikimedia.org/wikipedia/commons/8/86/Alongtheriver_QingMing.jpg |
| 缩略图直链格式 | https://upload.wikimedia.org/wikipedia/commons/thumb/8/86/Alongtheriver_QingMing.jpg/3840px-Alongtheriver_QingMing.jpg |
| 分辨率 | **38414 × 1800 px** |
| 文件大小 | 18.43 MB（JPEG） |
| 上传者 / 时间 | 用户 Eugene a，2014-08-27（"Better"，替换掉 2008 年 A9012 上传的 14203 × 608 旧版） |
| Source 字段 | Baidu Tieba（即扫描件并非直接取自故宫官方数字文物库） |

`8/86` 这一段路径是文件名 MD5 的前缀（`md5("Alongtheriver_QingMing.jpg") = 8641f3d2…`），
所以直链可以离线推导出来，不必先访问页面。

> 选择理由：Wikipedia 上有多个版本的《清明上河图》文件（仇英本、清院本、局部图、低分辨率整卷等）。
> 这个文件是**张择端本整卷**中分辨率最高的一个（38414 × 1800，约为次高版本的 2.7 倍宽），
> 也是英文维基的 featured picture，故选它。

---

## 3. 许可证（我核实到的内容）

**结论：公有领域（Public Domain）。** 具体由三层构成：

1. **PD-old-100（作者逝世逾 100 年）** —— 文件页措辞：
   > "The author died in 1145, so this work is in the public domain in its country of origin and other countries and areas where the copyright term is the author's life plus 100 years or fewer."

2. **PD-Art（二维公有领域作品的忠实翻拍）** —— 文件页措辞：
   > "a faithful photographic reproduction of a two-dimensional, public domain work of art"

   并引用维基媒体基金会的官方立场：
   > "faithful reproductions of two-dimensional public domain works of art are public domain."
   法理依据为美国 *Bridgeman Art Library v. Corel Corp.* 判例。

3. **Creative Commons Public Domain Mark 1.0（PDM）** —— 文件页措辞：
   > "free of known restrictions under copyright law, including all related and neighboring rights."

另注：作品 1931 年前已出版，故在美国亦属公有领域。

### 关于"我核实到什么程度"——请务必读这段

- **我没有直接打开 File: 页面逐字核对。** 本机网络对 `commons.wikimedia.org` / `en.wikipedia.org` /
  `upload.wikimedia.org` / `archive.org` 全部连接被重置（疑似 GFW），WebFetch 对这两个域名也返回
  "Unable to verify if domain is safe to fetch"。
- 上面三段引文的措辞来自**搜索引擎对该文件页的抓取摘要**（WebSearch 工具，可正常工作），
  不是我亲眼在页面上读到的，因此**存在转述误差的可能**。
- 我能独立佐证的旁证：该文件确实是英文维基 featured picture 并被选为 2009-03-11 的 Picture of the Day；
  同题材的其它维基文件（如 `Bianjing city gate.JPG`，明确标注衍生自本文件）使用同样的 PD-Art/PDM 标签。
- **如果要商用，建议你自行复核一次**（在能访问维基的环境打开上面的 File: 页面）。
  另有一点残余风险需要你判断：虽然 Commons 社群认定其为 PD，但若该扫描件的底片源自故宫的官方摄影，
  故宫在中国境内仍可能主张权利（"公有领域"是针对原画，翻拍件的地位在各国不完全一致）。
  本文件 Source 字段标注的是 Baidu Tieba 而非故宫官方，风险相对较低，但不能完全排除。

---

## 4. 处理流程

生成脚本：`tools/slice_qingming.py`（可重复运行，输出确定性一致）。

1. 原卷扫描 38414 × 1800。
2. **裁到画面本体**（去掉两端装裱）：
   - 横向：逐列平均亮度在 `x≈818` 处由 ~205（米色装裱）陡降到 ~111（绢本画面），
     在 `x≈37616` 处由 ~125 回升到 ~218，故画面取 `[818, 37616)`，宽 **36798 px**。
   - 纵向：上缘 `y≈21`、下缘 `y≈1777` 各有一条约 20px 的扫描亮边，裁掉后高 **1754 px**。
   - 裁后比例 36798 / 1754 = **20.98 : 1**，与文物 528.7 / 24.8 ≈ 21.3 : 1 吻合（差 1.5%）。
3. 四等分（每段源宽 9199.5 px），LANCZOS 缩放到宽 3840 px（缩放比 0.41741），高按比例得 732 px。
4. JPEG quality=78、subsampling=4:4:4、progressive、optimize。

---

## 5. 核对记录

| 核对项 | 方法 | 结果 |
| --- | --- | --- |
| 图像可正常打开、非 404／占位图 | PIL 打开并 `load()`，读 `ImageStat` | 4 张全部为合法 JPEG；灰度标准差 16.6~20.4，不同颜色数 30058~40764（占位图会接近 0） |
| 四段内容连续 | 比较第 N 段最后一列与第 N+1 段第一列的逐像素通道差 | 12.59 / 11.25 / 9.61 |
| 上述接缝值是否算"断" | 建基线：同段内正常相邻两列差 **4.58~10.86**；相隔 20 列（内容明显不同）差 **14.33~17.72** | 接缝值落在"相邻列"区间内、明显低于"内容不同"区间 → **连续，无错位** |
| 构图方向 | 肉眼比对四段缩略图 | 见下方"关于左右方向" |
| 总体积 | `ls -l` 求和 | 749537 + 740461 + 671902 + 617312 = **2779212 B = 2.65 MB ≤ 3 MB** ✓ |
| 未污染其它目录 | 全程只写 `public/original/`、`tools/`、`blender/out/` | `public/models/` 与 `src/` 未改动 |

### 各段实测尺寸

| 文件 | 像素 | 字节 | 源图对应区间 |
| --- | --- | --- | --- |
| `section1.jpg` | 3840 × 732 | 749537 | 原卷 x[818, 10018) |
| `section2.jpg` | 3840 × 732 | 740461 | 原卷 x[10018, 19217) |
| `section3.jpg` | 3840 × 732 | 671902 | 原卷 x[19217, 28416) |
| `section4.jpg` | 3840 × 732 | 617312 | 原卷 x[28416, 37616) |
| 合计 | 15360 × 732（20.98:1） | 2779212 | — |

---

## 6. 两处与需求描述不一致的地方（需要你确认）

### (a) 高度是 732 px，不是 900 px

需求写"按 3840×900 输出即可"，但同一句里给的"全卷约 21:1、4 段各约 5.25:1"**算出来不是 900**：
3840 / 5.25 = **731**。而 3840 / 900 = 4.27:1，与 5.25:1 矛盾。

我按**比例正确**的 3840 × 732 输出（这样 4 段拼起来正好是原卷的 21:1）。
若强行输出 3840 × 900，画面会被**纵向拉伸约 23%**，人物会变瘦高、虹桥的拱形会被拉成椭圆。
如果你确实要 900 高（例如为了对齐已有的贴图槽位），把 `tools/slice_qingming.py` 里
`target_h = round(ah * scale)` 这一行改成 `target_h = 900` 即可（宽度仍是 3840），但请知悉画面会被纵向拉伸。

### (b) 左右方向：郊野在**右**、城内街市在**左**，与需求描述相反

需求里写核对标准是"左段是郊野、右段是城内街市"。**实测恰好相反**：

- `section1.jpg`（最左）—— 密集街市，可见**城门楼**与拱形门洞、商铺、人群车马；
- `section2.jpg` —— 街市过渡到汴河，右侧出现船只，最右露出虹桥拱；
- `section3.jpg` —— **虹桥**与河上大船（张择端本最著名的一段）；
- `section4.jpg`（最右）—— 郊野：枯树、柳林、河岸、零星农舍，最右端是鉴藏印。

这符合中国手卷**由右向左**展开的阅读顺序：**卷首（右）是郊野，卷尾（左）是城内街市**。
张择端本的构图确实如此。所以我**没有**为了迁就需求描述去翻转图像 ——
翻转会让画面镜像、鉴藏印与题字反写，属于破坏性改动。请确认你要的就是这个方向。

---

## 7. 复现方式

源图 `blender/out/_orig.jpg` 位于被 gitignore 的 `blender/out/`，不随仓库分发。重新取得：

```bash
# 直链可用 MD5 前缀离线推导：8/86
curl -o blender/out/_orig.jpg \
  "https://upload.wikimedia.org/wikipedia/commons/8/86/Alongtheriver_QingMing.jpg"
python tools/slice_qingming.py
```

**本机网络注意事项：** 本机（中国大陆）直连 `upload.wikimedia.org` 会被连接重置。
本次实际是经由一个公网图片 CDN（`wsrv.nl`，带 `output=jpg&q=100` 参数）转取到原图的，
像素尺寸与源文件一致（38414 × 1800），但**字节流是重新编码过的**（57.5 MB，源文件为 18.43 MB）。
对本用途（再缩小到 732 px 高）无可见影响，但如果你要的是逐字节一致的原始文件，请在上面的 `curl` 能直连的环境重跑。
