"""Regenerates the raster brand assets from REAL tool output (site/assets/demo-session.json).

    python site/tools/make_assets.py      (needs Pillow; uses Windows fonts Cascadia Mono / Segoe UI, set FONTDIR to override)

Outputs: site/assets/demo.gif, site/assets/og.png, media/icon.png (Marketplace icon, 128x128)
"""
import json
import os
import re
import textwrap

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
ASSETS = os.path.join(ROOT, 'site', 'assets')
FONTDIR = os.environ.get('FONTDIR', r'C:\Windows\Fonts')
MONO = os.path.join(FONTDIR, 'CascadiaMono.ttf')
SANS_B = os.path.join(FONTDIR, 'segoeuib.ttf')
SANS = os.path.join(FONTDIR, 'segoeui.ttf')

INK, PANEL, LINE = (7, 8, 10), (15, 18, 22), (37, 41, 48)
TEXT, MUTE = (244, 245, 247), (138, 144, 154)
AMBER, GREEN, RED, CYAN = (246, 183, 60), (61, 220, 151), (255, 107, 107), (122, 190, 255)


def font(path, size):
    return ImageFont.truetype(path, size)


# ---------------------------------------------------------------- terminal GIF
W, H = 960, 540
FM = font(MONO, 17)
FS = font(SANS, 18)
FSB = font(SANS_B, 20)
CW = FM.getlength('M')
LH = 24
X0, Y0 = 36, 74
MAXCH = int((W - 2 * X0) / CW)

session = {s['tool']: s for s in json.load(open(os.path.join(ASSETS, 'demo-session.json'), encoding='utf8'))}


def trunc(s, n):
    return s if len(s) <= n else s[: n - 1] + '\u2026'


def out_lines(tool, take):
    ls = []
    for raw in session[tool]['text'].split('\n'):
        raw = raw.rstrip()
        if not raw:
            continue
        ls.extend(textwrap.wrap(raw, MAXCH, subsequent_indent='    ', break_long_words=False) or [raw])
    if len(ls) > take:
        ls = ls[:take]
        ls[-1] = trunc(ls[-1], MAXCH - 2) + ' …'
    return ls


def arg_str(tool):
    a = session[tool]['args']
    return '  '.join('%s=%s' % (k, ('"%s"' % trunc(v, 40)) if k == 'text' else v) for k, v in a.items())


STEPS = [
    ('lookup_register', 'Look up the real register in the vendor SVD', 4),
    ('cross_check_register', 'Cross-check it against the datasheet table', 3),
    ('generate_regs_header', 'Generate a C header straight from the SVD', 2),
    ('check_header', 'Compile it, layout asserts included', 2),
    ('audit_claims', 'Audit an answer: every value needs evidence', 6),
]

RULES = [
    (re.compile(r'\[E\d+\]'), AMBER),
    (re.compile(r'\b(AGREE|clean|exit 0)\b'), GREEN),
    (re.compile(r'(UNCITED|UNKNOWN-CITATION|UNSUPPORTED|CONFLICT)'), RED),
    (re.compile(r'\((?:vendor-official|community-mirror|measured|derived)(?: source)?\)'), CYAN),
    (re.compile(r'0x[0-9A-Fa-f]{2,}'), TEXT),
]


def segments(line, base):
    marks = []
    for rx, col in RULES:
        for m in rx.finditer(line):
            marks.append((m.start(), m.end(), col))
    marks.sort()
    segs, pos = [], 0
    for a, b, col in marks:
        if a < pos:
            continue
        if a > pos:
            segs.append((line[pos:a], base))
        segs.append((line[a:b], col))
        pos = b
    if pos < len(line):
        segs.append((line[pos:], base))
    return segs


