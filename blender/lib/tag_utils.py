"""
导出标签 —— Blender 侧与网页侧的**接口**。

怎么到网页的
------------
    Blender 的物体自定义属性
      → 导出器 `export_extras=True`
      → glTF 节点的 `extras` 字段
      → three.js `GLTFLoader` 放进 `object.userData`
      → `propsAnim.ts` 等模块据此分发行为

这条链路已在阶段 0 实测验证(见 blender/out/caps.json 的
`gltf.export_test.glb.extras_sample`),不是推断。

为什么需要它
------------
    需求里写明"动态对象保留导出标签,方便网页驱动"。三维场景里
    桅杆要放倒、舵要转、布幌要飘、人物要走 —— 网页必须知道
    "哪个物体能动、按什么方式动、绕哪个轴心动"。把这些信息
    烤进模型,比在 JS 里硬编码一堆物体名可靠得多:Blender 侧
    改了名字,网页不会静默失效,而是能立刻发现标签缺失。

键名一律以 `qm_` 前缀,避免与 Blender 自带属性或将来接入的
其他工具链冲突。
"""

from __future__ import annotations

from typing import Any

import bpy
from mathutils import Vector

# 标签键的合法集合。写错键名会立刻报错,而不是悄悄生成一个没人读的属性。
KNOWN_KEYS = frozenset(
    {
        "qm_id",          # 唯一标识
        "qm_kind",        # 分类
        "qm_label",       # 中文显示名(热点标签用)
        "qm_anim",        # 动画方式,决定网页用哪个分发器
        "qm_pivot",       # 刚体转动轴心 "x,y,z"
        "qm_axis",        # 刚体转动轴 "x,y,z"
        "qm_zone",        # 所属区域
        "qm_lod",         # 近/中/远
        "qm_dynamic",     # 是否每帧更新
        "qm_reflect",     # 是否参与水面反射
        "qm_hotspot",     # 是否生成空间标签
        "qm_draft",       # 吃水(米)
        "qm_air",         # 水面以上总高(米)
        "qm_flex",        # 风动顶点权重所在属性的名字
        "qm_note",        # 复原依据备注(边界声明)
        # —— 以下两条是为 07_characters / lib/rig_utils 补的 ——
        #
        # 姿态模板名(与 `char_<pose>` 同一套词),以及"这个骨架的 rest
        # 姿势已经是烘好的目标姿势"的标记。
        #
        # ⚠️ 这两条**原本就在写**,只是没进这份名单 —— 而它们不是通过
        #    `TU.tag()` 写的:rig_utils 直接 `arm_obj["qm_rig"] = name`。
        #    于是"未知键一律报错"那道闸门**根本没经过它们**,直到
        #    `tasks/report_objects.py` 把全场景的 qm_* 键扫了一遍,
        #    才报出 "出现了未知标签键"。
        #
        #    留着这个例子的意义不在键名,在于:**闸门只装在一条路径上,
        #    就等于没装**。扫全场景比给每条写入路径都加断言可靠 ——
        #    前者不需要有人记得。
        "qm_rig",         # 姿态模板名(char_walk / char_punt …)
        "qm_rest_baked",  # 1 = rest 姿势已烘成目标姿态,无需再摆
        # —— 以下两条是为"一船多件"补的(03_boats) ——
        #
        # 一条漕船在场景里是**好几个物体**:船壳、人字桅、舵、橹、招。
        # 桅和舵要各自绕自己的轴心转,所以必须是独立物体;但网页那边
        # 驱动"这条船眠桅"时,得知道这几件属于**同一条船**。
        #
        # 早先想靠名字前缀(`boat_03_mast`)来认,没有采用:那是把
        # 字符串约定当成接口,Blender 侧改个命名规则,网页侧就静默失效
        # —— 而标签链路的整个意义就是让这种失效**当场报错**。
        #
        # **船壳自己也写这一项,值等于它自己的 bid。** 起初想省掉这个
        # 字段("船壳就是本体,何须指向自己"),但那样一来"一条船的全部
        # 物体"就没有单一判据了,只能退回按名字前缀去凑 —— 正是上面
        # 刚否掉的做法。自指换来的是分组判据唯一:
        #     qm_kind == "boat" 且 qm_parent == <bid>
        # 网页侧整船摇晃、整船眠桅,以及 validate 的岸线/净空/吃水
        # 三组断言,用的都是这一句。
        #
        # ⚠️ 04_buildings 起本键**不再专指船**。一座建筑同样是好几个
        #    物体(台基、屋身、格子门、格眼、屋面),各要单独量尺寸。
        #    分组句式与船完全同构:
        #         qm_kind == "building" 且 qm_parent == <bid>
        #    所以这里保持一个键、一个含义("所属父件的 qm_id,本体自指"),
        #    而不是新加一个 qm_owner 做同义词 —— 两个键表达同一种关系,
        #    迟早有人只写其中一个,而校验器只认另一个。
        "qm_parent",      # 所属父件的 qm_id(船壳 / 建筑本体写自己)
        "qm_folded",      # 眠桅状态:1 = 导出时就已放倒
        # 搁在岸上、不在水里。
        #
        # 网页侧据此**关掉整船横摇**(`hull_rock` / `mast_fold` / …)——
        # 一条架在垫木上的船跟着水面一起摇,是很显眼的假。
        #
        # ⚠️ 消费者是 `src/actors/propsAnim.ts` 里刚体分支的第一道闸。
        #    **这句话曾经是假的**:本键在阶段 4 之前打满了所有船壳,
        #    而网页侧一个读它的地方都没有 —— 那时"不摇"只是因为
        #    船体压根没有摇的标签,不是因为读了它。契约关系写着,
        #    机制不存在。现在它真的被读了,并且跳过数会进诊断。
        #
        # 顺带它也是 validate 里 boat.within_bank 的豁免凭据:那条
        # 检查要求船体横向不出水面,而上岸的船按定义就在水面外。
        # 豁免权必须由**声明**给出、并且对声明本身另有检查,否则
        # "把船挪出水面"就能换来豁免,检查形同虚设。
        "qm_beached",     # 1 = 已拖上岸,不随水晃动
        # 本件在所属船里**是哪个部件**。
        #
        # 一条船有船壳、舱篷、肋骨、属具、桅、舵、橹、招、系缆 —— 它们
        # 全都是 `qm_kind="boat"`、`qm_parent=<bid>`,光看这两个字段分不出
        # 谁是谁。原先的区分办法是 `qm_id` 的后缀(`..._fit`),但那是把
        # 命名约定当接口:命名一改,读的人静默失效。
        #
        # 取值即部件名:hull / cover / ribs / fit / mooring / mast /
        # rudder / yuloh / bow_oar。validate 的 boat.crutch 靠它找属具,
        # 网页侧也靠它找舱篷、船壳做水面折射与 LOD。
        "qm_part",        # 部件名(hull / mast / fit …)
        # —— 以下两条是为 04_buildings 补的 ——
        #
        # 屋面形制。取值限定在 `config.Building.ROOF_WHITELIST`
        # (wudian / xieshan / xuanshan)。
        #
        # 为什么要有它,而不是让校验器去看屋顶长得像什么:
        # **"这是哪种屋顶"不是能从三角形网格反推出来的事** ——
        # 悬山与硬山只差"山面有没有把檩头挑出去"这一点,
        # 而两者的网格都只是几片斜坡面。所以形制只能由**声明**给出。
        #
        # 但声明不能白给:北宋尚无硬山顶,出现 yingshan 即判形制错误
        # (`roof.whitelist`)。这条断言的能力边界同样要说清 ——
        # 它证明的是"**声明**里没有硬山",不证明"几何里真的没有硬山"。
        # 见 validate_scale.py 的 BOUNDARIES。
        "qm_roof",        # 屋面形制(wudian / xieshan / xuanshan)
        # 筒瓦垄距(米)。**屋面写了它,就等于声明"这片屋面有瓦垄"**,
        # 校验器据此挑选要量的屋面,再**从几何里把垄距量出来** —
        # 与船只那条(qm_draft 只用来找船壳,吃水另行实测)同一套做法。
        #
        # 反过来的情形也要能查:声明有瓦垄、几何上却量不出等距的垄,
        # `tile.row` 会报"量不出垄距",而不是悄悄跳过。
        "qm_tiles",       # 瓦垄距(米);写了即声明该屋面有瓦垄
        # —— 以下三条是为 05_celebrations 补的 ——
        #
        # 彩楼欢门的**杆件连接方式**。取值 `config.Celebration.BINDING`
        # (目前只有 "rope")。
        #
        # 为什么必须是显式声明、而不是"看几何猜":
        # 绑扎与榫卯在小尺度网格上**长得差不多** —— 都是两根杆相交。
        # 区别在节点处有没有多出一圈麻索、杆件有没有互相开槽咬合,
        # 而这些在远看时都读不出来。所以"这是什么连接方式"只能由声明给出,
        # 与 `qm_roof` 不能从三角形网格反推是同一个道理。
        #
        # 但声明不白给:`celebration.binding` 会**从几何里把索环数回来**
        # 与 `qm_lash_rings` 核对,声明与几何对不上就判失败。
        "qm_binding",     # 杆件连接方式(rope)
        # 1 = 有斗拱。彩楼欢门是临时构筑物,**按定义不得有斗拱**,
        # 故恒为 0;写出来是为了让"没有"这件事可断言 ——
        # 缺字段与"字段为 0"在读的人眼里是两回事。
        "qm_dougong",     # 1 = 含斗拱(彩楼欢门恒为 0)
        # 本件几何里实际生成的索环个数。**由 build 侧写入、由 validate 侧
        # 从顶点数反算核对** —— 两个数来自不同的路径,对得上才说明
        # "声明里说的绑扎"确实建进了几何。
        "qm_lash_rings",  # 索环个数(与几何反算值核对)
        # —— 以下两条是为蒙皮人物补的(07_characters) ——
        #
        # 网页拿到 `scene_characters.glb` 后,面对的是一批**同构的**
        # SkinnedMesh:同样的骨名、同样的材质命名方式。它必须知道这一具
        # 是"挑担"还是"撑船",才能决定给它派什么行为(挑担的走得慢、
        # 撑船的站在船头不动)。
        #
        # ⚠️ 为什么不用**名字前缀**去认:那是把字符串约定当接口 ——
        #    Blender 侧改个命名规则,网页侧就静默失效。本项目已经在
        #    "船的物体分组"上否掉过一次同样的做法(见上面 `qm_parent`)。
        "qm_pose",        # 姿态模板名,与 config.Character.POSES 的键一致
        "qm_bones",       # 变形骨根数。网页侧用它断言"拿到的确实是一具蒙皮"
        # —— 以下一条是为 08_assembly 补的 ——
        #
        # 1 = 这件几何**只在预览里存在,不导出**。
        #
        # 为什么要一个"排除"标记、而不是"包含"标记:标记只在需要
        # 排除时出现,所以**默认是安全的** —— 忘了写标记的后果是
        # 多导出一件(体积表上看得出来),而不是少导出一件
        # (看不出来)。本项目栽过的全是"少了东西":`scene_props.glb`
        # 整块没产出、`ROBES` 少一项被 `zip` 截断、分块名差一个字。
        #
        # ⚠️ 但它**不是唯一的排除条件**:见 `config.Export.PREVIEW_ONLY` ——
        #    集合声明与这个标记必须同时满足,缺一条就是硬失败。
        "qm_preview",     # 1 = 仅供预览,不导出
    }
)

