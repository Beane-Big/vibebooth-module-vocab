"""Render a Vocab card and its cached speech into a portrait MP4."""
import json
import os
from pathlib import Path
import subprocess
import sys
import wave

from PIL import Image, ImageDraw, ImageFilter, ImageFont

WIDTH, HEIGHT = 1080, 1920
SAMPLE_RATE = 24000
# 例句逐词拼读稍微放慢语速并拉长词间停顿，避免听起来急促。
SPELL_SPEED = 0.85
SPELL_GAP = 0.38
FFMPEG = os.environ.get("VIDEO_FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("VIDEO_FFPROBE", "ffprobe")
FONT_DIR = Path(os.environ.get("VIDEO_FONT_DIR", "/usr/share/fonts/noto"))


def font(size, *, bold=False, cjk=False):
    """Use the deployed Noto fonts, including IPA and simplified Chinese."""
    if cjk:
        name = "NotoSansCJK-Bold.ttc" if bold else "NotoSansCJK-Regular.ttc"
        return ImageFont.truetype(str(FONT_DIR / name), size, index=2)
    name = "NotoSans-Bold.ttf" if bold else "NotoSans-Regular.ttf"
    return ImageFont.truetype(str(FONT_DIR / name), size)


def wrapped(draw, text, face, width, cjk=False):
    """Wrap English at word boundaries and Chinese at character boundaries."""
    units, sep = (list(text), "") if cjk else (text.split(), " ")
    rows, current = [], ""
    for unit in units:
        candidate = sep.join((current, unit)) if current else unit
        if current and draw.textlength(candidate, font=face) > width:
            rows.append(current)
            current = unit
        else:
            current = candidate
    return rows + ([current] if current else [])


def card(page, total, output):
    """Draw the approved gradient, near-full-height card and centered content."""
    image = Image.new("RGBA", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(image)
    for y in range(HEIGHT):
        ratio = y / (HEIGHT - 1)
        color = tuple(round(a + (b-a)*ratio) for a,b in zip((223,234,255),(241,232,251)))
        draw.line((0,y,WIDTH,y), fill=color)
    shadow = Image.new("RGBA", image.size)
    ImageDraw.Draw(shadow).rounded_rectangle((57,181,1024,1806), 58, fill=(49,61,121,58))
    image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(25)))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((56,162,1024,1790), 58, fill="#fafaf8", outline="white", width=3)
    draw.rounded_rectangle((103,221,155,273), 16, fill="#365fda")
    for y, width in ((236,23),(246,18),(256,14)):
        draw.rounded_rectangle((118,y,118+width,y+4), 2, fill="white")
    draw.text((174,220), "背单词", font=font(47,bold=True,cjk=True), fill="#17284b", anchor="lt")
    start = page.get("from") or 1
    draw.text((977,232), f"{start + page['index'] - 1:02d} / {start + total - 1:02d}", font=font(35), fill="#435984", anchor="rt")
    step = (page["index"]-1)*3+page["example"]+2
    draw.rounded_rectangle((104,313,976,322), 5, fill="#dce5fb")
    draw.rounded_rectangle((104,313,104+round(872*step/(total*3)),322), 5, fill="#4d70dd")
    draw.text((540,1655), "vibebooth.cn/apps/vocab", font=font(35), fill="#59668c", anchor="mt")

    word, example = page["word"], page["example"]
    if example < 0:
        blocks = [(word["w"],158,True,False,"#252e63"), (f"[{word['us']}]" if word["us"] else "",47,False,False,"#59668c")]
        blocks.extend((s,53,True,True,"#252e63") for s in word["zh"])
    else:
        sentence = word["ex"][example]
        blocks = [
            (f"{word['w']}  ·  例句 {example+1} / 2",38,False,True,"#59668c"),
            (sentence["en"],76,True,False,"#252e63"),
            (f"[{sentence['us']}]" if sentence["us"] else "",39,False,False,"#59668c"),
            (sentence["zh"],53,True,True,"#252e63"),
        ]

    # Longer examples shrink together only when wrapping exceeds the central area.
    for percent in range(100, 9, -5):
        lines = []
        for text, size, bold, cjk, color in blocks:
            size = round(size*percent/100)
            face = font(size,bold=bold,cjk=cjk)
            rows = wrapped(draw,text,face,840,cjk)
            lines.extend((row,face,color,round(size*1.4)) for row in rows)
            if rows:
                lines.append(("",face,color,24))
        height = sum(line[3] for line in lines)
        if height <= 690 and all(draw.textlength(row,font=face)<=840 for row,face,_,_ in lines):
            break
    y = 995-height/2
    for text,face,color,advance in lines:
        if text:
            draw.text((540,y),text,font=face,fill=color,anchor="mt")
        y += advance
    image.convert("RGB").save(output)


def ffmpeg(*args, capture=False):
    return subprocess.run(
        [FFMPEG,"-hide_banner","-loglevel","error","-y",*args],
        check=True, stdout=subprocess.PIPE if capture else None,
    ).stdout


def pcm(source, *, speed=1.0):
    """Decode speech to uniform PCM, optionally slowing down with pitch-preserving atempo."""
    if not source:
        return b""
    args = ["-i", source]
    if speed != 1.0:
        args.extend(["-af", f"atempo={speed}"])
    args.extend(["-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1"])
    audio = ffmpeg(*args, capture=True)
    if not audio or not any(audio):
        raise ValueError(f"Missing audio signal in {source}")
    return audio


def silence(seconds):
    return bytes(round(seconds*SAMPLE_RATE)*2)


