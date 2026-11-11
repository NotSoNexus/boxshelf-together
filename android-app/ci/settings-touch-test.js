// Device test (beta.13, Android): Settings by touch on the pretend Thor (853x480 @2.25, touch). A finger on a text setting
// (SteamGridDB's key) opens Boxshelf's own keyboard, not a bare box waiting for Android's: its keys type, Paste brings in
// what's on Android's clipboard (one line, trimmed), Cancel leaves the setting as it was.
'use strict';
module.exports = async function settingsTouchPass({ browser, base, check }) {
  const errors = [], o = {};
  const ctx = await browser.newContext({ viewport: { width: 853, height: 480 }, deviceScaleFactor: 2.25, hasTouch: true, isMobile: true });
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message));
  const st = () => p.evaluate(() => { const s = Settings._state(); return { focus: s.focus, osk: s.osk, edit: s.edit, row: s.row, sub: s.sub, input: !!document.querySelector('#bss .bss-edit') }; });
  // a finger on the first visible element matching sel whose text matches re
  const tap = async (sel, re) => { const at = await p.evaluate(({ sel, re }) => { const el = [...document.querySelectorAll(sel)].find(r => new RegExp(re).test(r.textContent.trim()) && r.getBoundingClientRect().height > 0);
      if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, { sel, re });
    if (!at) return false; await p.waitForTimeout(250); await p.touchscreen.tap(at[0], at[1]); await p.waitForTimeout(600); return true; };
  try {
    await p.goto(base + '?platform=android&shelf=1'); await p.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && Shelf.getMode() === 'browse', null, { timeout: 90000, polling: 250 }); await p.waitForTimeout(1500);
    await p.keyboard.press('s'); await p.waitForFunction(() => Settings.isOpen(), null, { timeout: 20000, polling: 200 }); await p.waitForTimeout(1000);
    await p.keyboard.type('steamgrid'); await p.waitForTimeout(900);
    o.found = await tap('#bss .bss-row', '^Key'); await p.waitForTimeout(400);
    o.page = await st();
    // (this page runs without the Android layer: the clipboard is given here, as android-api.js's clipRead hands it over;
    // that one is checked in the bottom-screen pass, on the pretend device)
    await p.evaluate(() => { window.boxshelf.clipRead = async () => '  ABC-123def\n'; });
    o.tapped = await tap('#bss .bss-row', '^Key');
    o.open = await st();
    o.keys = await p.evaluate(() => [...document.querySelectorAll('#bss .bss-key')].filter(k => k.getBoundingClientRect().height > 0).map(k => k.textContent));
    // every key is on the screen, whole (the bottom row: Space, Paste, Cancel, Done)
    o.onScreen = await p.evaluate(() => [...document.querySelectorAll('#bss .bss-key')].every(k => { const b = k.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight + 0.5 && b.left >= 0 && b.right <= innerWidth + 0.5; }));
    o.clipFn = await p.evaluate(() => typeof window.boxshelf.clipRead);
    if (process.env.BS_SHOT) await p.screenshot({ path: process.env.BS_SHOT });
    // the keys type; Paste brings the clipboard in (as Android's would hand it: a stray line break and spaces)
    await tap('#bss .bss-key', '^q$'); await tap('#bss .bss-key', '^w$');
    o.typed = (await st()).edit;
    await tap('#bss .bss-key', '^Paste$');
    o.pasted = (await st()).edit;
    await tap('#bss .bss-key', '^Cancel$');
    o.cancel = await st();
  } catch (e) { o.err = e.message; }
  await ctx.close();
  const O = o.open || {};
  check('Settings by touch (beta.13, Android): a finger on a text setting opens Boxshelf\'s keyboard (with Paste), not a bare box for Android\'s',
    o.found && o.tapped && O.osk === true && O.focus === 'osk' && O.input === false && (o.keys || []).includes('Paste') && (o.keys || []).includes('Done'), JSON.stringify({ page: o.page, open: o.open, keys: o.keys, onScreen: o.onScreen, clipFn: o.clipFn, err: o.err }));
  check('Settings by touch: the keyboard\'s keys type, Paste adds the clipboard\'s text (trimmed, one line), Cancel keeps the setting as it was',
    o.typed === 'qw' && o.pasted === 'qwABC-123def' && !!o.cancel && o.cancel.edit === null && o.cancel.osk === false, JSON.stringify({ typed: o.typed, pasted: o.pasted, cancel: o.cancel, err: o.err }));
  check('Settings touch pass: no script errors', !errors.length, errors.slice(0, 3).join(' | '));
};