# 允许的动画方式。网页侧 propsAnim.ts 按此分发。
ANIM_KINDS = frozenset(
    {
        "none",        # 静态
        "sway",        # 绕轴小幅摆动(柳枝、幌子)
        "wind",        # 顶点风动(布幌、旗、篷布)
        "mast_fold",   # 桅杆放倒/立起(眠桅过桥)
        "rudder",      # 舵叶转动
        "oar",         # 橹/桨划动
        # 整船横摇(阶段 4)。打在**船壳**上,轴心取水线中线、轴取船体纵轴。
        #
        # ⚠️ 它与其他船用标签**不是并列关系,是上下级**:桅/舵/橹/缆都在
        #    船壳的**子节点**下(见 build/03_boats.py 的 `_attach`),
        #    船壳一转它们跟着转。所以网页侧每帧只需要驱动船壳**一件**,
        #    不必逐个补偿 —— 那种做法漏掉一件就散架,而且不报错。
        #
        # ⚠️ 先看 `qm_beached`:已拖上岸的船**不该摇**(见该键的说明),
        #    网页侧据此跳过。打了标签而消费者主动跳过,是有意的:
        #    规则写在标签里(哪条船下了水),而不是靠"当时记得没给它打"。
        "hull_rock",
        "rotate",      # 连续旋转(水车)
        "walk",        # 程序化行走(人物)
    }
)

