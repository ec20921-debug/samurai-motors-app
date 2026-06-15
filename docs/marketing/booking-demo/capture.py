import json, os, time
from playwright.sync_api import sync_playwright

OUT = "/tmp/shots"
os.makedirs(OUT, exist_ok=True)
HTML = "file:///home/user/samurai-motors-app/booking.html?chatId=999"

# ---- mock backend payloads ----
INIT = {
    "status": "ok",
    "customer": {"name": "Hisanori"},
    "plans": [{
        "letter": "W",
        "name": "SAMURAI WASH",
        "descEn": "Waterless body wash + Tire wax (Required base service)",
        "priceSedan": 8, "priceSuv": 10,
        "durationSedan": 40, "durationSuv": 50,
    }],
    "options": [
        {"code": "GLASS_3", "nameEn": "Front 3 Windows", "nameKm": "កញ្ចក់ខាងមុខ ៣",
         "description": "Water-repellent coating, front 3 windows",
         "priceSedan": 5, "priceSuv": 6, "durationSedan": 15, "durationSuv": 20},
        {"code": "GLASS_ALL", "nameEn": "All Windows", "nameKm": "កញ្ចក់ទាំងអស់",
         "description": "Water-repellent coating, all windows",
         "priceSedan": 10, "priceSuv": 12, "durationSedan": 25, "durationSuv": 30},
    ],
    "campaign": {"active": True, "percent": 20, "nameEn": "GRAND OPENING", "nameKm": "ការបើកដំណើរការ"},
    "dispatchFee": {"sedan": 2, "suv": 2},
}
SLOTS = {"status": "ok", "durationMin": 55,
         "slots": ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"]}

INIT_SCRIPT = r"""
window.Telegram = { WebApp: {
  ready: function(){}, expand: function(){}, close: function(){},
  MainButton: { show:function(){}, hide:function(){}, setText:function(){}, onClick:function(){} },
  initDataUnsafe: { user: { id: 999, username: 'hisanori', first_name: 'Hisanori', last_name: '' } },
  colorScheme: 'dark'
}};
const _MOCK_INIT = __INIT__;
const _MOCK_SLOTS = __SLOTS__;
const _origFetch = window.fetch;
window.fetch = function(url, opts){
  try {
    var u = (typeof url === 'string') ? url : (url && url.url) || '';
    if (u.indexOf('booking_init') >= 0) {
      return Promise.resolve(new Response(JSON.stringify(_MOCK_INIT), {status:200, headers:{'Content-Type':'application/json'}}));
    }
    if (u.indexOf('booking_slots') >= 0) {
      return Promise.resolve(new Response(JSON.stringify(_MOCK_SLOTS), {status:200, headers:{'Content-Type':'application/json'}}));
    }
  } catch(e){}
  // block all other network (fonts/leaflet/etc resolve empty)
  return Promise.resolve(new Response('{}', {status:200, headers:{'Content-Type':'application/json'}}));
};
""".replace("__INIT__", json.dumps(INIT)).replace("__SLOTS__", json.dumps(SLOTS))

def shot(page, name):
    page.evaluate("window.scrollTo(0,0)")
    page.wait_for_timeout(250)
    page.screenshot(path=f"{OUT}/{name}.png", full_page=True)
    h = page.evaluate("document.querySelector('.container').scrollHeight")
    print(f"  {name}: saved")

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/cft/chrome-linux64/chrome",
                          args=["--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--force-color-profile=srgb"])
    pg = b.new_page(viewport={"width":390,"height":844}, device_scale_factor=3)
    pg.add_init_script(INIT_SCRIPT)
    pg.goto(HTML, wait_until="domcontentloaded")
    pg.wait_for_timeout(800)  # let loadInit + splash run
    # 固定 CTA バーはスクショから除外（GIF 側で各画面用のバーを描画する）
    pg.add_style_tag(content="#actionArea{display:none !important;}")

    # hide the action button bar for cleaner content shots? keep it - it's part of UI
    # STEP 1 - plan
    pg.evaluate("""() => {
        selectSize('セダン以下');
        selectPlan('W');
        selectGlassOption('GLASS_3');
        showView('view-plan');
    }""")
    pg.wait_for_timeout(400)
    shot(pg, "01_plan")

    # export section Y positions (CSS px, document coords) for focused panning
    import json as _json
    pos = pg.evaluate("""() => {
        function yOf(pred){
          const els=[...document.querySelectorAll('#view-plan .section-title')];
          const el=els.find(pred);
          if(!el) return null;
          const r=el.getBoundingClientRect();
          return r.top + window.scrollY;
        }
        return {
          size_y:  yOf(e=>/Vehicle Size/i.test(e.textContent)),
          wash_y:  yOf(e=>/SAMURAI WASH/i.test(e.textContent)),
          glass_y: yOf(e=>/SAMURAI GLASS/i.test(e.textContent)),
          doc_h:   document.querySelector('.container').scrollHeight
        };
    }""")
    with open("/tmp/shots/plan_pos.json","w") as f:
        _json.dump(pos, f)
    print("  plan_pos:", pos)

    # variant: GLASS ALL selected (to demo the toggle on the same screen)
    pg.evaluate("""() => { selectGlassOption('GLASS_ALL'); }""")
    pg.wait_for_timeout(300)
    shot(pg, "01b_plan_glassall")
    # restore GLASS_3 for downstream summary
    pg.evaluate("""() => { selectGlassOption('GLASS_3'); }""")
    pg.wait_for_timeout(150)

    # STEP 2 - date & time (pick first non-Sunday upcoming date)
    pg.evaluate("""() => { showView('view-datetime'); }""")
    pg.wait_for_timeout(300)
    pg.evaluate("""() => {
        const cells = [...document.querySelectorAll('.date-cell')].filter(c=>!c.classList.contains('closed'));
        // pick the 2nd available for a nicer non-today look
        const target = cells[1] || cells[0];
        target.click();
    }""")
    pg.wait_for_timeout(500)
    # select a slot
    pg.evaluate("""() => {
        const s = [...document.querySelectorAll('.slot-cell')];
        if (s.length) { selectSlot(s[3] ? s[3].textContent : s[0].textContent); }
    }""")
    pg.wait_for_timeout(300)
    shot(pg, "02_datetime")

    # STEP 3 - location (inject a styled static map so it isn't an empty box)
    pg.evaluate("""() => {
        state.selectedLocation = '📍 Toul Kork, Phnom Penh';
        showView('view-location');
    }""")
    pg.wait_for_timeout(300)
    pg.evaluate(r"""() => {
        const m = document.getElementById('leafletMap');
        if (m) {
            m.innerHTML = '';
            m.style.position='relative';
            m.style.background = "radial-gradient(circle at 50% 42%, rgba(201,168,92,0.10), transparent 60%), repeating-linear-gradient(0deg, #14110c 0 38px, #181410 38px 40px), repeating-linear-gradient(90deg, #14110c 0 38px, #181410 38px 40px), #14110c";
            const road1 = document.createElement('div');
            road1.style.cssText='position:absolute;left:0;right:0;top:46%;height:10px;background:#2a2118;transform:rotate(-8deg);';
            const road2 = document.createElement('div');
            road2.style.cssText='position:absolute;top:0;bottom:0;left:38%;width:10px;background:#2a2118;transform:rotate(6deg);';
            const pin = document.createElement('div');
            pin.textContent='📍';
            pin.style.cssText='position:absolute;left:50%;top:42%;transform:translate(-50%,-100%);font-size:40px;filter:drop-shadow(0 4px 6px rgba(0,0,0,0.6));';
            const pulse = document.createElement('div');
            pulse.style.cssText='position:absolute;left:50%;top:42%;width:60px;height:60px;border:2px solid rgba(201,168,92,0.55);border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 24px rgba(201,168,92,0.35);';
            m.appendChild(road1); m.appendChild(road2); m.appendChild(pulse); m.appendChild(pin);
        }
        const c = document.getElementById('coordsText');
        if (c) c.textContent = '📍 11.5790, 104.8870  ·  Toul Kork, Phnom Penh';
    }""")
    pg.wait_for_timeout(300)
    shot(pg, "03_location")

    # STEP 4 - confirm
    pg.evaluate("""() => {
        state.selectedDuration = 55;
        if(!state.selectedDate){
          const cells=[...document.querySelectorAll('.date-cell')].filter(c=>!c.classList.contains('closed'));
        }
        state.selectedSlot = state.selectedSlot || '13:00';
        state.selectedLocation = '📍 Toul Kork, Phnom Penh';
        showView('view-confirm');
    }""")
    pg.wait_for_timeout(300)
    shot(pg, "04_confirm")

    # STEP 5 - success
    pg.evaluate("""() => {
        // populate success summary same as confirm
        document.getElementById('successSummary').innerHTML = document.getElementById('summaryCard').innerHTML;
        showView('view-success');
    }""")
    pg.wait_for_timeout(400)
    shot(pg, "05_success")

    b.close()
print("done")
