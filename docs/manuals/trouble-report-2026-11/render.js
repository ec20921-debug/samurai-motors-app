// index.html → PDF（A4）と PNG（確認用）。使い方: node render.js
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
  await p.goto('file://' + path.join(__dirname, 'index.html'));
  await p.evaluate(() => document.fonts.ready);
  const over = await p.evaluate(() => { const s = document.querySelector('.sheet'), f = document.querySelector('.contact');
    return Math.round(f.getBoundingClientRect().bottom - s.getBoundingClientRect().top) + ' / ' + Math.round(s.getBoundingClientRect().height); });
  console.log('content bottom / sheet height (px):', over);
  await p.pdf({ path: path.join(__dirname, 'SAMURAI_App_Trouble_Report_2026-11.pdf'), format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await p.emulateMedia({ media: 'print' });
  await p.locator('.sheet').screenshot({ path: path.join(__dirname, 'preview.png') });
  await b.close();
})();
