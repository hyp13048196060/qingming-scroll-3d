"""
建模总控。一条命令把"建场景 → 校验形制 → 场景统计 → 导出 GLB → 写清单"跑完。

用法:
    blender.exe --background --factory-startup --python blender/run_all.py -- --stage 1
    blender.exe --background --factory-startup --python blender/run_all.py -- --stage 2 --seed 20240601

为什么必须 `--factory-startup`
------------------------------
用户的本机首选项(单位制、插件、默认材质)会污染结果。
`--factory-startup` 也不能省 —— 但注意它**仍会载入默认启动场景**
(Cube/Camera/Light),所以每个 builder 的第一步都是
`BU.clear_scene_once()`,见 API_NOTES.md 第 3 节。

⚠️ 是 **clear_scene_once**,不是 clear_scene。
   阶段 2 起本脚本在同一个 Blender 会话里顺序跑 9 个 builder;
   裸调 clear_scene 会让后一个 builder 把前一个建的整个抹掉,
   而日志上完全看不出异常。

为什么形制校验是**硬门禁**
--------------------------
"不伪造考古准确性"这条要求要落到可执行的地方,而不是写在文档里。
`tasks/validate_scale.py` 断言不过就**不产出 GLB** —— 让错误在建的
时候就炸,而不是等发布出去被人指出桥墩还在。

门禁的能力边界同样重要:它量的是**几何与 config 声明是否一致**,
不是"config 声明是否符合北宋原物"。前者可自动化,后者不能。
详见该文件末尾的 BOUNDARIES 与 out/validate.json。

⚠️ 本脚本**尚未覆盖**的:阶段 3–5 的东西(网页交互、动画特效、性能采集)
   都不在这里 —— 本脚本只到"交出四个 GLB 与两份报告"为止。

   曾经这里写着"尚未覆盖 00、02–08 各 builder"。那句话在 00/02–08
   补齐之后**留了很久**,而我照着它去读日志,把一次"9 个 builder
   全跑过"的运行读成了"只跑了阶段 1 那一个"。注释过期与注释写错
   一样会骗人,只是它骗的是下一个读它的人。
"""

from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

import bpy

BLENDER_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BLENDER_DIR.parent
sys.path.insert(0, str(BLENDER_DIR))

import config as C  # noqa: E402
from lib import modules as MOD  # noqa: E402


# --------------------------------------------------------------------------
# 各阶段需要跑哪些 builder(顺序即依赖顺序)
#
# 顺序不是随便排的:后建的可以引用先建的坐标(例如彩楼欢门要贴在
# 某个店铺的门脸上),反过来则不行。
# --------------------------------------------------------------------------
STAGE_BUILDS: dict[str, tuple[str, ...]] = {
    "1": ("01_bridge",),
    "2": (
        "00_layout",
        "01_bridge",
        "02_river",
        "03_boats",
        "04_buildings",
        "05_celebrations",
        "06_props",
        "07_characters",
        "08_assembly",
    ),
}


def parse_args(argv: list[str]) -> dict:
    """解析 `--` 之后的参数。"""
    opts: dict[str, str] = {}
    if "--" not in argv:
        return opts
    rest = argv[argv.index("--") + 1 :]
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok.startswith("--"):
            key = tok[2:]
            val = rest[i + 1] if i + 1 < len(rest) and not rest[i + 1].startswith("--") else ""
            opts[key] = val
            i += 2 if val else 1
        else:
            i += 1
    return opts


def run_builds(names: tuple[str, ...]) -> tuple[list[str], list[str]]:
    """
    逐个跑 builder。返回 (跑成功的, 缺失的)。

    缺失的 builder 是**报出来**而不是跳过的:阶段 2 要跑 9 个脚本,
    若其中 6 个还不存在却只是安静跳过,最后会导出一个残缺的场景,
    而看日志的人以为一切正常。
    """
    ok: list[str] = []
    missing: list[str] = []

    for name in names:
        path = BLENDER_DIR / "build" / f"{name}.py"
        if not path.exists():
            missing.append(name)
            continue
        print("-" * 70)
        print(f"构建 {name}")
        print("-" * 70)
        mod = MOD.load_build(name)
        stats = mod.build()
        for k, v in stats.items():
            if isinstance(v, (list, tuple, dict)):
                continue  # 长列表(如节点角)不进日志
            print(f"    {k:<20} {v}")
        ok.append(name)

    return ok, missing


