"""
Genera las imágenes y vídeos de la demo web (todo dibujado aquí, sin material de terceros):
portadas de los clips, miniaturas de YouTube, avatar del canal, miniaturas A/B/C y vídeo del
«vídeo largo» de prueba. Necesita Pillow y ffmpeg.

    python demo/make_media.py demo/out/media.json demo/web/media
"""
import json
import os
import subprocess
import sys
import tempfile
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT_DIRS = ['/usr/share/fonts/opentype/inter', 'C:/Windows/Fonts']


def font(size, bold=True):
    for d in FONT_DIRS:
        for name in (['Inter-ExtraBold.otf', 'Inter-Bold.otf', 'segoeuib.ttf'] if bold else ['Inter-Medium.otf', 'Inter-Regular.otf', 'segoeui.ttf']):
            p = os.path.join(d, name)
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    return ImageFont.load_default()


PALETTES = {
    'ciencia': ((20, 60, 140), (32, 178, 170), '🔬'),
    'emprende': ((120, 50, 10), (230, 150, 40), '💼'),
    'cocina': ((140, 25, 45), (240, 100, 80), '🍳'),
}


def gradient(w, h, a, b):
    img = Image.new('RGB', (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = (x / w * 0.35 + y / h * 0.65)
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return img


def wrap(draw, text, f, max_w):
    words, lines, cur = text.split(), [], ''
    for w in words:
        test = (cur + ' ' + w).strip()
        if draw.textlength(test, font=f) <= max_w:
            cur = test
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def cover(title, campaign, w=360, h=640):
    a, b, _ = PALETTES[campaign]
    img = gradient(w, h, a, b)
    d = ImageDraw.Draw(img, 'RGBA')
    # formas suaves de fondo
    d.ellipse((-w * 0.4, h * 0.55, w * 0.9, h * 1.3), fill=(255, 255, 255, 22))
    d.ellipse((w * 0.45, -h * 0.15, w * 1.4, h * 0.4), fill=(0, 0, 0, 30))
    f = font(int(w * 0.105))
    lines = wrap(d, title.upper(), f, w * 0.84)
    lh = int(w * 0.125)
    y0 = int(h * 0.62 - len(lines) * lh / 2)
    for i, line in enumerate(lines):
        y = y0 + i * lh
        d.rectangle((w * 0.06, y - 4, w * 0.06 + d.textlength(line, font=f) + 16, y + lh - 8), fill=(0, 0, 0, 120))
        d.text((w * 0.06 + 8, y), line, font=f, fill=(255, 255, 255))
    tag = {'ciencia': 'CIENCIA', 'emprende': 'PODCAST', 'cocina': 'COCINA'}[campaign]
    ft = font(int(w * 0.05))
    d.rounded_rectangle((w * 0.06, h * 0.08, w * 0.06 + d.textlength(tag, font=ft) + 28, h * 0.08 + w * 0.09), radius=8, fill=(255, 255, 255, 235))
    d.text((w * 0.06 + 14, h * 0.08 + w * 0.018), tag, font=ft, fill=a)
    d.text((w * 0.06, h * 0.92), 'DEMO', font=font(int(w * 0.04), False), fill=(255, 255, 255, 170))
    return img


def avatar(size=240):
    img = gradient(size, size, (90, 110, 255), (60, 200, 170))
    d = ImageDraw.Draw(img)
    f = font(int(size * 0.38))
    t = 'CD'
    d.text(((size - d.textlength(t, font=f)) / 2, size * 0.27), t, font=f, fill=(255, 255, 255))
    return img


def long_thumb(letter, w=1280, h=720):
    variants = {
        'A': ((14, 18, 32), (40, 70, 160), ['CHECKLIST', 'SEMANAL'], 'Mantenimiento de canal'),
        'B': ((20, 20, 20), (180, 40, 40), ['AUDITORÍA', 'EN 10 MIN'], 'Lo que reviso cada lunes'),
        'C': ((10, 40, 30), (30, 160, 110), ['NADIE HACE', 'ESTO'], 'Y tu canal lo nota'),
    }
    a, b, big, small = variants[letter]
    img = gradient(w, h, a, b)
    d = ImageDraw.Draw(img, 'RGBA')
    # «panel» de métricas dibujado a la derecha
    px0, py0 = int(w * 0.58), int(h * 0.18)
    d.rounded_rectangle((px0, py0, w - 70, h - 110), radius=28, fill=(255, 255, 255, 235))
    d.text((px0 + 36, py0 + 30), 'Retención media', font=font(30, False), fill=(60, 60, 70))
    d.text((px0 + 36, py0 + 68), '58 %', font=font(64), fill=(20, 20, 30))
    bars = [0.45, 0.62, 0.38, 0.8, 0.7, 0.92, 0.66]
    bw, base = 42, h - 150
    for i, v in enumerate(bars):
        x = px0 + 40 + i * (bw + 16)
        d.rounded_rectangle((x, base - v * 230, x + bw, base), radius=8, fill=b + (255,))
    f = font(108)
    for i, line in enumerate(big):
        d.text((70, 150 + i * 120), line, font=f, fill=(255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0))
    d.text((74, 420), small, font=font(44, False), fill=(235, 235, 240))
    d.rounded_rectangle((70, h - 120, 330, h - 60), radius=14, fill=(255, 210, 60))
    d.text((92, h - 112), 'YOUTUBE', font=font(40), fill=(20, 20, 20))
    return img


def slide(title, items, w=1280, h=720, n=0):
    img = gradient(w, h, (12, 14, 22), (34, 48, 110))
    d = ImageDraw.Draw(img, 'RGBA')
    d.text((90, 90), title, font=font(64), fill=(255, 255, 255))
    for i, it in enumerate(items):
        y = 230 + i * 92
        d.rounded_rectangle((90, y, 140, y + 50), radius=10, fill=(90, 200, 150))
        d.text((101, y + 2), '✓' if False else str(i + 1), font=font(38), fill=(10, 30, 20))
        d.text((170, y + 2), it, font=font(40, False), fill=(230, 232, 240))
    d.text((90, h - 70), f'Vídeo de prueba · demo de CONTENT OS · {n}/4', font=font(24, False), fill=(160, 165, 185))
    return img


def video_from_images(images, out, seconds=4, size=None):
    tmp = tempfile.mkdtemp()
    paths = []
    for i, im in enumerate(images):
        p = os.path.join(tmp, f'{i:02d}.png')
        im.save(p)
        paths.append(p)
    lista = os.path.join(tmp, 'list.txt')
    with open(lista, 'w') as fh:
        for p in paths:
            fh.write(f"file '{p}'\nduration {seconds}\n")
        fh.write(f"file '{paths[-1]}'\n")
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lista,
                    '-vf', 'fps=25,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-movflags', '+faststart', out], check=True)


