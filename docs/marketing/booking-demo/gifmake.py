#!/usr/bin/env python3
import os, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SHOTS = "/tmp/shots"
FR = "/tmp/anim"
os.makedirs(FR, exist_ok=True)
for f in os.listdir(FR):
    os.remove(os.path.join(FR, f))

# ---------- layout ----------
SCREEN_W = 320
SCREEN_H = 692
BEZEL    = 13
PHONE_W  = SCREEN_W + 2*BEZEL
PHONE_H  = SCREEN_H + 2*BEZEL
PAD_X    = 44
TOP      = 92
BOT      = 120
CANVAS_W = PHONE_W + 2*PAD_X          # 408
CANVAS_H = TOP + PHONE_H + BOT        # 92+718+120 = 930
# make even
CANVAS_W += CANVAS_W % 2
CANVAS_H += CANVAS_H % 2
PHONE_X  = (CANVAS_W - PHONE_W)//2
PHONE_Y  = TOP
SCREEN_X = PHONE_X + BEZEL
SCREEN_Y = PHONE_Y + BEZEL
STATUS_H = 30
APP_Y    = SCREEN_Y + STATUS_H
APP_H    = SCREEN_H - STATUS_H

R_OUT = 50
R_IN  = 40

GOLD   = (201,168,92)
GOLDB  = (227,200,120)
RED    = (185,18,41)
TEXT   = (240,240,240)
DIM    = (150,150,150)
APPBG  = (5,5,5)

F_SERIF   = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
F_SANS    = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
F_SANSB   = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
F_KH      = "/usr/share/fonts/truetype/noto/NotoSansKhmer.ttf"

def font(p, s): return ImageFont.truetype(p, s)

