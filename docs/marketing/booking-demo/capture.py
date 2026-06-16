import json, os
from playwright.sync_api import sync_playwright

OUT = "/tmp/shots"
os.makedirs(OUT, exist_ok=True)
HTML = "file:///home/user/samurai-motors-app/booking.html?chatId=999"

INIT = {
    "status": "ok",
    "customer": {"name": "Hisanori"},
    "plans": [{
        "letter": "W", "name": "SAMURAI WASH",
        "descEn": "Waterless body wash + Tire wax (Required base service)",
        "priceSedan": 8, "priceSuv": 10, "durationSedan": 40, "durationSuv": 50,
    }],
    "options": [
        {"code": "GLASS_3", "nameEn": "Front 3 Windows", "nameKm": "កញ្ចក់ខាងមុខ ៣",
         "description": "Water-repellent coating, front 3 windows",
         "priceSedan": 5, "priceSuv": 6, "durationSedan": 15, "durationSuv": 20},
        {"code": "GLASS_ALL", "nameEn": "All Windows", "nameKm": "កញ្ចក់ទាំងអស់",
         "description": "Water-repellent coating, all windows",
         "priceSedan": 10, "priceSuv": 12, "durationSedan": 25, "durationSuv": 30},
    ],
    "campaign": {"active": True, "percent": 30, "nameEn": "GRAND OPENING", "nameKm": "ការបើកដំណើរការ"},
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
window.fetch = function(url, opts){
  try {
    var u = (typeof url === 'string') ? url : (url && url.url) || '';
    if (u.indexOf('booking_init') >= 0)
      return Promise.resolve(new Response(JSON.stringify(_MOCK_INIT), {status:200, headers:{'Content-Type':'application/json'}}));
    if (u.indexOf('booking_slots') >= 0)
      return Promise.resolve(new Response(JSON.stringify(_MOCK_SLOTS), {status:200, headers:{'Content-Type':'application/json'}}));
  } catch(e){}
  return Promise.resolve(new Response('{}', {status:200, headers:{'Content-Type':'application/json'}}));
};
""".replace("__INIT__", json.dumps(INIT)).replace("__SLOTS__", json.dumps(SLOTS))

MAP_INJECT = r"""() => {
    const m = document.getElementById('leafletMap');
    if (m) {
        m.innerHTML = ''; m.style.position='relative';
        m.style.background = "radial-gradient(circle at 50% 42%, rgba(201,168,92,0.10), transparent 60%), repeating-linear-gradient(0deg, #14110c 0 38px, #181410 38px 40px), repeating-linear-gradient(90deg, #14110c 0 38px, #181410 38px 40px), #14110c";
        const road1=document.createElement('div'); road1.style.cssText='position:absolute;left:0;right:0;top:46%;height:10px;background:#2a2118;transform:rotate(-8deg);';
        const road2=document.createElement('div'); road2.style.cssText='position:absolute;top:0;bottom:0;left:38%;width:10px;background:#2a2118;transform:rotate(6deg);';
        m.appendChild(road1); m.appendChild(road2);
    }
    const c = document.getElementById('coordsText');
    if (c) c.textContent = '📍 Tap the map to set your location';
}"""
PIN_INJECT = r"""() => {
    const m = document.getElementById('leafletMap');
    if (m) {
        const pulse=document.createElement('div'); pulse.id='_pin_pulse';
        pulse.style.cssText='position:absolute;left:50%;top:42%;width:60px;height:60px;border:2px solid rgba(201,168,92,0.55);border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 24px rgba(201,168,92,0.35);';
        const pin=document.createElement('div'); pin.id='_pin'; pin.textContent='📍';
        pin.style.cssText='position:absolute;left:50%;top:42%;transform:translate(-50%,-100%);font-size:40px;filter:drop-shadow(0 4px 6px rgba(0,0,0,0.6));';
        m.appendChild(pulse); m.appendChild(pin);
    }
    const c = document.getElementById('coordsText');
    if (c) c.textContent = '📍 11.5790, 104.8870  ·  Toul Kork, Phnom Penh';
}"""

POS = {}

def shot(page, name):
    page.evaluate("window.scrollTo(0,0)")
    page.wait_for_timeout(220)
    page.screenshot(path=f"{OUT}/{name}.png", full_page=True)
    print(f"  {name}: saved")

def centers(page, spec):
    """spec: dict name-> JS expr returning element. Returns {name:{x,y,w,h}} in CSS doc coords."""
    return page.evaluate(r"""(spec) => {
        const out={};
        for (const k in spec){
            let el=null; try { el = eval(spec[k]); } catch(e){}
            if(!el){ out[k]=null; continue; }
            const r=el.getBoundingClientRect();
            out[k]={x:r.left+r.width/2+window.scrollX, y:r.top+r.height/2+window.scrollY,
                    w:r.width, h:r.height};
        }
        return out;
    }""", spec)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/cft/chrome-linux64/chrome",
                          args=["--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--force-color-profile=srgb"])
    pg = b.new_page(viewport={"width":390,"height":844}, device_scale_factor=3)
    pg.add_init_script(INIT_SCRIPT)
    pg.goto(HTML, wait_until="domcontentloaded")
    pg.wait_for_timeout(800)
    pg.add_style_tag(content="#actionArea{display:none !important;} html{background:#050505 !important;}")

    # ───────── STEP 1: PLAN (before/after states) ─────────
    pg.evaluate("""() => {
        state.selectedSize=''; state.selectedPlan=null; state.selectedGlassOption=null;
        document.getElementById('sizeSedan').classList.remove('selected');
        document.getElementById('sizeSuv').classList.remove('selected');
        showView('view-plan');
    }""")
    pg.wait_for_timeout(300)
    shot(pg, "p0_none")
    # positions (layout identical regardless of selection)
    POS["plan"] = centers(pg, {
        "size":   "document.getElementById('sizeSedan')",
        "wash":   "document.querySelector('#planList .plan-card')",
        "glass3": "document.querySelectorAll('#optionList .option-card')[0]",
        "glassall":"document.querySelectorAll('#optionList .option-card')[1]",
    })
    pg.evaluate("""() => { selectSize('セダン以下'); }"""); pg.wait_for_timeout(200); shot(pg, "p1_size")
    pg.evaluate("""() => { selectPlan('W'); }"""); pg.wait_for_timeout(200); shot(pg, "p2_wash")
    pg.evaluate("""() => { selectGlassOption('GLASS_3'); }"""); pg.wait_for_timeout(200); shot(pg, "p3_g3")
    pg.evaluate("""() => { selectGlassOption('GLASS_ALL'); }"""); pg.wait_for_timeout(200); shot(pg, "p4_gall")
    # restore glass3 for downstream summary
    pg.evaluate("""() => { selectGlassOption('GLASS_3'); }"""); pg.wait_for_timeout(120)

    # ───────── STEP 2: DATETIME ─────────
    pg.evaluate("""() => { state.selectedDate=''; state.selectedSlot=''; showView('view-datetime'); }""")
    pg.wait_for_timeout(300)
    shot(pg, "d0_nodate")
    POS["datetime"] = centers(pg, {
        "date": "[...document.querySelectorAll('.date-cell')].filter(c=>!c.classList.contains('closed'))[1]",
    })
    pg.evaluate("""() => {
        const cells=[...document.querySelectorAll('.date-cell')].filter(c=>!c.classList.contains('closed'));
        (cells[1]||cells[0]).click();
    }""")
    pg.wait_for_timeout(500)
    shot(pg, "d1_date")
    POS["datetime"].update(centers(pg, {
        "slot": "[...document.querySelectorAll('.slot-cell')][3]",
    }))
    pg.evaluate("""() => {
        const s=[...document.querySelectorAll('.slot-cell')];
        if(s.length) selectSlot((s[3]||s[0]).textContent);
    }""")
    pg.wait_for_timeout(250)
    shot(pg, "d2_slot")

    # ───────── STEP 3: LOCATION ─────────
    pg.evaluate("""() => { state.selectedLocation='📍 Toul Kork, Phnom Penh'; showView('view-location'); }""")
    pg.wait_for_timeout(300)
    pg.evaluate(MAP_INJECT); pg.wait_for_timeout(150)
    shot(pg, "l0_nopin")
    POS["location"] = centers(pg, {"map": "document.getElementById('leafletMap')"})
    pg.evaluate(PIN_INJECT); pg.wait_for_timeout(150)
    shot(pg, "l1_pin")

    # ───────── STEP 4: CONFIRM ─────────
    pg.evaluate("""() => {
        state.selectedDuration=55; state.selectedSlot=state.selectedSlot||'13:00';
        state.selectedLocation='📍 Toul Kork, Phnom Penh';
        showView('view-confirm');
    }""")
    pg.wait_for_timeout(300)
    shot(pg, "c0_confirm")

    # ───────── STEP 5: SUCCESS ─────────
    pg.evaluate("""() => {
        document.getElementById('successSummary').innerHTML = document.getElementById('summaryCard').innerHTML;
        showView('view-success');
    }""")
    pg.wait_for_timeout(350)
    shot(pg, "s0_success")

    with open(f"{OUT}/positions.json","w") as f:
        json.dump(POS, f, indent=1)
    print("  positions:", json.dumps(POS))
    b.close()
print("done")
