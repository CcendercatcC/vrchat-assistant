#!/usr/bin/env python3
"""
prepare_emoji_image.py — 将任意图片处理为正方形（VRChat 自定义 emoji 要求方形）

用法:
  python prepare_emoji_image.py --input <图片路径> --output <输出路径> [--mode fit|pad|smart] [--crop-box x1,y1,x2,y2] [--size 1024]

模式说明:
  fit   中心裁剪成正方形后缩放到 size（ImageOps.fit 内容感知，主体居中时最佳）
  pad   四周补透明边成正方形（不裁剪任何内容，适合主体贴边的图）
  smart 按视觉模型给出的主体边界框 --crop-box 裁剪成正方形（主体明显偏移时）

输出: 正方形 PNG（带透明通道，适配 VRChat emoji）
"""
import argparse
import os
import sys
from PIL import Image, ImageOps

def make_square(img, mode="fit", crop_box=None, size=1024):
    """Return a square image of the given size."""
    w, h = img.size

    if mode == "pad":
        # 补边成方形（不裁剪）
        side = max(w, h)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        offset = ((side - w) // 2, (side - h) // 2)
        canvas.paste(img.convert("RGBA"), offset)
        square = canvas
    elif mode == "smart":
        if not crop_box:
            raise ValueError("smart 模式需要 --crop-box 'x1,y1,x2,y2'")
        x1, y1, x2, y2 = [float(v) for v in crop_box.split(",")]
        # 归一化坐标（0~1）转像素；若已是像素坐标则原样用
        if x1 <= 1 and y1 <= 1 and x2 <= 1 and y2 <= 1:
            x1, y1, x2, y2 = x1 * w, y1 * h, x2 * w, y2 * h
        x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)
        # clamp
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        if x2 - x1 <= 0 or y2 - y1 <= 0:
            raise ValueError(f"非法裁剪框: {crop_box}")
        # 以边界框为中心扩成正方形（在图片范围内）
        bw, bh = x2 - x1, y2 - y1
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        half = max(bw, bh) / 2
        left = max(0, int(cx - half))
        top = max(0, int(cy - half))
        right = min(w, int(cx + half))
        bottom = min(h, int(cy + half))
        # 若扩展到图片边界仍非方形（贴边情况），则 pad 到方形
        if right - left != bottom - top:
            side = max(right - left, bottom - top)
            canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
            canvas.paste(img.convert("RGBA").crop((left, top, right, bottom)), (0, 0))
            square = canvas
        else:
            square = img.convert("RGBA").crop((left, top, right, bottom))
    else:  # fit
        square = ImageOps.fit(img.convert("RGBA"), (size, size), Image.LANCZOS)

    # 统一缩放到目标 size
    if square.size != (size, size):
        square = square.resize((size, size), Image.LANCZOS)
    return square

def main():
    ap = argparse.ArgumentParser(description="处理图片为正方形（VRChat emoji 用）")
    ap.add_argument("--input", required=True, help="输入图片路径")
    ap.add_argument("--output", required=True, help="输出 PNG 路径")
    ap.add_argument("--mode", choices=["fit", "pad", "smart"], default="fit")
    ap.add_argument("--crop-box", help="smart 模式: 主体边界框 'x1,y1,x2,y2'（像素或 0~1 归一化）")
    ap.add_argument("--size", type=int, default=1024)
    args = ap.parse_args()

    if not os.path.exists(args.input):
        print(f"错误: 输入文件不存在: {args.input}", file=sys.stderr)
        sys.exit(1)

    try:
        img = Image.open(args.input)
        img.load()
    except Exception as e:
        print(f"错误: 无法读取图片 {args.input}: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"原始尺寸: {img.size} ({img.format}, {img.mode})")

    try:
        square = make_square(img, mode=args.mode, crop_box=args.crop_box, size=args.size)
    except ValueError as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    square.save(args.output, "PNG")
    print(f"✅ 已输出正方形图: {args.output} ({square.size}, 模式={args.mode})")

if __name__ == "__main__":
    main()
