#!/usr/bin/env python3
"""
Render the demo video from video/script.json + data/video/audio/*.wav + data/video/shot-*.png.

  python3 video/render.py --out /tmp/av --final data/video/arc-guardian-demo.mp4

Every frame is drawn with PIL (no browser needed); ffmpeg assembles per-scene clips
(frames + narration wav) and concatenates them. Scenes without a wav get an estimated
duration so the cut can be previewed before narration exists.
"""
import argparse, json, math, os, shutil, subprocess, wave
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FPS = 10
BG = (11, 13, 18); CARD = (20, 24, 36); LINE = (35, 42, 59)
FG = (230, 233, 240); MUT = (139, 147, 167); ACC = (110, 168, 255)
OK = (61, 220, 151); HOLD = (255, 204, 77); DENY = (255, 92, 122)
FONT_DIR = "/usr/share/fonts/truetype/dejavu"
def font(size, mono=False, bold=False):
    name = ("DejaVuSansMono" if mono else "DejaVuSans") + ("-Bold" if bold else "") + ".ttf"
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)
F_TITLE, F_H1, F_H2, F_BODY, F_SMALL = font(84, bold=True), font(46, bold=True), font(34, bold=True), font(30), font(24)
F_MONO, F_MONO_S, F_SUB = font(28, mono=True), font(22, mono=True), font(32)

def wav_seconds(path):
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()

def wrap(draw, text, fnt, max_w):
    words, lines, cur = text.split(), [], ""
    for w_ in words:
        t = (cur + " " + w_).strip()
        if draw.textlength(t, font=fnt) <= max_w: cur = t
        else: lines.append(cur); cur = w_
    if cur: lines.append(cur)
    return lines

def base(caption):
    im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 96], fill=CARD); d.line([0, 96, W, 96], fill=LINE, width=2)
    d.text((48, 28), "ARC GUARDIAN", font=font(22, bold=True), fill=ACC)
    d.text((300, 24), caption, font=font(34), fill=FG)
    return im, d

def subtitle(im, text):
    if not text: return
    d = ImageDraw.Draw(im, "RGBA")
    lines = wrap(d, text, F_SUB, W - 240)[:3]
    h = 30 + 44 * len(lines)
    d.rectangle([0, H - h - 24, W, H], fill=(0, 0, 0, 170))
    y = H - h - 8
    for ln in lines:
        tw = d.textlength(ln, font=F_SUB); d.text(((W - tw) / 2, y), ln, font=F_SUB, fill=FG); y += 44

def sub_segments(narration, total):
    """Split narration into sentence chunks with proportional timing."""
    import re
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", narration) if p.strip()]
    # merge very short parts with the next
    merged = []
    for p in parts:
        if merged and len(merged[-1].split()) < 6: merged[-1] += " " + p
        else: merged.append(p)
    words = sum(len(p.split()) for p in merged) or 1
    t, segs = 0.0, []
    for p in merged:
        dur = total * len(p.split()) / words
        segs.append((t, t + dur, p)); t += dur
    return segs

def sub_at(segs, t):
    for a, b, p in segs:
        if a <= t < b: return p
    return segs[-1][2] if segs else ""

# ---------- scene painters: return a function(t) -> PIL image (without subtitle) ----------

def scene_title(s):
    def paint(t):
        im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
        title = s["caption"]; tw = d.textlength(title, font=F_TITLE)
        d.text(((W - tw) / 2, 380), title, font=F_TITLE, fill=FG)
        d.rectangle([(W - 160) / 2, 500, (W + 160) / 2, 506], fill=ACC)
        for i, ln in enumerate(wrap(d, s.get("sub", ""), F_BODY, W - 400)):
            tw = d.textlength(ln, font=F_BODY); d.text(((W - tw) / 2, 540 + i * 44), ln, font=F_BODY, fill=MUT)
        d.text((48, H - 60), "Tameion Agents Hackathon · Canteen × Circle · Arc testnet", font=F_SMALL, fill=MUT)
        return im
    return paint

def scene_bullets(s):
    def paint(t):
        im, d = base(s["caption"])
        n_show = min(len(s["bullets"]), 1 + int(t / 3.2))  # reveal one bullet every ~3s
        y = 200
        for i, b in enumerate(s["bullets"][:n_show]):
            d.ellipse([120, y + 14, 138, y + 32], fill=ACC)
            for ln in wrap(d, b, font(36), W - 360):
                d.text((170, y), ln, font=font(36), fill=FG); y += 50
            y += 34
        return im
    return paint