def draw_frame(lines, caption, step_idx):
    im = Image.new('RGB', (W, H), INK)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((12, 12, W - 12, H - 12), 14, fill=PANEL, outline=LINE, width=2)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse((34 + i * 24, 30, 46 + i * 24, 42), fill=c)
    d.text((W // 2, 36), 'aletheon \u00b7 Raspberry Pi Pico (RP2040) \u00b7 MCP session', font=FS, fill=MUTE, anchor='mm')
    visible = (H - Y0 - 70) // LH
    for row, (kind, text) in enumerate(lines[-visible:]):
        y = Y0 + row * LH
        x = X0
        if kind == 'cmd':
            d.text((x, y), '\u203a', font=FM, fill=AMBER)
            tool, _, rest = text.partition('  ')
            d.text((x + 2 * CW, y), tool, font=FM, fill=TEXT)
            d.text((x + (2 + len(tool) + 2) * CW, y), rest, font=FM, fill=MUTE)
        else:
            for seg, col in segments(text, (200, 208, 224)):
                d.text((x, y), seg, font=FM, fill=col)
                x += CW * len(seg)
    d.rounded_rectangle((28, H - 62, W - 28, H - 26), 10, fill=INK, outline=LINE)
    d.text((44, H - 44), '%d/5' % step_idx, font=FSB, fill=AMBER, anchor='lm')
    d.text((92, H - 44), caption, font=FS, fill=TEXT, anchor='lm')
    return im


def build_gif():
    frames, durs = [], []
    lines = []

    def add(im, ms):
        frames.append(im)
        durs.append(ms)

    for i, (tool, cap, take) in enumerate(STEPS, 1):
        cmd = trunc('%s  %s' % (tool, arg_str(tool)), MAXCH - 2)
        for n in range(0, len(cmd) + 1, 4):
            add(draw_frame(lines + [('cmd', cmd[:n])], cap, i), 60)
        lines.append(('cmd', cmd))
        add(draw_frame(lines, cap, i), 350)
        for ol in out_lines(tool, take):
            lines.append(('out', trunc(ol, MAXCH)))
            add(draw_frame(lines, cap, i), 380)
        add(draw_frame(lines, cap, i), 1400)
    add(draw_frame(lines, 'Real tool output, not mocked. The sample answer audited in step 5 is wrong on purpose.', 5), 3200)
    pal = [f.quantize(colors=80, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in frames]
    out = os.path.join(ASSETS, 'demo.gif')
    pal[0].save(out, save_all=True, append_images=pal[1:], duration=durs, loop=0, optimize=True, disposal=1)
    print('demo.gif', len(frames), 'frames', round(os.path.getsize(out) / 1024), 'KB')


# ---------------------------------------------------------------- brand mark (raster) + OG card
def mark(size):
    s = 8
    n = 64 * s
    im = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((12 * s, 12 * s, 52 * s, 52 * s), 8 * s, fill=INK + (255,), outline=TEXT, width=3 * s)
    for x in (22, 32, 42):
        d.line((x * s, 5 * s, x * s, 12 * s), fill=TEXT, width=3 * s)
        d.line((x * s, 52 * s, x * s, 59 * s), fill=TEXT, width=3 * s)
    for y in (22, 32, 42):
        d.line((5 * s, y * s, 12 * s, y * s), fill=TEXT, width=3 * s)
        d.line((52 * s, y * s, 59 * s, y * s), fill=TEXT, width=3 * s)
    d.line([(22 * s, 43 * s), (32 * s, 21 * s), (42 * s, 43 * s)], fill=TEXT, width=int(3.5 * s), joint='curve')
    d.ellipse((28.8 * s, 32.8 * s, 35.2 * s, 39.2 * s), fill=GREEN)
    return im.resize((size, size), Image.LANCZOS)


def build_icon_and_og():
    icon = mark(128)
    bg = Image.new('RGBA', (128, 128), INK + (255,))
    bg.alpha_composite(icon)
    bg.convert('RGB').save(os.path.join(ROOT, 'media', 'icon.png'))
    print('icon.png 128x128')

    im = Image.new('RGB', (1200, 630), INK)
    d = ImageDraw.Draw(im)
    for i in range(0, 1200, 40):
        d.line((i, 0, i, 630), fill=(16, 24, 44))
    for j in range(0, 630, 40):
        d.line((0, j, 1200, j), fill=(16, 24, 44))
    m = mark(150)
    im.paste(m, (70, 70), m)
    d.text((250, 100), 'Aletheon', font=font(SANS_B, 64), fill=TEXT)
    d.text((250, 178), 'grounded firmware engineer', font=font(SANS, 30), fill=MUTE)
    d.text((70, 300), 'Firmware AI that', font=font(SANS_B, 72), fill=TEXT)
    d.text((70, 384), 'shows its evidence.', font=font(SANS_B, 72), fill=(176, 182, 192))
    chips = [('[E5] datasheet p.430', AMBER), ('AGREE', GREEN), ('UNCITED', RED)]
    x = 70
    for label, col in chips:
        f = font(MONO, 26)
        w = int(f.getlength(label)) + 40
        d.rounded_rectangle((x, 520, x + w, 572), 12, fill=PANEL, outline=col, width=2)
        d.text((x + 20, 546), label, font=f, fill=col, anchor='lm')
        x += w + 18
    d.text((1130, 600), 'local-first \u00b7 open core \u00b7 MCP + VS Code', font=font(SANS, 22), fill=MUTE, anchor='rm')
    im.save(os.path.join(ASSETS, 'og.png'), optimize=True)
    print('og.png 1200x630')

    # README logo as PNG on a dark pill (the Marketplace forbids SVG images in READMEs; the pill reads on light and dark themes)
    lw, lh = 640, 168
    lg = Image.new('RGB', (lw, lh), INK)
    ld = ImageDraw.Draw(lg)
    m2 = mark(120)
    lg.paste(m2, (28, 24), m2)
    ld.text((170, 84), 'Aletheon', font=font(SANS_B, 72), fill=TEXT, anchor='lm')
    lg.save(os.path.join(ASSETS, 'logo.png'), optimize=True)
    print('logo.png')


if __name__ == '__main__':
    build_gif()
    build_icon_and_og()
