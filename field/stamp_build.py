"""現場アプリ v2: 版番号を index.html と sw.js に書き込む（配信リポへ同期する直前に実行）
使い方: python field/stamp_build.py   → field-YYYYMMDD-HHMMSS を両方に入れる
版が変わると Service Worker が新しい版を取り込み、画面に「新しい版があります」が出る。
"""
import io, re, time, os
here = os.path.dirname(os.path.abspath(__file__))
build = time.strftime('field-%Y%m%d-%H%M%S')
for name, pat, rep in [('index.html', r"var APP_VERSION = '[^']*';", "var APP_VERSION = '%s';" % build),
                       ('sw.js', r"var BUILD = '[^']*';", "var BUILD = '%s';" % build)]:
    p = os.path.join(here, name)
    s = io.open(p, encoding='utf-8').read()
    s2, n = re.subn(pat, rep, s)
    assert n == 1, (name, n)
    io.open(p, 'w', encoding='utf-8').write(s2)
print(build)
