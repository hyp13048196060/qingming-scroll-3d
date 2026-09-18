#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把张择端本《清明上河图》的高清原卷扫描切成 4 段横向素材,输出到 public/original/。

为什么需要这个脚本:
  public/original/sectionN.jpg 不是手工裁的,而是由本脚本从原卷扫描件确定性地生成,
  记录在此以保证可复现 —— 重跑一次应当得到同样的像素内容。

输入:
  blender/out/_orig.jpg  (38414 x 1800, 取自 Wikimedia Commons 的 Alongtheriver_QingMing.jpg)

版面测量(见 CREDITS.md 的核对记录):
  - 横向: 原卷左右两端各有一段装裱/题签的米色空白 + 鉴藏印, 画面本体只占中间。
    逐列平均亮度在 x≈818 处从 ~205(米色装裱) 陡降到 ~111(绢本画面),
    在 x≈37616 处从 ~125 回升到 ~218; 因此画面本体横向为 [818, 37616), 宽 36798 px。
  - 纵向: 上缘 y≈21、下缘 y≈1777 各有一条扫描边缘的亮边(约 20px), 裁掉后高 1754 px。
  - 裁后画幅比例 36798 / 1754 = 20.98 : 1, 与实际文物 528.7cm x 24.8cm ≈ 21.3 : 1 基本一致。

输出:
  每段源宽 36798/4 = 9199.5 px, 缩放到宽 3840 px(缩放比 0.4174),
  高 = 1754 * 0.4174 ≈ 732 px。即每段 3840 x 732, 单段比例 5.25:1, 四段合计 15360 x 732。

注意(与需求描述的偏差):
  需求写的是"按 3840x900 输出", 但同一句里给的"全卷约 21:1、4 段各约 5.25:1"才算得通 ——
  3840/5.25 = 731, 而不是 900。3840x900 是 4.27:1, 会把画面纵向拉伸约 23%, 人物和虹桥都会变形。
  本脚本按比例正确的 3840x732 输出。若要强制 900 高, 把下面这行
      target_h = round(ah * scale)
  改成
      target_h = 900
  即可(宽度仍是 3840, 但画面会被纵向拉伸约 23%)。

用法:
  python tools/slice_qingming.py
"""

import os
import sys

from PIL import Image

# 大图会触发 PIL 的 DecompressionBomb 保护, 原卷扫描有 6900 万像素, 这里显式解除限制
Image.MAX_IMAGE_PIXELS = None

# 仓库根目录(本脚本在 tools/ 下)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SRC = os.path.join(ROOT, "blender", "out", "_orig.jpg")
OUT_DIR = os.path.join(ROOT, "public", "original")

# 画面本体的像素范围(见文件头说明)
CROP_L, CROP_T, CROP_R, CROP_B = 818, 22, 37616, 1776

SECTIONS = 4          # 切成几段
TARGET_W = 3840       # 每段目标宽度
JPEG_QUALITY = 78     # 先试 78, 再按 3MB 总预算调整
JPEG_SUBSAMPLING = 0  # 4:4:4, 画面细节密, 不做色度抽样以免绢本淡彩发灰


def main() -> int:
    if not os.path.exists(SRC):
        print(f"[错误] 找不到源图: {SRC}", file=sys.stderr)
        print("       请先取得原卷扫描(见 public/original/CREDITS.md)。", file=sys.stderr)
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)

    im = Image.open(SRC)
    if im.mode != "RGB":
        im = im.convert("RGB")
    print(f"源图: {SRC}  {im.size[0]} x {im.size[1]}")

    # 裁到画面本体
    art = im.crop((CROP_L, CROP_T, CROP_R, CROP_B))
    aw, ah = art.size
    print(f"画面本体: {aw} x {ah}  (比例 {aw / ah:.2f} : 1)")

    # 缩放比按目标宽算; 高度由比例推出, 不强制拉伸
    scale = TARGET_W / (aw / SECTIONS)
    target_h = round(ah * scale)
    print(f"每段源宽 {aw / SECTIONS:.1f} px -> 缩放比 {scale:.5f} -> 每段 {TARGET_W} x {target_h}")

    total = 0
    for i in range(SECTIONS):
        # 用浮点边界取整, 保证四段首尾相接、不重不漏
        x0 = round(aw * i / SECTIONS)
        x1 = round(aw * (i + 1) / SECTIONS)
        seg = art.crop((x0, 0, x1, ah))
        out = seg.resize((TARGET_W, target_h), Image.LANCZOS)

        path = os.path.join(OUT_DIR, f"section{i + 1}.jpg")
        out.save(
            path,
            "JPEG",
            quality=JPEG_QUALITY,
            subsampling=JPEG_SUBSAMPLING,
            optimize=True,
            progressive=True,
        )
        n = os.path.getsize(path)
        total += n
        print(f"  section{i + 1}.jpg  源 x[{x0},{x1})  {out.size[0]}x{out.size[1]}  {n / 1024:.0f} KB")

    print(f"合计 {total / 1024:.0f} KB  ({total / 1024 / 1024:.2f} MB)  预算 3 MB")
    if total > 3 * 1024 * 1024:
        print("[警告] 超出 3MB 预算, 请下调 JPEG_QUALITY。", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
