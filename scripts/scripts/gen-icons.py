"""
生成 PWA 所需的 PNG 图标。

源设计来自 public/icon.svg：径向-ish 线性渐变（#6d6df0 -> #4444b8）的圆角方块 +
白色对勾。iOS Safari 完全不支持 SVG 图标（apple-touch-icon 必须是 PNG），
Chrome 的安装提示也要求 192/512 的 PNG，所以这里生成位图版本。

产出（public/icons/）：
  icon-192.png            —— 标准 192，圆角
  icon-512.png            —— 标准 512，圆角
  icon-512-maskable.png   —— 全幅渐变、图形缩小到安全区（安卓自适应图标）
  apple-touch-180.png     —— iOS 主屏图标，直角满幅（iOS 自己加圆角，不能带圆角）
  favicon-32.png          —— 浏览器标签页小图标

用法：python scripts/gen-icons.py
"""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'public' / 'icons'

# 与 icon.svg 的渐变保持一致
COLOR_FROM = (0x6D, 0x6D, 0xF0)
COLOR_TO = (0x44, 0x44, 0xB8)

# SVG 的 viewBox 是 192x192，对勾路径坐标按此比例缩放
SVG_SIZE = 192
CHECK_POINTS = [(56, 98), (82, 124), (136, 66)]
CHECK_WIDTH = 16


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_canvas(size, with_radius=True):
    """左上->右下的对角渐变。用逐行插值再旋转太慢，这里按 x+y 归一化做对角渐变。"""
    img = Image.new('RGB', (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            # 对角参数：左上 0 -> 右下 1
            t = (x + y) / (2 * (size - 1)) if size > 1 else 0
            px[x, y] = lerp(COLOR_FROM, COLOR_TO, t)
    if not with_radius:
        return img

    # 圆角蒙版（半径约为 SVG 的 44/192）
    radius = round(size * 44 / SVG_SIZE)
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(img, (0, 0), mask)
    return canvas


def draw_check(img, scale=1.0):
    """在图片中央画白色对勾。scale < 1 时整体缩小（给 maskable 的安全区留白）。"""
    size = img.size[0]
    draw = ImageDraw.Draw(img)
    cx = cy = size / 2
    svg_cx = svg_cy = SVG_SIZE / 2
    k = size / SVG_SIZE * scale

    pts = [((x - svg_cx) * k + cx, (y - svg_cy) * k + cy) for x, y in CHECK_POINTS]
    width = max(1, round(CHECK_WIDTH * k))
    draw.line(pts, fill=(255, 255, 255, 255), width=width, joint='curve')
    # 端点是平头圆角：在首尾各画一个圆，模拟 stroke-linecap="round"
    for x, y in (pts[0], pts[-1]):
        r = width / 2
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 255))
    return img


def make_icon(size, rounded=True, safe_scale=1.0):
    if rounded:
        base = gradient_canvas(size, with_radius=True)
    else:
        base = gradient_canvas(size, with_radius=False).convert('RGBA')
    return draw_check(base, scale=safe_scale)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [
        ('icon-192.png', 192, True, 1.0),
        ('icon-512.png', 512, True, 1.0),
        # maskable：系统会裁切四周约 20%，图形缩到 72% 才不会被切掉
        ('icon-512-maskable.png', 512, False, 0.72),
        # iOS：自己加圆角，所以给满幅直角底
        ('apple-touch-180.png', 180, False, 1.0),
        ('favicon-32.png', 32, True, 1.0),
    ]
    for name, size, rounded, scale in targets:
        img = make_icon(size, rounded=rounded, safe_scale=scale)
        path = OUT_DIR / name
        img.save(path, 'PNG', optimize=True)
        print(f'  {name:26} {size}x{size}  {path.stat().st_size / 1024:.1f} KB')
    print(f'\n已输出到 {OUT_DIR}')


if __name__ == '__main__':
    main()
