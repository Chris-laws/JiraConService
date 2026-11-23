'use strict';
// Prüft src/JsMotion.html in echtem Chromium (Playwright) und in einer Node-vm ohne Browser-APIs.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'src', 'JsMotion.html');
const html = fs.readFileSync(file, 'utf8');
const blocks = html.match(/<script>[\s\S]*?<\/script>/g) || [];
const code = blocks.length ? blocks[0].replace(/^<script>/, '').replace(/<\/script>$/, '') : '';

const ok = (name) => console.log('ok  ' + name);
const values = (easing) => easing.replace(/^linear\(/, '').replace(/\)$/, '').split(',').map(Number);

const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; font: 14px sans-serif; }
  #list { position: relative; width: 300px; }
  .card { height: 40px; margin: 4px 0; background: #ddd; }
  #tabs { position: relative; display: inline-flex; gap: 4px; }
  #tabs .pill { position: absolute; top: 0; left: 0; background: #ccc; transition: transform 300ms; }
  #tabs button { position: relative; }
  .w { display: inline-block; }
</style></head><body>
  <div id="list"><div class="card" data-flip="a">A</div><div class="card" data-flip="b">B</div></div>
  <div id="box">alt</div>
  <div id="tabs"><button aria-selected="true">Eins</button><button>Zwei</button></div>
  <span id="num"></span>
  <button id="btn"><span>alt</span></button>
  <p id="txt">Hallo schöne <b>neue</b> Welt <span class="chip" data-nowords>[1] Quelle A</span> Ende</p>
  <div id="in1">x</div><div id="in2">y</div>
  <script>${code}</script>
</body></html>`;

async function browserChecks() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e));
    await page.setContent(PAGE);

    const sp = await page.evaluate(() => ({
      snappy: Motion.spring(0, 0.3), bouncy: Motion.S.bouncy, same: Motion.spring(0, 0.3) === Motion.spring(0, 0.3),
      reduced: Motion.reduced()
    }));
    assert.ok(sp.snappy.easing.startsWith('linear('), 'easing beginnt mit linear(');
    const sv = values(sp.snappy.easing);
    assert.ok(sv.length >= 40 && sv.length <= 60, 'Stützstellen 40–60, war ' + sv.length);
    assert.strictEqual(sv[0], 0);
    assert.strictEqual(sv[sv.length - 1], 1);
    assert.ok(Math.abs(sv[sv.length - 2] - 1) < 0.002, 'eingeschwungen');
    assert.strictEqual(sp.snappy.duration, 300);
    assert.ok(sp.same, 'Cache');
    assert.strictEqual(sp.reduced, false);
    ok('spring: linear(), endet bei 1, Cache');
    assert.ok(Math.max(...values(sp.bouncy.easing)) > 1.005, 'bouncy schwingt über');
    assert.ok(Math.max(...sv) <= 1.001, 'snappy schwingt nicht über');
    ok('spring: bouncy schwingt über, snappy nicht');

    const vars = await page.evaluate(() => {
      Motion.init(); Motion.init();
      const s = document.documentElement.style;
      return { smooth: s.getPropertyValue('--spring-smooth'), dur: s.getPropertyValue('--dur-snappy') };
    });
    assert.ok(vars.smooth.startsWith('linear('), '--spring-smooth gesetzt');
    assert.strictEqual(vars.dur, '300ms');
    ok('init: CSS-Variablen');

    const fl = await page.evaluate(async () => {
      const list = document.getElementById('list');
      const a = list.querySelector('[data-flip="a"]');
      const p = Motion.flip(list, () => {
        list.appendChild(a);
        const c = document.createElement('div');
        c.className = 'card'; c.setAttribute('data-flip', 'c'); c.textContent = 'C';
        list.appendChild(c);
      });
      const running = a.getAnimations().length;
      const fresh = list.querySelector('[data-flip="c"]').getAnimations().length;
      const isPromise = p instanceof Promise;
      await p;
      return {
        running, fresh, isPromise, after: document.getAnimations().length,
        inline: Array.from(list.children).map((e) => e.style.transform + e.style.opacity + e.style.filter).join(''),
        order: Array.from(list.children).map((e) => e.getAttribute('data-flip')).join('')
      };
    });
    assert.ok(fl.isPromise && fl.running > 0, 'flip startet WAAPI');
    assert.ok(fl.fresh > 0, 'neuer Schlüssel bekommt Enter');
    assert.strictEqual(fl.inline, '', 'keine Inline-Stile nach flip');
    assert.strictEqual(fl.after, 0, 'keine Animation bleibt hängen');
    assert.strictEqual(fl.order, 'bac');
    ok('flip: WAAPI läuft, räumt auf');

    const en = await page.evaluate(async () => {
      const els = [document.getElementById('in1'), document.getElementById('in2')];
      const p = Motion.enter(els, { stagger: 20 });
      const n = els[0].getAnimations().length + els[1].getAnimations().length;
      /* Unterbrechung: exit bricht enter ab, beide Promises lösen auf */
      const q = Motion.exit(els[0]);
      await Promise.all([p, q, Motion.enter(null), Motion.exit(null)]);
      return { n, left: document.getAnimations().length, inline: els[0].getAttribute('style') };
    });
    assert.strictEqual(en.n, 2);
    assert.strictEqual(en.left, 0);
    assert.ok(!en.inline, 'kein Inline-Stil nach enter/exit');
    ok('enter/exit: unterbrechbar, räumt auf');

    const mo = await page.evaluate(async () => {
      const box = document.getElementById('box');
      let during = null;
      await Motion.morph(async () => { during = document.documentElement.dataset.vt; box.textContent = 'neu'; }, { type: 'dock' });
      return { text: box.textContent, during, afterVt: document.documentElement.dataset.vt, hasVt: !!document.startViewTransition };
    });
    assert.strictEqual(mo.text, 'neu');
    if (mo.hasVt) assert.strictEqual(mo.during, 'dock');
    assert.strictEqual(mo.afterVt, undefined, 'data-vt wieder entfernt');
    ok('morph: Mutation angewendet, data-vt entfernt' + (mo.hasVt ? '' : ' (FLIP-Fallback)'));

    const pi = await page.evaluate(() => {
      const tabs = document.getElementById('tabs');
      const btns = tabs.querySelectorAll('button');
      Motion.pill(tabs);
      const first = tabs.firstElementChild;
      const t1 = first.style.transform;
      const w1 = first.style.width;
      btns[0].removeAttribute('aria-selected'); btns[1].setAttribute('aria-selected', 'true');
      Motion.pill(tabs);
      const t2 = tabs.firstElementChild.style.transform;
      btns[1].removeAttribute('aria-selected');
      Motion.pill(tabs);
      return {
        isPill: first.className === 'pill' && first.getAttribute('aria-hidden') === 'true',
        count: tabs.querySelectorAll('.pill').length, t1, t2, w1, same: tabs.firstElementChild === first,
        hidden: first.style.opacity, bw: btns[0].offsetWidth + 'px'
      };
    });
    assert.ok(pi.isPill && pi.same, '.pill ist erstes Kind');
    assert.strictEqual(pi.count, 1, 'nur eine .pill');
    assert.ok(pi.t1.startsWith('translate(') && pi.t1 !== pi.t2, 'pill bewegt sich');
    assert.strictEqual(pi.w1, pi.bw);
    assert.strictEqual(pi.hidden, '0');
    ok('pill: eine .pill als erstes Kind, folgt dem aktiven Eintrag');

    await page.evaluate(() => {
      const el = document.getElementById('num');
      Motion.count(el, 7, { duration: 5000 });
      Motion.count(el, 42, { duration: 120 });
    });
    await page.waitForFunction(() => document.getElementById('num').textContent === '42', null, { timeout: 3000 });
    await page.waitForTimeout(150);
    assert.strictEqual(await page.textContent('#num'), '42');
    ok('count: endet beim Zielwert');

    const sw = await page.evaluate(async () => {
      const btn = document.getElementById('btn');
      await Motion.swap(btn, '<span>neu</span>');
      const htmlAfter = btn.innerHTML;
      const node = btn.firstElementChild;
      await Motion.swap(btn, '<span>neu</span>');
      return { htmlAfter, sameNode: btn.firstElementChild === node, left: btn.getAnimations({ subtree: true }).length };
    });
    assert.strictEqual(sw.htmlAfter, '<span>neu</span>');
    assert.ok(sw.sameNode, 'identisches HTML ist No-op');
    assert.strictEqual(sw.left, 0);
    ok('swap: Inhalt ersetzt, identisch = No-op');

    const wo = await page.evaluate(async () => {
      const p = document.getElementById('txt');
      const before = p.textContent;
      const chip = p.querySelector('.chip');
      const pr = Motion.words(p, { stagger: 5, max: 200 });
      const running = p.getAnimations({ subtree: true }).length;
      await pr;
      return {
        same: p.textContent === before, n: p.querySelectorAll('.w').length, running,
        chip: chip.textContent, chipKids: chip.children.length, inB: p.querySelector('b > .w') !== null,
        left: p.getAnimations({ subtree: true }).length
      };
    });
    assert.ok(wo.same, 'Text unverändert');
    assert.strictEqual(wo.n, 5, 'fünf Wörter verpackt');
    assert.strictEqual(wo.running, 6, 'Wörter + Chip animiert');
    assert.strictEqual(wo.chip, '[1] Quelle A');
    assert.strictEqual(wo.chipKids, 0, 'data-nowords bleibt intakt');
    assert.ok(wo.inB && wo.left === 0);
    ok('words: Wörter verpackt, data-nowords intakt');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const rm = await page.evaluate(async () => {
      const list = document.getElementById('list');
      const box = document.getElementById('box');
      const out = { reduced: Motion.reduced() };
      const f = Motion.flip(list, () => list.appendChild(list.firstElementChild));
      out.flipAnims = document.getAnimations().length;
      out.order = Array.from(list.children).map((e) => e.getAttribute('data-flip')).join('');
      const e = Motion.enter(list.children);
      out.enterAnims = document.getAnimations().length;
      const m = Motion.morph(() => { box.textContent = 'reduziert'; }, { type: 'dock' });
      out.morphAnims = document.getAnimations().length;
      await Promise.all([f, e, m, Motion.exit(box), Motion.words(box), Motion.swap(document.getElementById('btn'), '<span>r</span>')]);
      Motion.count(document.getElementById('num'), 9);
      out.box = box.textContent; out.num = document.getElementById('num').textContent;
      out.btn = document.getElementById('btn').textContent; out.vt = document.documentElement.dataset.vt;
      out.end = document.getAnimations().length;
      return out;
    });
    assert.strictEqual(rm.reduced, true);
    assert.strictEqual(rm.flipAnims + rm.enterAnims + rm.morphAnims + rm.end, 0, 'keine Animationen bei reduzierter Bewegung');
    assert.strictEqual(rm.order, 'acb', 'flip-Mutation angewendet');
    assert.strictEqual(rm.box, 'reduziert');
    assert.strictEqual(rm.num, '9');
    assert.strictEqual(rm.btn, 'r');
    assert.strictEqual(rm.vt, undefined);
    ok('reduced motion: keine Animationen, Mutationen laufen');

    assert.deepStrictEqual(errors, [], 'keine Seitenfehler');
    ok('keine Seitenfehler');
  } finally {
    await browser.close();
  }
}

async function vmChecks() {
  const stubDoc = {
    getElementById: () => null, querySelector: () => null,
    documentElement: { dataset: {}, style: undefined }
  };
  for (const withWindow of [false, true]) {
    const sandbox = { document: stubDoc };
    if (withWindow) sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'JsMotion.html' });
    const M = sandbox.Motion;
    assert.ok(M, 'Motion definiert');
    assert.strictEqual(M.reduced(), false);
    assert.ok(M.S.smooth.easing.startsWith('linear('));
    M.init(); M.init();
    let calls = 0;
    const fn = () => { calls++; };
    const el = { textContent: '', innerHTML: '' };
    const results = [
      M.flip(null, fn), M.flip({}, fn), M.morph(fn, { type: 'dock' }), M.enter(null), M.enter([{}]),
      M.exit(null), M.exit({}), M.swap(el, '<b>x</b>'), M.words(el), M.words(null)
    ];
    for (const r of results) assert.strictEqual(typeof r.then, 'function', 'liefert Promise');
    await Promise.all(results);
    M.pill(null); M.pill({});
    M.count(el, 5);
    M.count(null, 5);
    assert.strictEqual(calls, 3, 'flip/morph rufen mutate auf');
    assert.strictEqual(el.textContent, '5');
    assert.strictEqual(el.innerHTML, '<b>x</b>');
  }
  ok('vm-Sandbox: nichts wirft, flip(null, fn) ruft fn');
}

function sourceChecks() {
  assert.strictEqual(blocks.length, 1, 'genau ein <script>-Block');
  assert.ok(!/`/.test(code), 'keine Template-Literale');
  assert.ok(!/=>/.test(code), 'keine Pfeilfunktionen');
  assert.ok(!/\bclass\s+\w/.test(code) && !/^\s*(import|export)\s/m.test(code), 'keine Klassen/Module');
  assert.ok(!/transition\s*:\s*all/.test(code), 'kein transition: all');
  assert.strictEqual((code.match(/\.innerHTML\s*=[^=]/g) || []).length, 2, 'innerHTML nur in swap');
  assert.ok(html.split('\n').length <= 335, 'Zeilenbudget');
  ok('Quelltext-Regeln');
}

(async () => {
  sourceChecks();
  await vmChecks();
  await browserChecks();
  console.log('Alle Motion-Prüfungen bestanden');
})().catch((err) => {
  console.error('FEHLER  ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