KIND_VALUES = frozenset(
    {
        "bridge", "boat", "building", "prop", "character",
        "terrain", "water", "gate", "tree", "vehicle",
        # 彩楼欢门。**它不归 building** —— 它是临时构筑物,不是建筑:
        # 校验器对建筑问的是"屋面什么形制、檐口多高",对欢门问的是
        # "怎么连接的、有没有斗拱"。两套问题问不到一起去,
        # 混在一个 kind 里就得靠名字去分辨,那正是本项目反复踩的坑。
        "celebration",
    }
)

LOD_VALUES = frozenset({"near", "mid", "far"})


def tag(
    obj: bpy.types.Object,
    qm_id: str,
    kind: str,
    *,
    label: str | None = None,
    anim: str = "none",
    pivot: Vector | tuple[float, float, float] | None = None,
    axis: Vector | tuple[float, float, float] | None = None,
    zone: str = "",
    lod: str = "mid",
    dynamic: bool = False,
    reflect: bool = True,
    hotspot: bool = False,
    draft: float | None = None,
    air: float | None = None,
    flex: str | None = None,
    note: str | None = None,
    **extra: Any,
) -> bpy.types.Object:
    """
    给物体打上网页可读的标签。

    参数一律做白名单校验 —— 打错字应当立刻失败,而不是产出一个
    "看起来有标签、实际网页读不到"的模型。这类静默失效最难排查。

    返回传入的 obj,便于链式调用:`tag(make(...), "bridge_main", "bridge")`。
    """
    if kind not in KIND_VALUES:
        raise ValueError(f"未知 qm_kind: {kind!r},合法值 {sorted(KIND_VALUES)}")
    if anim not in ANIM_KINDS:
        raise ValueError(f"未知 qm_anim: {anim!r},合法值 {sorted(ANIM_KINDS)}")
    if lod not in LOD_VALUES:
        raise ValueError(f"未知 qm_lod: {lod!r},合法值 {sorted(LOD_VALUES)}")

    obj["qm_id"] = qm_id
    obj["qm_kind"] = kind
    obj["qm_anim"] = anim
    obj["qm_lod"] = lod
    obj["qm_zone"] = zone
    obj["qm_label"] = label or ""
    obj["qm_dynamic"] = int(dynamic)   # 导出成整数,JS 侧读到的就是 0/1
    obj["qm_reflect"] = int(reflect)
    obj["qm_hotspot"] = int(hotspot)

    if pivot is not None:
        obj["qm_pivot"] = _fmt_vec(pivot)
    if axis is not None:
        obj["qm_axis"] = _fmt_vec(axis)
    if draft is not None:
        obj["qm_draft"] = float(draft)
    if air is not None:
        obj["qm_air"] = float(air)
    if flex is not None:
        obj["qm_flex"] = flex
    if note is not None:
        obj["qm_note"] = note

    for k, v in extra.items():
        key = k if k.startswith("qm_") else f"qm_{k}"
        if key not in KNOWN_KEYS:
            raise ValueError(
                f"未知标签键 {key!r}。若确需新增,请先加入 tag_utils.KNOWN_KEYS "
                f"并在网页侧同步处理,否则该标签不会有人读。"
            )
        obj[key] = v

    return obj


