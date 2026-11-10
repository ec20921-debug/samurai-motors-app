"""index.html（GAS 版）から GitHub Pages 版を作る。
google.script.run を「GAS の /exec へ fetch(POST) する同じ形の関数」に差し替えるだけで、画面の中身は同じ。
使い方: python build_pages.py <出力先ファイル>
"""
import sys
API = 'https://script.google.com/macros/s/AKfycbxAZuGD3MVOKBoGII1wsxl9kE_QIt8GpMYfvpwrvIu3L5BR8B3KwLPBayANrHMSX58/exec'
SHIM = """<script>
  // GitHub Pages 版: google.script.run の代わりに GAS へ fetch する（Google のログイン状態に左右されない）
  var JP_API = '%s';
  function jpRunner(ok, ng) {
    var r = {
      withSuccessHandler: function (f) { return jpRunner(f, ng); },
      withFailureHandler: function (f) { return jpRunner(ok, f); }
    };
    ['jpInit', 'jpRecent', 'jpSubmit'].forEach(function (fn) {
      r[fn] = function () {
        var args = Array.prototype.slice.call(arguments);
        fetch(JP_API, { method: 'POST', credentials: 'omit', redirect: 'follow',
                        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                        body: JSON.stringify({ fn: fn, args: args }) })
          .then(function (res) { return res.json(); })
          .then(function (d) { if (!d || d.__error) throw new Error((d && d.__error) || '応答がありません'); if (ok) ok(d.result); })
          .catch(function (e) { if (ng) ng(e); });
      };
    });
    return r;
  }
  window.google = { script: { run: jpRunner(null, null) } };
</script>
""" % API

src = open('index.html', encoding='utf-8').read()
out = src.replace('<base target="_top">\n', '')
head_extra = ('<meta name="viewport" content="width=device-width, initial-scale=1">\n'
              '<title>日本側経費の入力｜Samurai Motors</title>\n'
              '<meta name="robots" content="noindex">\n'
              # ホーム画面に追加した時のアイコンと名前（iPhone・Android）
              '<link rel="apple-touch-icon" href="icon-180.png">\n'
              '<meta name="apple-mobile-web-app-title" content="SM経費">\n'
              '<link rel="manifest" href="manifest.webmanifest">\n'
              '<meta name="theme-color" content="#000000">\n')
out = out.replace('<meta charset="utf-8">\n', '<meta charset="utf-8">\n' + head_extra, 1)
assert out.count('<script>') == 1
out = out.replace('<script>', SHIM + '<script>', 1)
open(sys.argv[1], 'w', encoding='utf-8', newline='\n').write(out)
print('built', sys.argv[1])
