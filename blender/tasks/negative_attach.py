"""
反向测试:证明 `03_boats.py` 的**挂接自检**真的会拦下漏挂的船部件。

为什么需要这个文件
------------------
`_check_attached()` 是整船轻摇的前提。它拦的是这样一种缺陷:

    某个船部件没挂在船壳下 → 船一摇它就留在原地 → 船散架。
    而**静帧里完全看不出来**,只有摇到最大角才显形。

和 `negative_test.py` 同一个道理:一个"永远返回通过"的检查器和
没有检查器是一样的,而且更糟 —— 它会让人觉得已经查过了。

做法:把 `_attach` 换成空实现(不真的挂),断言 `build()` **会抛**。
这里不依赖"记得改回去":替换发生在模块载入之后,不改源码。

两个模式,分别对应两种真实会发生的疏忽:

    detach          所有 `_attach` 都不生效 —— 最粗心的一种
    detach_mooring  只漏掉**系缆** —— 最像真实疏忽的一种:
                    它是最后一个被建的件(在循环末尾、单独一个 if),
                    而且它的标签比其他件少几个字段(没有 qm_part),
                    看着"像是另一个体系的东西",最容易被当成不必挂。

用法:
    blender.exe --background --factory-startup \
        --python blender/tasks/negative_attach.py -- detach|detach_mooring

退出码:0 = 自检**如期拦下**(即自检是好的);1 = 自检漏过了(是坏的)。
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path

BLENDER_DIR = Path(__file__).resolve().parents[1]
if str(BLENDER_DIR) not in sys.path:
    sys.path.insert(0, str(BLENDER_DIR))

from lib import modules as MOD  # noqa: E402

MODE = (sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "detach").strip()


def _inject_detach() -> None:
    """所有构件都不挂到船壳下。"""
    mod = MOD.load_build("03_boats")
    mod._attach = lambda obj, hull: None
    mod.build()


def _inject_detach_mooring() -> None:
    """只漏掉系缆 —— 最像真实疏忽的一种。"""
    mod = MOD.load_build("03_boats")
    real = mod._attach

    def skipping_mooring(obj, hull):
        if obj is not None and obj.name.endswith("_mooring"):
            return
        return real(obj, hull)

    mod._attach = skipping_mooring
    mod.build()


INJECT = {"detach": _inject_detach, "detach_mooring": _inject_detach_mooring}


def main() -> int:
    if MODE not in INJECT:
        print(f"未知模式 {MODE!r},可选 {sorted(INJECT)}")
        return 2

    print("=" * 70)
    print(f"反向测试:{MODE} —— 期待 03_boats 的挂接自检报出失败")
    print("=" * 70)

    try:
        INJECT[MODE]()
    except AssertionError as exc:
        print()
        print("✅ 自检如期拦下:")
        print(str(exc)[:1200])
        return 0
    except Exception:
        print()
        print("❌ 抛的不是断言失败,是别的异常 —— 不算数(自检没起作用):")
        traceback.print_exc()
        return 1

    print()
    print("❌ 自检**漏过了**这个漏挂 —— 它没起到门禁作用。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
