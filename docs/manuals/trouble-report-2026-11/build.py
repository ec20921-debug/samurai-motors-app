# -*- coding: utf-8 -*-
"""
アプリで困ったとき — 連絡のしかた（A4 1枚）のビルド
  template.html + km.json（Panha 校閲済みのクメール語）→ index.html → PDF / PNG
    python build.py            # index.html だけ
    node render.js             # index.html → PDF と PNG（Playwright）
km.json に無い ID があれば止まる（未校閲のクメール語を入れないため）
"""
import json, re, pathlib, sys
BASE = pathlib.Path(__file__).parent
tpl = (BASE / "template.html").read_text(encoding="utf-8")
km = json.loads((BASE / "km.json").read_text(encoding="utf-8"))
ids = sorted(set(re.findall(r"\{\{(\w+)\}\}", tpl)))
missing = [i for i in ids if not km.get(i)]
if missing:
    sys.exit("km.json に無い ID: " + ", ".join(missing))
esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
html = re.sub(r"\{\{(\w+)\}\}", lambda m: esc(km[m.group(1)]), tpl)
html = html.replace("«⚠ IndexedDB»)", '<span class="nw">«⚠ IndexedDB»)</span>', 1)   # 画面の表示は途中で改行しない
# クメール語の単語が途中で改行されないように（ブラウザが単語の切れ目を誤る語だけ・文字は変えない）
KEEP = ["អេក្រង់", "កើតឡើង", "រក្សាទុក", "ប៊ូតុង", "កម្មវិធី", "ចំហៀង", "សំឡេង", "ម្ដងទៀត", "ឆ្លើយតប"]
head, body = html.split("<body>", 1)
for w in KEEP:
    body = body.replace(w, '<span class="nw">' + w + "</span>")
html = head + "<body>" + body
(BASE / "index.html").write_text(html, encoding="utf-8")
print("index.html を作成（ID %d 個）" % len(ids))
