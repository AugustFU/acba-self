#!/usr/bin/env python3
"""Собирает dist/worker.js: шаблон Worker'а + приложение + иконки в одном файле."""
import base64, hashlib, io, json, pathlib
from PIL import Image

ROOT = pathlib.Path(__file__).parent
DIST = ROOT / 'dist'


BRAND = (173, 77, 77)  # фон логотипа


def draw_icon(size: int) -> bytes:
    """Логотип Acba Self: фон до краёв (iOS сам скруглит), знак крупнее — без воздуха вокруг."""
    logo = Image.open(ROOT / 'assets' / 'logo.png').convert('RGBA')
    base = Image.new('RGB', logo.size, BRAND)
    base.paste(logo, (0, 0), logo)  # прозрачные углы заливаются фоном → красный до краёв
    W, H = base.size
    px = logo.load()
    xs, ys = [], []
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            r, g, b, a = px[x, y]
            if a > 200 and r > 210 and g > 210 and b > 210:
                xs.append(x); ys.append(y)
    if xs:  # приблизить так, чтобы белый знак занимал ~72% ширины иконки
        cx, cy = (min(xs) + max(xs)) // 2, (min(ys) + max(ys)) // 2
        half = max(max(xs) - cx, cx - min(xs), max(ys) - cy, cy - min(ys))
        crop = min(W // 2, H // 2, round(half / 0.72))
        cx = max(crop, min(W - crop, cx)); cy = max(crop, min(H - crop, cy))
        base = base.crop((cx - crop, cy - crop, cx + crop, cy + crop))
    out = base.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def help_image() -> str:
    """Скриншот-инструкция «где взять OTP» как data-URI."""
    im = Image.open(ROOT / 'assets' / 'otp-help.png').convert('RGB')
    w = 600
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=82, optimize=True)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


def main():
    DIST.mkdir(exist_ok=True)
    html = (ROOT / 'app.html').read_text(encoding='utf-8').replace('__OTP_HELP__', help_image())
    tpl = (ROOT / 'worker.template.js').read_text(encoding='utf-8')
    icon180, icon512 = draw_icon(180), draw_icon(512)
    (DIST / 'icon-preview.png').write_bytes(icon512)
    # версия иконки = хэш её байтов: меняется сам, как только меняется логотип, и сбрасывает кэш
    ver = hashlib.md5(icon512).hexdigest()[:8]
    # версия сборки = хэш всего содержимого: меняется при любой правке, по ней приложение обновляется само
    build = hashlib.md5(html.encode() + tpl.encode() + icon512).hexdigest()[:8]
    html = html.replace('__ICON_VER__', ver).replace('__BUILD__', build)
    tpl = tpl.replace('__BUILD__', build)
    print('build', build)
    out = (tpl
           .replace('__APP_HTML__', json.dumps(html, ensure_ascii=False))
           .replace('__ICON_VER__', ver)
           .replace('__ICON_180__', json.dumps(base64.b64encode(icon180).decode()))
           .replace('__ICON_512__', json.dumps(base64.b64encode(icon512).decode())))
    assert '__APP_HTML__' not in out and '__ICON_' not in out
    print('icon version', ver)
    (DIST / 'worker.js').write_text(out, encoding='utf-8')
    print('worker.js', len(out.encode()), 'bytes')


if __name__ == '__main__':
    main()