def _fmt_vec(v: Vector | tuple[float, float, float]) -> str:
    """向量存成 "x,y,z" 字符串 —— glTF 的 extras 对字符串支持最稳。"""
    return f"{float(v[0]):.6g},{float(v[1]):.6g},{float(v[2]):.6g}"


# --------------------------------------------------------------------------
# 风动顶点权重
# --------------------------------------------------------------------------


def add_flex_attribute(
    obj: bpy.types.Object,
    weight_fn,
    name: str = "flex",
) -> None:
    """
    写入风动权重颜色属性。

    为什么用**颜色**属性而不是普通 FLOAT 属性:
        阶段 0 实测发现 `export_attributes=True` **不能**导出任意属性 ——
        普通 FLOAT 属性会被完全丢弃,产物里根本不出现。glTF 只认
        COLOR_n / TEXCOORD_n / JOINTS_n / WEIGHTS_n 这些标准语义,
        没有"自定义顶点属性"这条通道。所以只能借 COLOR_0 走。
        详见 blender/API_NOTES.md 第 4 节。

    ⚠️ 网页侧的连带影响:
        存在 COLOR_0 会让 three.js 的 GLTFLoader **自动**把
        `material.vertexColors` 设为 true,风动权重会被乘进基色,
        布幌会变成黑白渐变。加载后必须显式改回 false。
        这一条已写进 API_NOTES.md,网页侧 `assets.ts` 里会处理。

    weight_fn: 传入世界坐标 Vector,返回 0..1 的权重(1 = 完全随风)。
    """
    mesh = obj.data
    attr = mesh.color_attributes.new(name=name, type="FLOAT_COLOR", domain="POINT")
    mw = obj.matrix_world
    for i, v in enumerate(mesh.vertices):
        w = float(weight_fn(mw @ v.co))
        w = max(0.0, min(1.0, w))
        # 三个通道都填同一个值:取用时只读 R 通道,填满是为了
        # 万一将来要在别的工具链里预览时不至于显示成黑块
        attr.data[i].color = (w, w, w, 1.0)


# --------------------------------------------------------------------------
# 校验与统计
# --------------------------------------------------------------------------


def collect_tags(objects) -> list[dict]:
    """把场景里所有 qm_* 标签收成一份清单,写进 manifest.json。"""
    out = []
    for obj in objects:
        if "qm_id" not in obj:
            continue
        entry = {"object": obj.name}
        for key in sorted(KNOWN_KEYS):
            if key in obj:
                entry[key] = obj[key]
        out.append(entry)
    return out


def assert_no_tags(obj: bpy.types.Object, why: str = "") -> None:
    """
    断言某物体**没有**网页标签。

    用于反向检查:不该被网页驱动的物件(静景、地形)若带上了标签,
    说明打标签的脚本写错了范围。
    """
    leaked = [k for k in obj.keys() if k.startswith("qm_")]
    if leaked:
        raise AssertionError(
            f"{obj.name} 不应带网页标签,却发现 {leaked}。{why}"
        )