# ---------- background (built once) ----------
def make_bg():
    bg = Image.new("RGB", (CANVAS_W, CANVAS_H), (8,7,7))
    px = bg.load()
    for y in range(CANVAS_H):
        t = y/ CANVAS_H
        # deep maroon top -> near black mid -> faint warm bottom
        r = int(26*(1-t) + 10*t)
        g = int(13*(1-t) + 9*t)
        b = int(13*(1-t) + 10*t)
        for x in range(CANVAS_W):
            px[x,y] = (r,g,b)
    # radial glows
    glow = Image.new("L",(CANVAS_W,CANVAS_H),0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([CANVAS_W*0.5-260, -300, CANVAS_W*0.5+260, 240], fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(80))
    gold_layer = Image.new("RGB",(CANVAS_W,CANVAS_H),GOLD)
    bg = Image.composite(gold_layer, bg, glow.point(lambda v:int(v*0.5)))
    # bottom red glow
    glow2 = Image.new("L",(CANVAS_W,CANVAS_H),0)
    gd2 = ImageDraw.Draw(glow2)
    gd2.ellipse([CANVAS_W*0.5-300, CANVAS_H-200, CANVAS_W*0.5+300, CANVAS_H+260], fill=60)
    glow2 = glow2.filter(ImageFilter.GaussianBlur(90))
    red_layer = Image.new("RGB",(CANVAS_W,CANVAS_H),RED)
    bg = Image.composite(red_layer, bg, glow2.point(lambda v:int(v*0.35)))
    # vignette
    vig = Image.new("L",(CANVAS_W,CANVAS_H),0)
    vd = ImageDraw.Draw(vig)
    vd.rectangle([0,0,CANVAS_W,CANVAS_H], fill=0)
    vd.ellipse([-CANVAS_W*0.3, -CANVAS_H*0.15, CANVAS_W*1.3, CANVAS_H*1.15], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(120))
    dark = Image.new("RGB",(CANVAS_W,CANVAS_H),(0,0,0))
    bg = Image.composite(bg, dark, vig)

    d = ImageDraw.Draw(bg)
    # brand title
    fb = font(F_SERIF, 22)
    title = "SAMURAI MOTORS"
    # letter spacing manual
    def draw_spaced(draw, xy, text, fnt, fill, sp):
        x,y = xy
        for ch in text:
            draw.text((x,y), ch, font=fnt, fill=fill)
            w = draw.textlength(ch, font=fnt)
            x += w + sp
        return x
    tw = sum(d.textlength(c, font=fb)+4 for c in title) - 4
    draw_spaced(d, ((CANVAS_W-tw)/2, 30), title, fb, GOLD, 4)
    # gold divider
    d.line([CANVAS_W/2-46, 62, CANVAS_W/2+46, 62], fill=GOLD, width=1)
    fs = font(F_SANS, 12)
    sub = "Mobile Car Wash  ·  Book in 4 steps"
    sw = d.textlength(sub, font=fs)
    d.text(((CANVAS_W-sw)/2, 68), sub, font=fs, fill=DIM)
    return bg

BG = make_bg()

# rounded mask for screen
def rounded_mask(w,h,r):
    m = Image.new("L",(w,h),0)
    ImageDraw.Draw(m).rounded_rectangle([0,0,w-1,h-1], radius=r, fill=255)
    return m

SCREEN_MASK = rounded_mask(SCREEN_W, SCREEN_H, R_IN)

# phone body (bezel) once - as RGBA overlay
def make_phone_body():
    img = Image.new("RGBA",(PHONE_W, PHONE_H),(0,0,0,0))
    d = ImageDraw.Draw(img)
    # outer body
    d.rounded_rectangle([0,0,PHONE_W-1,PHONE_H-1], radius=R_OUT, fill=(12,12,14,255))
    # gold rim
    d.rounded_rectangle([1,1,PHONE_W-2,PHONE_H-2], radius=R_OUT-1, outline=(70,62,40,255), width=2)
    d.rounded_rectangle([3,3,PHONE_W-4,PHONE_H-4], radius=R_OUT-3, outline=(0,0,0,255), width=1)
    return img

PHONE_BODY = make_phone_body()

BAR_H = 58  # 固定 CTA バーの高さ（スクリーン内）

# 各画面の CTA（英語 / クメール / スタイル）
CTA = {
    0: ("Next",            "បន្ទាប់",        "red"),
    1: ("Next",            "បន្ទាប់",        "red"),
    2: ("Next",            "បន្ទាប់",        "red"),
    3: ("Confirm Booking", "បញ្ជាក់ការកក់",  "gold"),
    4: ("Close",           "បិទ",            "sec"),
}

def draw_actionbar(canvas, sx, sy, idx):
    """スクリーン下部に固定 CTA バーを重ねて描く（実アプリの sticky ボタン相当）。"""
    en, km, style = CTA[idx]
    bar_top = sy + SCREEN_H - BAR_H
    # 下部フェード（コンテンツがバー下に潜る表現）
    fade = Image.new("RGBA",(SCREEN_W, BAR_H+26),(0,0,0,0))
    fd = ImageDraw.Draw(fade)
    for i in range(BAR_H+26):
        a = int(245 * min(1.0, max(0.0,(i-0)/ (BAR_H+26))))
        fd.line([(0,i),(SCREEN_W,i)], fill=(5,5,5,a))
    canvas.paste(fade, (sx, bar_top-26), fade)
    d = ImageDraw.Draw(canvas)
    bx0, by0 = sx+14, bar_top+8
    bx1, by1 = sx+SCREEN_W-14, bar_top+8+38
    if style == "red":
        d.rounded_rectangle([bx0,by0,bx1,by1], radius=9, fill=(185,18,41))
        d.rounded_rectangle([bx0,by0,bx1,by1], radius=9, outline=(150,14,33), width=1)
        tcol, kcol = (255,255,255), (255,220,224)
    elif style == "gold":
        d.rounded_rectangle([bx0,by0,bx1,by1], radius=9, fill=(201,168,92))
        d.rounded_rectangle([bx0,by0,bx1,by1], radius=9, outline=GOLDB, width=1)
        tcol, kcol = (30,20,5), (60,42,12)
    else:
        d.rounded_rectangle([bx0,by0,bx1,by1], radius=9, fill=(26,26,26),
                            outline=(60,60,60), width=1)
        tcol, kcol = (235,235,235), (150,150,150)
    fe = font(F_SANSB, 15)
    fk = font(F_KH, 13)
    pre = "✓ " if style=="gold" else ""
    en2 = pre+en
    ew = d.textlength(en2, font=fe); kw = d.textlength(km, font=fk)
    gap = 12
    total = ew + gap + kw
    cxs = sx + (SCREEN_W-total)/2
    cy  = by0 + (by1-by0)/2
    d.text((cxs, cy-9), en2, font=fe, fill=tcol)
    d.text((cxs+ew+gap, cy-8), km, font=fk, fill=kcol)

def draw_statusbar(canvas, x, y):
    d = ImageDraw.Draw(canvas)
    # status bar bg already app bg behind; draw time + icons + island
    ft = font(F_SANSB, 14)
    d.text((x+18, y+6), "9:41", font=ft, fill=TEXT)
    # right side: signal dots, wifi, battery
    bx = x + SCREEN_W - 64
    # signal bars
    for i in range(4):
        bh = 4 + i*2
        d.rectangle([bx + i*5, y+18-bh, bx+ i*5+3, y+18], fill=TEXT)
    # battery
    btx = x + SCREEN_W - 30
    d.rounded_rectangle([btx, y+8, btx+20, y+18], radius=2, outline=TEXT, width=1)
    d.rectangle([btx+20, y+11, btx+22, y+15], fill=TEXT)
    d.rectangle([btx+2, y+10, btx+15, y+16], fill=(120,210,120))
    # dynamic island
    iw, ih = 88, 20
    ix = x + (SCREEN_W-iw)//2
    d.rounded_rectangle([ix, y+5, ix+iw, y+5+ih], radius=ih//2, fill=(0,0,0))

def caption(canvas, en, km, idx, total=5):
    d = ImageDraw.Draw(canvas)
    cy = PHONE_Y + PHONE_H + 22
    # step dots
    dotw = total*16
    dx = (CANVAS_W - dotw)//2
    for i in range(total):
        col = GOLDB if i==idx else (90,80,55)
        r = 4 if i==idx else 3
        cxp = dx + i*16 + 8
        d.ellipse([cxp-r, cy-r, cxp+r, cy+r], fill=col)
    # english
    fe = font(F_SANSB, 17)
    ew = d.textlength(en, font=fe)
    ey = cy + 14
    d.text(((CANVAS_W-ew)/2, ey), en, font=fe, fill=TEXT)
    # khmer
    fk = font(F_KH, 13)
    kw = d.textlength(km, font=fk)
    d.text(((CANVAS_W-kw)/2, ey+24), km, font=fk, fill=GOLD)

# load & scale shots
def load_shot(name):
    im = Image.open(f"{SHOTS}/{name}.png").convert("RGB")
    # 末尾の白帯（短いページのレンダリング余白）をトリム
    g = im.convert("L")
    W, H = im.size
    cut = H
    for y in range(H-1, max(0, H-int(H*0.25)), -1):
        row = g.crop((0, y, W, y+1)).getdata()
        avg = sum(row)/len(row)
        if avg > 235:      # ほぼ白
            cut = y
        else:
            break
    if cut < H:
        im = im.crop((0, 0, W, cut))
    w = SCREEN_W
    h = int(im.height * w / im.width)
    return im.resize((w,h), Image.LANCZOS)

SCREENS = [
    ("01_plan",     "Choose your wash & vehicle", "ជ្រើសរើសសេវា និងរថយន្ត"),
    ("02_datetime", "Pick a date & time",          "ជ្រើសរើសកាលបរិច្ឆេទ និងម៉ោង"),
    ("03_location", "Set your location",            "កំណត់ទីតាំងរបស់អ្នក"),
    ("04_confirm",  "Review & confirm",             "ពិនិត្យ និងបញ្ជាក់ការកក់"),
    ("05_success",  "Reserved — see you soon!",     "កក់រួចរាល់! ជួបគ្នាឆាប់ៗ"),
]

def ease(t):  # easeInOut
    return 0.5 - 0.5*math.cos(math.pi*t)

def compose(shot, scroll, idx):
    """Return a full canvas frame for given screen + scroll offset."""
    frame = BG.copy()
    # screen content area: app bg fill
    screen = Image.new("RGB",(SCREEN_W, SCREEN_H), APPBG)
    # paste app shot at APP region with scroll
    app_area = Image.new("RGB",(SCREEN_W, APP_H), APPBG)
    src_y = int(scroll)
    crop = shot.crop((0, src_y, SCREEN_W, min(shot.height, src_y+APP_H)))
    app_area.paste(crop, (0,0))
    screen.paste(app_area, (0, STATUS_H))
    # round the screen
    rounded = Image.new("RGB",(SCREEN_W,SCREEN_H),(0,0,0))
    rounded.paste(screen,(0,0))
    # place phone body
    frame.paste(PHONE_BODY, (PHONE_X, PHONE_Y), PHONE_BODY)
    frame.paste(rounded, (SCREEN_X, SCREEN_Y), SCREEN_MASK)
    # 固定 CTA バー（コンテンツの上に重ねる）→ 角丸でクリップ
    bar_canvas = frame.crop((SCREEN_X, SCREEN_Y, SCREEN_X+SCREEN_W, SCREEN_Y+SCREEN_H))
    draw_actionbar_local(bar_canvas, idx)
    frame.paste(bar_canvas, (SCREEN_X, SCREEN_Y), SCREEN_MASK)
    # status bar drawn over
    draw_statusbar(frame, SCREEN_X, SCREEN_Y)
    caption(frame, SCREENS[idx][1], SCREENS[idx][2], idx)
    return frame

def draw_actionbar_local(screen_img, idx):
    draw_actionbar(screen_img, 0, 0, idx)

FPS = 14
frames = []

GLASS_ALL_SHOT = load_shot("01b_plan_glassall")

prev_last = None
for idx,(name,en,km) in enumerate(SCREENS):
    shot = load_shot(name)
    maxscroll = max(0, shot.height - (APP_H - BAR_H))

    rendered = []
    if idx == 0:
        # ── Step 1: しっかり見せる — WASH & GLASS の選択をフォーカス + GLASS 切替を実演 ──
        # 1) 上部(タイトル/キャンペーン/車種)を見せる
        for _ in range(10):
            rendered.append(compose(shot, 0, idx))
        # 2) WASH + GLASS セクションが画面に収まる位置までゆっくりスクロール
        sf = 24
        for f in range(sf):
            t = ease(f/(sf-1))
            rendered.append(compose(shot, t*maxscroll, idx))
        # 3) SAMURAI WASH / GLASS_3 選択状態をしっかり停留
        f_g3  = compose(shot, maxscroll, idx)
        for _ in range(16):
            rendered.append(f_g3)
        # 4) GLASS を ALL WINDOWS に切替（実演）
        f_gall = compose(GLASS_ALL_SHOT, maxscroll, idx)
        TT = 7
        for k in range(1,TT+1):
            rendered.append(Image.blend(f_g3, f_gall, k/(TT+1)))
        for _ in range(16):           # ALL WINDOWS 選択状態を停留
            rendered.append(f_gall)
        # 5) 元の GLASS_3 へ戻す（confirm 画面と内容を一致させる）
        for k in range(1,TT+1):
            rendered.append(Image.blend(f_gall, f_g3, k/(TT+1)))
        for _ in range(6):
            rendered.append(f_g3)
    else:
        scroll_frames = 10 + int(min(maxscroll, 1400)/1400 * 26)
        hold_top = 7
        hold_bot = 9 if maxscroll>0 else 16
        seq = []
        for _ in range(hold_top): seq.append(0)
        for f in range(scroll_frames):
            t = ease(f/(scroll_frames-1)) if scroll_frames>1 else 1
            seq.append(t*maxscroll)
        for _ in range(hold_bot): seq.append(maxscroll)
        rendered = [compose(shot, s, idx) for s in seq]

    # transition crossfade from prev_last to rendered[0]
    if prev_last is not None:
        TN = 6
        for k in range(1,TN+1):
            a = k/(TN+1)
            frames.append(Image.blend(prev_last, rendered[0], a))
    frames.extend(rendered)
    prev_last = rendered[-1]

# write frames
for i,fr in enumerate(frames):
    fr.save(f"{FR}/f_{i:04d}.png")
print(f"frames: {len(frames)}  canvas: {CANVAS_W}x{CANVAS_H}  fps:{FPS}  dur~{len(frames)/FPS:.1f}s")
with open("/tmp/anim_meta.txt","w") as f:
    f.write(f"{FPS}\n{len(frames)}\n")