def run_validate(*, stage: int, strict: bool) -> str:
    """
    跑形制校验。返回 "pass"。

    ⚠️ 校验脚本不存在时返回 "missing" 而**不是** "pass"。
       调用方必须把 missing 当成"未验证"如实报出去。

    stage / strict 的用法见 main():strict 只在"本次该跑的 builder
    一个不缺"时才开,而它盯的是**本阶段应验而未验**的条目。
    于是 --stage 2 那天,漏实现的形制断言会让构建失败,
    而 --stage 1 不会被阶段 2 才有的东西卡住。
    """
    path = BLENDER_DIR / "tasks" / "validate_scale.py"
    if not path.exists():
        return "missing"
    mod = MOD.load_task("validate_scale")
    mod.validate(stage=stage, strict=strict)
    return "pass"


def main() -> int:
    opts = parse_args(sys.argv)
    stage = opts.get("stage", "1")
    seed = int(opts.get("seed", C.SEED))
    C.SEED = seed

    names = STAGE_BUILDS.get(stage)
    if names is None:
        print(f"未知阶段 {stage!r},可选:{sorted(STAGE_BUILDS)}")
        return 2

    print("=" * 70)
    print(f"《清明上河图》三维场景 — 阶段 {stage} 构建")
    print(f"  随机种子  {seed}")
    print(f"  输出目录  {(PROJECT_DIR / 'public' / 'models')}")
    print("=" * 70)

    ok, missing = run_builds(names)

    # ⚠️ **缺 builder 是失败,不是提示。**
    #
    #   上一轮这里只是在最后打了一行 `⚠ 以下 builder 尚不存在`,然后
    #   照常导出、照常 return 0。于是日志的末尾同时出现这两行:
    #
    #       完成。7 个 builder 跑过,3 个分块
    #       ⚠ 以下 builder 尚不存在,本次**没有**执行:07_characters, 08_assembly
    #
    #   —— 一句"完成"压在"有两件事没做"上面,而退出码是 0。我随后
    #   把这次运行复述成"阶段 2d 门禁全绿",因为**我读的是退出码和
    #   通过计数,不是日志末尾**。汇总报成功、明细少东西、没人去对
    #   这两者 —— 这个项目反复栽的同一个形状,这次栽在构建总控自己身上。
    #
    #   所以判据改成:**`STAGE_BUILDS` 是这一阶段的定义**。它声明了 9 个
    #   builder,就只有 9 个都跑过才叫跑完这一阶段。缺一个就不导出、
    #   返回非零。想少跑一个,去改 `STAGE_BUILDS` —— 那样缺失会变成
    #   一次**显式的编辑**,而不是一次静默的跳过。
    if missing:
        print("!" * 70)
        print(f"✗ 本阶段声明的 {len(names)} 个 builder 里有 {len(missing)} 个不存在:")
        print(f"    {', '.join(missing)}")
        print("  本次构建**不完整**,不产出 GLB。")
        print("  已跑过的 builder 产物仅供排查,不对应任何阶段成果。")
        print("!" * 70)

    print("-" * 70)
    print("形制校验")
    print("-" * 70)
    # 本次该跑的 builder 一个不缺 ⇒ 形制断言也不许有"未执行"
    strict = not missing
    if strict:  # noqa: SIM108
        print("  全部 builder 均已执行 → strict 模式(本阶段应验而未验的形制断言判失败)")
    else:
        # ⚠️ **这一行必须打。** 少了 builder,strict 就是关的,报告里那句
        #    `未执行 0` 于是**证明不了任何事** —— 它数的是"按 strict 口径
        #    该验而未验"的条目,而 07/08 没跑,人物那几条断言根本不进这个
        #    分母。我上一轮正是把这个 `0` 读成了"一条都没漏"。
        #    数字本身没错,错的是我给它安的范围。
        print("  ⚠ 有 builder 未执行 → strict 关闭。")
        print("    下面报告里的『未执行 0』**不能**读作『没有遗漏』:")
        print("    它只统计本阶段该验的条目,而未跑的 builder 不在此列。")
    try:
        verdict = run_validate(stage=int(stage), strict=strict)
    except AssertionError as exc:
        # 硬门禁:形制错误就不产出 GLB
        print("✗ 形制校验未通过,中止导出:")
        print(f"  {exc}")
        return 1
    except Exception:
        # ⚠️ 走 `traceback.format_exc()` 打 **stdout**,不用 `print_exc()`.
        #    `print_exc` 写 stderr;重定向时它和 Blender 自己的启动 banner
        #    交错,顺序会乱到看起来像"回溯根本没打"。我为此白查了一轮,
        #    还先怀疑是 "stderr 缓冲 + os._exit 提前截断"。真因是那个
        #    回溯**一直在 stderr 里**,只是没和我读的那个文件在同一处。
        #    校验器崩了却读不到原因,比校验器不报错更坏 —— 后者我知道
        #    自己不知道,前者会让我以为已经看过了。
        print("✗ 形制校验脚本自身出错:")
        for line in traceback.format_exc().rstrip().splitlines():
            print(f"    {line}")
        sys.stdout.flush()
        return 1

    if verdict == "missing":
        print("⚠ 尚未实现 tasks/validate_scale.py —— 本次产物**未经过形制校验**。")
        print("  这表示'不伪造考古准确性'目前还没有技术保障,不能当作已完成。")
    else:
        print("✓ 形制校验通过")

    # 校验报告看完了,该说的都说了 —— 现在才拦。放在 validate 之后是为了
    # 不浪费这一次运行给出的信息(哪些断言过了、哪些没过,对补 07/08 有用)。
    if missing:
        print("=" * 70)
        print(f"✗ 阶段 {stage} 未完成:{len(missing)} 个 builder 不存在"
              f"({', '.join(missing)})")
        print("  已在导出前中止,`public/models/` 未被本次运行改写。")
        print("=" * 70)
        return 1

    # —— 场景统计 ——
    #
    # ⚠️ 放在**导出之前**,不是导出之后。两处都是对的,选前面是图两件事:
    #    1) 导出崩在半路时,stats.json 已经写出来了 —— 那时它正是唯一
    #       能说明"场景到底建成了什么样"的东西。
    #    2) 导出器会自己动选择集与依赖图。让报告描述**建出来的场景**,
    #       而不是"导出器动过之后的场景",边界才干净。
    #    代价是:它不能用来证明"导出的内容就是这个数" —— 那件事由
    #    GLB 侧的 tools/lib/glb.mjs 单独量,两份摆在一起比。
    print("-" * 70)
    print("场景统计")
    print("-" * 70)
    try:
        report_mod = MOD.load_task("report_objects")
        stats_data = report_mod.report()
        # 阶段 2 起:分块表里声明的集合必须都建出来了。
        # 阶段 1 不查 —— 那时只有虹桥,另外三块本来就还没建。
        if int(stage) >= 2:
            report_mod.assert_declared_collections(stats_data)
    except AssertionError as exc:
        print("✗ 分块声明与实际集合不符,中止导出:")
        print(f"  {exc}")
        return 1
    except Exception:  # noqa: BLE001
        # 统计脚本崩了却静默跳过,等于这份报告从来没存在过,
        # 而调用方会以为它通过 —— 所以这里是**失败**,不是提示。
        print("✗ 场景统计脚本自身出错:")
        for line in traceback.format_exc().rstrip().splitlines():
            print(f"    {line}")
        sys.stdout.flush()
        return 1

    print("-" * 70)
    print("导出")
    print("-" * 70)
    export_mod = MOD.load_build("09_export")
    manifest = export_mod.run()

    print("=" * 70)
    print(f"完成。{len(ok)} 个 builder 跑过,{len(manifest['files'])} 个分块")
    print(f"  合计 {manifest['totalBytes'] / 1048576:.2f} MB,"
          f"{manifest['totalTris']} 三角面")
    print("=" * 70)
    return 0


def _exit(code: int) -> None:
    """
    以 `code` 结束进程。

    ⚠️ **不能用 `raise SystemExit(code)`。** 实测:脚本抛异常时
       Blender 的 `--python` 处理器会把异常吞掉,**进程仍然返回 0**。
       于是"构建崩了"和"构建成功"在调用方看来一模一样 ——
       我据此写下"exit 0,46 通过"这类结论,而实际上那一次跑到了
       一半就炸了。这正是本项目反复栽的那个模式(汇总报成功、
       明细是空的),只不过这次撒谎的是退出码本身。

       `os._exit` 绕开所有解释器层的收尾,退出码是真的。代价是
       不跑 atexit、不刷缓冲区 —— 所以必须先自己 flush,
       否则日志会**丢掉最后一段**(包括 traceback,那正是最该看到的部分)。
    """
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    try:
        _exit(main())
    except SystemExit as exc:                      # main 内部若自己退出
        _exit(int(exc.code or 0))
    except BaseException:                          # noqa: BLE001
        traceback.print_exc()
        _exit(1)
