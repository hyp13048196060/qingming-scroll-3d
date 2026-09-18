"""
构建脚本加载器。

为什么需要它
------------
build/ 下的脚本按计划的命名约定叫 `00_layout.py`、`01_bridge.py`……
这个命名保留了执行顺序的直观性,但**以数字开头的名字不是合法的
Python 标识符**,`import 01_bridge` 是语法错误。

所以只能按文件路径加载。这个小模块把那段样板代码收在一处,
避免每个任务脚本各写一遍。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

BLENDER_DIR = Path(__file__).resolve().parents[1]
BUILD_DIR = BLENDER_DIR / "build"
TASKS_DIR = BLENDER_DIR / "tasks"

if str(BLENDER_DIR) not in sys.path:
    sys.path.insert(0, str(BLENDER_DIR))


def _load(path: Path, mod_name: str) -> ModuleType:
    if not path.exists():
        raise FileNotFoundError(f"找不到构建脚本: {path}")
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法为 {path} 建立加载器")
    mod = importlib.util.module_from_spec(spec)
    # 先注册再执行:脚本内部若有循环导入或自引用才能拿到同一个模块对象
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


def load_build(name: str) -> ModuleType:
    """加载 build/<name>.py。name 形如 "01_bridge"(不带 .py)。"""
    return _load(BUILD_DIR / f"{name}.py", f"qm_build_{name}")


def load_task(name: str) -> ModuleType:
    """加载 tasks/<name>.py。"""
    return _load(TASKS_DIR / f"{name}.py", f"qm_task_{name}")