def box(d, x, y, w, h, label, color=LINE, fill=CARD, fnt=None, sub=None):
    d.rounded_rectangle([x, y, x + w, y + h], radius=16, fill=fill, outline=color, width=3)
    fnt = fnt or F_H2
    tw = d.textlength(label, font=fnt); d.text((x + (w - tw) / 2, y + (h - 40) / 2 - (12 if sub else 0)), label, font=fnt, fill=FG)
    if sub:
        tw = d.textlength(sub, font=F_SMALL); d.text((x + (w - tw) / 2, y + h / 2 + 18), sub, font=F_SMALL, fill=MUT)

def arrow(d, x1, y1, x2, y2, color=MUT, label=None):
    d.line([x1, y1, x2, y2], fill=color, width=5)
    ang = math.atan2(y2 - y1, x2 - x1)
    for s_ in (-0.5, 0.5):
        d.line([x2, y2, x2 - 22 * math.cos(ang + s_), y2 - 22 * math.sin(ang + s_)], fill=color, width=5)
    if label:
        d.text(((x1 + x2) / 2 - d.textlength(label, font=F_SMALL) / 2, (y1 + y2) / 2 - 36), label, font=F_SMALL, fill=color)

def scene_diagram(s):
    def paint(t):
        im, d = base(s["caption"])
        step = int(t / 3.5)  # progressive reveal
        box(d, 120, 380, 300, 130, "Agent / LLM", sub="proposes an intent")
        if step >= 1:
            arrow(d, 420, 445, 640, 445, label="intent")
            box(d, 640, 330, 440, 230, "Guardian", color=ACC, fnt=F_H1, sub="deterministic policy engine")
            d.text((650, 575), "known vendor · caps · duplicates · risk tier · approval threshold", font=F_SMALL, fill=MUT)
        if step >= 2:
            arrow(d, 1080, 400, 1300, 300, OK, "allow")
            box(d, 1300, 240, 400, 120, "Circle agent wallet", color=OK, sub="settles on Arc, gas in USDC")
        if step >= 3:
            arrow(d, 1080, 445, 1300, 470, HOLD, "hold")
            box(d, 1300, 420, 400, 100, "human approves", color=HOLD)
            arrow(d, 1080, 500, 1300, 610, DENY, "deny")
            box(d, 1300, 570, 400, 90, "stops", color=DENY)
        if step >= 4:
            d.rounded_rectangle([120, 720, 1700, 860], radius=16, fill=CARD, outline=LINE, width=3)
            d.text((150, 745), "append-only ledger", font=F_H2, fill=FG)
            d.text((150, 800), "hash(n) = sha256(hash(n-1) + entry)  →  decision · execution · approval, every one replayable", font=F_MONO_S, fill=MUT)
            for x in (420, 860, 1500): arrow(d, x, 680, x, 720)
        return im
    return paint

INVOICES = [
    ("OpenAI", "3XLNQNBZ-0001", "2026-07-26", "IDR 349,000", "ChatGPT Plus", None),
    ("OpenAI", "3XLNQNBZ-0002", "2026-08-26", "IDR 75,000", "ChatGPT Go", None),
    ("OpenAI", "3XLNQNBZ-0003", "2026-09-26", "IDR 75,000", "ChatGPT Go", None),
    ("Webshare", "INV-3230164", "2026-08-22", "USD 7.06", "100 proxies · credits applied", "paid"),
    ("proxy-cheap", "PC-625451", "2026-06-17", "USD 5.04", "traffic routing", None),
    ("proxy-cheap", "PC-652071", "2026-07-16", "USD 10.08", "traffic routing", None),
]
def scene_invoices(s):
    def paint(t):
        im, d = base(s["caption"])
        n_show = min(6, 1 + int(t / 2.4))
        for i, (v, inv, date, amt, desc, st) in enumerate(INVOICES[:n_show]):
            col, row = i % 3, i // 3
            x, y = 120 + col * 580, 180 + row * 330
            d.rounded_rectangle([x, y, x + 540, y + 290], radius=18, fill=CARD, outline=LINE, width=3)
            d.text((x + 28, y + 24), v, font=F_H2, fill=FG)
            d.text((x + 28, y + 76), inv, font=F_MONO_S, fill=MUT)
            d.text((x + 28, y + 120), amt, font=font(40, bold=True), fill=FG)
            d.text((x + 28, y + 180), desc, font=F_SMALL, fill=MUT)
            d.text((x + 28, y + 220), "issued " + date, font=F_SMALL, fill=MUT)
            if st: d.text((x + 400, y + 24), "PAID", font=font(22, bold=True), fill=OK)
        d.text((120, 850), "anonymized copies in data/invoices/ · read by Gemini · judged with the owner's vendor notes", font=F_SMALL, fill=MUT)
        return im
    return paint

