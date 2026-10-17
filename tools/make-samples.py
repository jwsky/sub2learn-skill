"""Rebuild the test videos in skills/sub2learn/assets/ from the two sample SRT files.

  sample-2tracks.mkv  English + Chinese text tracks (timings deliberately offset by 150-300 ms)
  sample-pgs.mkv      English Blu-ray PGS (image) track + the Chinese text track

Needs Python 3 with Pillow, the DejaVu fonts and ffmpeg >= 6 (pgs_frame_merge bitstream filter):
    python3 tools/make-samples.py
"""
import pathlib, struct, subprocess, tempfile
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'skills' / 'sub2learn' / 'assets'
FONT = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 54)
W, H = 1920, 1080
CUES = [(1000, 3200, 'Good morning! Did you sleep well?'),
        (9600, 12400, 'The quarterly forecast looks surprisingly optimistic.'),
        (15300, 17500, 'Fair enough. See you at the elevator.')]


def segment(pts_ms, kind, payload):
    return b'PG' + struct.pack('>IIBH', pts_ms * 90, 0, kind, len(payload)) + payload


def rle(img):
    """PGS run-length encoding, one line at a time, each line closed by 00 00."""
    w, h = img.size
    px = img.load()
    out = bytearray()
    for y in range(h):
        x = 0
        while x < w:
            c, n = px[x, y], 1
            while x + n < w and px[x + n, y] == c and n < 16383:
                n += 1
            if c == 0:
                out += bytes([0, n]) if n < 64 else bytes([0, 0x40 | (n >> 8), n & 0xFF])
            elif n < 3:
                out += bytes([c]) * n
            elif n < 64:
                out += bytes([0, 0x80 | n, c])
            else:
                out += bytes([0, 0xC0 | (n >> 8), n & 0xFF, c])
            x += n
        out += b'\x00\x00'
    return bytes(out)


def text_image(text):
    l, t, r, b = ImageDraw.Draw(Image.new('L', (8, 8))).textbbox((0, 0), text, font=FONT, stroke_width=4)
    img = Image.new('L', (r - l + 16, b - t + 16), 0)
    draw = ImageDraw.Draw(img)
    draw.fontmode = '1'  # no anti-aliasing: palette entries 0 (clear), 1 (white), 2 (black outline)
    draw.text((8 - l, 8 - t), text, font=FONT, fill=1, stroke_width=4, stroke_fill=2)
    return img


def sup_bytes():
    out = bytearray()
    palette = bytes([0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255, 2, 16, 128, 128, 255])
    for n, (start, end, text) in enumerate(CUES):
        img = text_image(text)
        w, h = img.size
        x, y = (W - w) // 2, H - h - 80
        data = rle(img)
        pcs = struct.pack('>HHBHBBBB', W, H, 0x10, n * 2, 0x80, 0, 0, 1) + struct.pack('>HBBHH', 0, 0, 0, x, y)
        wds = struct.pack('>BBHHHH', 1, 0, x, y, w, h)
        ods = struct.pack('>HBB', 0, 0, 0xC0) + (len(data) + 4).to_bytes(3, 'big') + struct.pack('>HH', w, h) + data
        out += segment(start, 0x16, pcs) + segment(start, 0x17, wds) + segment(start, 0x14, palette)
        out += segment(start, 0x15, ods) + segment(start, 0x80, b'')
        clear = struct.pack('>HHBHBBBB', W, H, 0x10, n * 2 + 1, 0x00, 0, 0, 0)
        out += segment(end, 0x16, clear) + segment(end, 0x17, wds) + segment(end, 0x80, b'')
    return bytes(out)


FFMPEG = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y']
VIDEO = ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=18:r=1']
ENCODE = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '51', '-pix_fmt', 'yuv420p', '-fflags', '+bitexact', '-flags:v', '+bitexact']

subprocess.run(FFMPEG + VIDEO + ['-i', str(ASSETS / 'sample.en.srt'), '-i', str(ASSETS / 'sample.zh.srt'),
    '-map', '0:v', '-map', '1:s', '-map', '2:s'] + ENCODE + ['-c:s', 'srt',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English',
    '-metadata:s:s:1', 'language=chi', '-metadata:s:s:1', 'title=Chinese (Simplified)',
    str(ASSETS / 'sample-2tracks.mkv')], check=True)
print('wrote', ASSETS / 'sample-2tracks.mkv')

with tempfile.TemporaryDirectory() as tmp:
    sup = pathlib.Path(tmp) / 'eng.sup'
    sup.write_bytes(sup_bytes())
    # -copyts keeps the PGS timestamps; pgs_frame_merge stores one display set per Matroska block
    subprocess.run(FFMPEG + ['-copyts'] + VIDEO + ['-i', str(sup), '-i', str(ASSETS / 'sample.zh.srt'),
        '-map', '0:v', '-map', '1:s', '-map', '2:s'] + ENCODE + ['-c:s:0', 'copy', '-bsf:s:0', 'pgs_frame_merge', '-c:s:1', 'srt',
        '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English (PGS)',
        '-metadata:s:s:1', 'language=chi', '-metadata:s:s:1', 'title=简体中文',
        str(ASSETS / 'sample-pgs.mkv')], check=True)
print('wrote', ASSETS / 'sample-pgs.mkv')