def render_page():
    page = json.loads(Path("page.json").read_text(encoding="utf-8"))
    total = int(sys.argv[2])
    index = (page["index"]-1)*3+page["example"]+1
    card(page,total,"card.png")
    chinese,normal,*tokens = page["audio"]
    normal = pcm(normal)
    pause = silence(max(0.3,len(normal)/(2*SAMPLE_RATE)))
    audio = pcm(chinese)+silence(0.25)+normal+pause
    if page["example"] >= 0:
        audio += silence(SPELL_GAP).join(pcm(token, speed=SPELL_SPEED) for token in tokens)+pause
    audio += normal+pause
    with wave.open("card.wav","wb") as track:
        track.setparams((1,2,SAMPLE_RATE,0,"NONE","not compressed"))
        track.writeframes(audio)
    ffmpeg(
        "-loop","1","-framerate","24","-i","card.png","-i","card.wav",
        "-c:v","libx264","-threads","2","-preset","ultrafast","-tune","stillimage",
        "-crf","20","-pix_fmt","yuv420p","-af","volume=4dB,alimiter=limit=0.89:level=0",
        "-c:a","aac","-ac","2","-ar","48000","-b:a","160k",
        "-t",str(len(audio)/(2*SAMPLE_RATE)),f"card-{index:06}.mp4",
    )


def probe_duration(path):
    """Return clip duration in seconds using ffprobe."""
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        check=True, stdout=subprocess.PIPE, text=True,
    ).stdout.strip()
    return float(out)


def escape_ffmeta(text):
    """Escape special characters for FFMETADATA1 values."""
    text = text.replace("\\", "\\\\").replace("=", "\\=").replace(";", "\\;").replace("#", "\\#")
    return text.replace("\r", " ").replace("\n", " ")


def build_chapters(cover_clips, intro_clips, card_clips, outro_clips):
    """Compute per-word chapters, write chapters.json and chapters.txt (FFMETADATA1)."""
    words_file = Path("words.json")
    if not words_file.exists():
        return False
    meta = json.loads(words_file.read_text(encoding="utf-8"))
    if isinstance(meta, dict):
        start_num = meta.get("from") or 1
        words = meta.get("words") or []
    else:
        start_num = 1
        words = meta
    if not words:
        return False
    chapters = []
    cursor = 0.0
    cover_dur = sum(probe_duration(p) for p in cover_clips)
    intro_dur = sum(probe_duration(p) for p in intro_clips)
    if intro_dur > 0:
        chapters.append({"start": 0.0, "end": round(cover_dur + intro_dur, 3), "title": "片头"})
        cursor = cover_dur + intro_dur
    else:
        cursor = cover_dur
    for i, word in enumerate(words):
        group = card_clips[i * 3 : (i + 1) * 3]
        if not group:
            break
        dur = sum(probe_duration(p) for p in group)
        start = 0.0 if i == 0 and not chapters else cursor
        end = cursor + dur
        chapters.append({"start": round(start, 3), "end": round(end, 3), "title": f"{start_num + i}. {word}"})
        cursor = end
    outro_dur = sum(probe_duration(p) for p in outro_clips)
    if outro_dur > 0:
        chapters.append({"start": round(cursor, 3), "end": round(cursor + outro_dur, 3), "title": "片尾"})
    if not chapters:
        return False
    Path("chapters.json").write_text(json.dumps(chapters, ensure_ascii=False), encoding="utf-8")
    lines = [";FFMETADATA1\n"]
    for ch in chapters:
        start_ms = round(ch["start"] * 1000)
        end_ms = max(start_ms + 1, round(ch["end"] * 1000))
        lines.append("[CHAPTER]\nTIMEBASE=1/1000\n")
        lines.append(f"START={start_ms}\nEND={end_ms}\n")
        lines.append(f"title={escape_ffmeta(ch['title'])}\n")
    Path("chapters.txt").write_text("".join(lines), encoding="utf-8")
    return True


def join_pages():
    """Join rendered pages in order and write the download with a seekable header."""
    intro_clips = sorted(Path.cwd().glob("intro-*.mp4"))
    card_clips = sorted(Path.cwd().glob("card-*.mp4"))
    outro_clips = sorted(Path.cwd().glob("outro-*.mp4"))
    cover_clips = []
    cover = Path("cover-upload.jpg")
    if cover.exists():
        ffmpeg(
            "-loop", "1", "-framerate", "24", "-i", str(cover),
            "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
            "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0xeaf0f8,setsar=1",
            "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-tune", "stillimage",
            "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "160k",
            "-t", "0.05", "cover-000.mp4",
        )
        cover_clips = [Path("cover-000.mp4")]
    clips = cover_clips + intro_clips + card_clips + outro_clips
    Path("concat.txt").write_text("".join(f"file '{p.name}'\n" for p in clips),encoding="ascii")
    has_chapters = build_chapters(cover_clips, intro_clips, card_clips, outro_clips)
    args = ["-f", "concat", "-safe", "0", "-i", "concat.txt"]
    next_input = 1
    cover_input = None
    chapters_input = None
    if cover.exists():
        args.extend(["-i", str(cover)])
        cover_input = next_input
        next_input += 1
    if has_chapters:
        args.extend(["-f", "ffmetadata", "-i", "chapters.txt"])
        chapters_input = next_input
    args.extend(["-map", "0"])
    if cover_input is not None:
        args.extend(["-map", str(cover_input)])
    if chapters_input is not None:
        args.extend(["-map_metadata", str(chapters_input), "-map_chapters", str(chapters_input)])
    args.extend(["-c", "copy"])
    if cover_input is not None:
        args.extend(["-disposition:v:1", "attached_pic"])
    args.extend(["-movflags", "+faststart", "video.mp4"])
    ffmpeg(*args)


if __name__ == "__main__":
    {"page": render_page, "join": join_pages}[sys.argv[1]]()