def scene_terminal(s):
    cmd = s["command"]; out = s["output"]; notes = s.get("notes", [])
    def paint(t):
        im, d = base(s["caption"])
        d.rounded_rectangle([80, 130, 1840, 660], radius=16, fill=(6, 8, 12), outline=LINE, width=3)
        for i, c in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))): d.ellipse([104 + i * 30, 148, 122 + i * 30, 166], fill=c)
        # typewriter: 18 chars/s, then lines at 0.45s each
        n_chars = min(len(cmd), int(t * 18))
        d.text((110, 196), "$ " + cmd[:n_chars] + ("▌" if n_chars < len(cmd) else ""), font=F_MONO, fill=FG)
        t_lines = t - len(cmd) / 18 - 0.4
        y = 250
        for ln in out[: max(0, int(t_lines / 0.45))]:
            col = FG
            if "→ hold" in ln or ln.strip().endswith(": hold") or "possible-duplicate → hold" in ln: col = HOLD
            elif "allow" in ln or "pay_now" in ln or "(queued)" in ln: col = OK
            elif "skip" in ln: col = MUT
            elif "approval → allow" in ln: col = OK
            d.text((110, y), ln[:118], font=F_MONO_S, fill=col); y += 34
        y = 700
        t_notes = t_lines - 0.45 * len(out)
        for i, n in enumerate(notes[: max(0, 1 + int(t_notes / 2.5))]):
            d.rounded_rectangle([80, y, 1840, y + 56], radius=10, fill=CARD, outline=LINE, width=2)
            d.text((104, y + 12), n, font=F_SMALL, fill=FG); y += 68
        return im
    return paint

def scene_screenshot(s, shots):
    img = shots.get(s["image"])
    def paint(t):
        im, d = base(s["caption"])
        if img is None:
            d.text((120, 400), "(screenshot missing: %s)" % s["image"], font=F_H2, fill=DENY); return im
        # fit width, slow vertical pan
        scale = (W - 160) / img.width
        sc = img.resize((W - 160, int(img.height * scale)))
        view_h = H - 96 - 140
        max_off = max(0, sc.height - view_h)
        off = int(min(max_off, max(0, (t - 3) / 14) * max_off))
        crop = sc.crop((0, off, sc.width, off + view_h))
        im.paste(crop, (80, 116))
        d.rectangle([80, 116, W - 80, 116 + view_h], outline=LINE, width=3)
        return im
    return paint

PAINTERS = {"title": scene_title, "bullets": scene_bullets, "diagram": scene_diagram, "invoices": scene_invoices, "terminal": scene_terminal}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--script", default="video/script.json"); ap.add_argument("--audio", default="data/video/audio")
    ap.add_argument("--shots", default="data/video"); ap.add_argument("--out", default="/tmp/av"); ap.add_argument("--final", default="data/video/arc-guardian-demo.mp4")
    ap.add_argument("--only", default=None); a = ap.parse_args()
    script = json.load(open(a.script)); shots = {}
    for f in ("shot-ledger.png", "shot-explorer.png"):
        p = os.path.join(a.shots, f)
        if os.path.exists(p): shots[f] = Image.open(p).convert("RGB")
    os.makedirs(a.out, exist_ok=True); clips = []
    for s in script["scenes"]:
        if a.only and s["id"] != a.only: continue
        wav = os.path.join(a.audio, s["id"] + ".wav"); has_audio = os.path.exists(wav)
        dur = wav_seconds(wav) + 0.6 if has_audio else max(6.0, len(s["narration"].split()) / 2.6 + 0.8)
        paint = scene_screenshot(s, shots) if s["kind"] == "screenshot" else PAINTERS[s["kind"]](s)
        segs = sub_segments(s["narration"], dur - 0.6)
        fdir = os.path.join(a.out, "frames", s["id"]); shutil.rmtree(fdir, ignore_errors=True); os.makedirs(fdir)
        n = int(dur * FPS)
        for i in range(n):
            t = i / FPS; im = paint(t); subtitle(im, sub_at(segs, t)); im.save(os.path.join(fdir, "f%05d.png" % i), compress_level=1)
        clip = os.path.join(a.out, s["id"] + ".mp4")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", os.path.join(fdir, "f%05d.png")]
        if has_audio: cmd += ["-i", wav, "-c:a", "aac", "-b:a", "128k"]
        else: cmd += ["-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-c:a", "aac"]
        cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-shortest" if has_audio else "-t", str(dur) if not has_audio else "", clip]
        cmd = [c for c in cmd if c != ""]
        subprocess.run(cmd, check=True); clips.append(clip)
        print("scene %-16s %5.1fs %s" % (s["id"], dur, "audio" if has_audio else "SILENT"))
    lst = os.path.join(a.out, "list.txt"); open(lst, "w").write("".join("file '%s'\n" % c for c in clips))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", a.final], check=True)
    total = sum(float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", c], capture_output=True, text=True).stdout) for c in clips)
    print("final: %s (%.0f s)" % (a.final, total))

if __name__ == "__main__":
    main()
