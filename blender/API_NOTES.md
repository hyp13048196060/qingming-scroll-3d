# Blender 5.2.2 实测 API 笔记

本文件记录的是**在本机实际跑出来的**结果,不是抄文档来的。
每条都注明了验证脚本,可以重跑复核。

环境:`Blender 5.2.2 LTS` / `Python 3.13.13` / `numpy 2.3.4`,均以
`--background --factory-startup` 运行。

验证脚本:
- `blender/tasks/preflight.py` → `blender/out/caps.json`
- `blender/tasks/probe_attributes.py` → `blender/out/attr_probe.json`
- `blender/tasks/probe_attributes2.py` → `blender/out/attr_probe2.json`

---

## 1. 动态枚举不能迭代,只能靠报错信息问出来

`scene.render.engine` 是动态枚举(插件注册的引擎不在 RNA enum items 里),
RNA 层只报当前值一项。直接迭代拿不到合法值列表。

**可靠做法**:故意赋一个非法值,从异常信息里把枚举抠出来。

```python
try:
    scene.render.engine = "__PROBE__"
except Exception as e:
    # enum "__PROBE__" not found in ('BLENDER_EEVEE', 'BLENDER_WORKBENCH', 'CYCLES')
    values = re.search(r"not found in \(([^)]*)\)", str(e))
```

实测结果:`['BLENDER_EEVEE', 'BLENDER_WORKBENCH', 'CYCLES']`

`bpy.ops.export_scene.gltf` 的 `export_format` 同样如此:
`enum_items` 返回 `[]`,但**赋非法值可以问出合法值**。
`preflight.py` 里的 `probe_enum_by_invalid()` 封装了这个手法。

## 2. 渲染引擎在后台模式下**都可用**(与预期相反)

计划里假设"后台模式 EEVEE 不保证拿到 GPU 上下文"。实测三种引擎
在 `--background` 下**都能出图**,64×64 各渲一帧的耗时:

| 引擎 | 赋值 | 出图 | 64×64 首帧耗时 |
|---|---|---|---|
| `BLENDER_EEVEE` | 成功 | 成功 | **21.163s**(一次性上下文/着色器编译开销) |
| `BLENDER_WORKBENCH` | 成功 | 成功 | 0.168s |
| `CYCLES` | 成功 | 成功 | 0.164s |

结论不变但理由变了:迭代期仍首选 **WORKBENCH**(快两个数量级),
文档用图用 **CYCLES**。EEVEE 可用但首帧代价高,不适合当迭代循环里的预览器。

## 3. `--factory-startup` **仍会载入默认场景**

默认启动场景里有 `Cube` / `Camera` / `Light`。
`preflight.py` 第一次导出时产物里出现了两个 Cube —— 一个是默认场景的,
一个是脚本自己建的。

**所有构建脚本必须先清场**:

```python
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
```

## 4. ⚠️ 顶点属性的导出:`export_colors` 已被移除

**这是本次探测最重要的发现,直接决定阶段 4 的风动方案。**

Blender 5.2 的 glTF 导出器**没有** `export_colors` 了,取而代之:

| 参数 | 类型 | 默认 |
|---|---|---|
| `export_vertex_color` | ENUM `MATERIAL` / `ACTIVE` / `NAME` / `NONE` | `MATERIAL` |
| `export_vertex_color_name` | STRING | `Color` |
| `export_all_vertex_colors` | BOOLEAN | `true` |
| `export_active_vertex_color_when_no_material` | BOOLEAN | `true` |
| `export_attributes` | BOOLEAN | `false` |

### 实测结论(两轮,共 8 种组合)

**① `export_attributes=True` 不能导出任意属性。**
普通 `FLOAT` 属性(哪怕命中了 `export_attributes=True`)会被**完全丢弃**:
产物 attributes 只有 `NORMAL / POSITION / TEXCOORD_0`。
glTF 只认标准语义(COLOR_n / TEXCOORD_n / JOINTS_n / WEIGHTS_n),
没有"自定义属性"这条通道。

**② 颜色属性确实能带出去,但默认模式会产生重复属性。**
同一个名为 `flex` 的 `FLOAT_COLOR` 属性:

| 参数组合 | 产物 attributes | 文件 |
|---|---|---|
| 默认 `MATERIAL` | `COLOR_0`, **`COLOR_1`** ⚠️ | 1628 B |
| `NAME` + `export_vertex_color_name="flex"` | `COLOR_0` | 1448 B |
| `ACTIVE` | `COLOR_0` | 1452 B |
| `NAME` + `export_all_vertex_colors=False` | `COLOR_0` | 1456 B |

默认 `MATERIAL` 模式会把同一个属性**导出两遍**(兜底路径一次、
全量颜色路径一次),凭空多出一个 `COLOR_1`。

### 采用的参数

```python
export_attributes=True,                    # 仍需打开
export_vertex_color="NAME",
export_vertex_color_name="flex",           # 与 Blender 侧属性名一致
```

理由:结果**唯一且可预测**,不随材质是否引用顶点色而变,产物体积最小。
不依赖 `MATERIAL` 的动态判断,也不依赖 `_when_no_material` 兜底开关。

### 对网页侧的影响(需要在 three.js 里处理)

导出后 `flex` 落在 `geometry.attributes.color` 上,`GLTFLoader`
会因为存在 `COLOR_0` 而**自动把 `material.vertexColors` 设为 `true`** ——
原计划写的"`material.vertexColors` 保持 false"是**做不到的**,加载后必须
显式改回 `false`,否则风动权重会被乘进基色,布幌会变成黑白渐变。

正确做法:加载后遍历 `qm_flex` 标记的网格,
`material.vertexColors = false`,并在 `onBeforeCompile` 里自行声明
`attribute vec3 color;` 读取权重。

## 5. Draco / MeshOptimizer 内建可用

导出器的桥接库已随 Blender 提供,无需外部工具:

```
INFO Draco is available, use library at .../io_scene_gltf2/bf_intern_draco_bridge.dll
INFO MeshOptimizer is available, use library at .../io_scene_gltf2/bf_intern_meshopt_bridge.dll
```

实测(2 顶点平面,小到主要看固定开销):

| 压缩 | 字节 | extensionsRequired |
|---|---|---|
| 无 | — | — |
| Draco (level 6) | 1180 | `KHR_draco_mesh_compression` |
| MeshOpt | 2048 | `EXT_meshopt_compression` |

**意义**:几何压缩可以完全在 Blender 侧完成,不需要引入
`@gltf-transform/cli`(它依赖原生 `sharp`,会威胁「全新 clone → `npm ci`」的稳定性)。
运行时的 Draco 解码器仍由 `vite-plugin-static-copy` 从 `three` 复制到 `dist/`。

⚠️ 两者都会写进 `extensionsRequired`,即**解码器缺失时模型无法加载**。
导出前必须确认 `public/draco/` 与 `public/meshopt/` 已就位。

## 6. WebP 原生可写

`img.file_format = "WEBP"` + `img.save()` 实测通过(256² 往返成功)。
`scene.render.image_settings.file_format` 的枚举里也含 `WEBP`。
导出器的 `export_image_format` 可选值为 `["AUTO","JPEG","WEBP","NONE"]`。

即:贴图可以全程不依赖外部工具链,直接产出 WebP。

## 7. 其他命名漂移

- `Material.use_nodes` 已标记废弃(预计 Blender 6.0 移除)。
  新建材质的 `use_nodes` **默认为 true**,直接取 `BSDF_PRINCIPLED` 节点即可,
  **不要**再写 `mat.use_nodes = True`(会触发 `DeprecationWarning`)。
- 节点必须按 `type` 查找,不能按名字:
  `next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")`
  —— 非英文界面下节点名是本地化的。

## 8. `pixels.foreach_set` 性能

256² RGBA 写入耗时 **0.0001s**,可以忽略。
真正的约束是内存:`float32` 中间数组占 `W*H*4*4` 字节,
4096² 单张即 256MB。**默认用 1024²,上限 2048²**。

---

## 对计划的修正汇总

| 原计划 | 实测 | 处理 |
|---|---|---|
| 靠 `export_attributes=True` 带出 `flex` | 颜色属性可以,但默认模式会重复导出 | 改用 `export_vertex_color="NAME"` |
| `material.vertexColors` 保持 false | `GLTFLoader` 会强制设为 true | 加载后显式改回 false |
| "后台模式 EEVEE 不保证可用" | 三种引擎都可用,EEVEE 首帧 21s | 结论不变,理由改为"太慢" |
| 可能需要 `@gltf-transform` 做压缩 | Blender 内建 Draco/MeshOpt | 不引入该依赖 |