def main(manifest, out):
    m = json.load(open(manifest))
    for sub in ('thumb', 'clip', 'ytthumb', 'avatar', 'long', 'long-thumb'):
        os.makedirs(os.path.join(out, sub), exist_ok=True)
    for c in m['clips']:
        img = cover(c['title'], c['campaign'])
        img.save(os.path.join(out, 'thumb', c['id'] + '.jpg'), quality=86)
        video_from_images([img], os.path.join(out, 'clip', c['id'] + '.mp4'), seconds=3)
    for v in m['videos']:
        cover(v['title'], v['campaign']).save(os.path.join(out, 'ytthumb', v['videoId'] + '.jpg'), quality=84)
    avatar().save(os.path.join(out, 'avatar', m['channel'] + '.jpg'), quality=90)
    for lid in m['long']:
        enc = lid  # el navegador pide %20 y el servidor lo traduce a espacios
        os.makedirs(os.path.join(out, 'long-thumb', enc), exist_ok=True)
        for l in 'ABC':
            long_thumb(l).save(os.path.join(out, 'long-thumb', enc, l + '.jpg'), quality=86)
        slides = [
            long_thumb('A'),
            slide('Métricas que reviso cada semana', ['Retención media y primeros 30 s', 'CTR de impresiones por vídeo', 'Vídeos que han dejado de crecer'], n=1),
            slide('Miniaturas y títulos', ['Detectar los que caen de CTR', 'Probar variantes A / B / C', 'Actualizar los 5 peores'], n=2),
            slide('Comunidad y orden', ['Responder comentarios pendientes', 'Revisar listas de reproducción', 'Tarjetas y pantallas finales'], n=3),
            slide('Plan de la semana', ['2 vídeos largos programados', '5 shorts reaprovechados', 'Revisión el próximo lunes'], n=4),
        ]
        video_from_images(slides, os.path.join(out, 'long', enc + '.mp4'), seconds=4)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
