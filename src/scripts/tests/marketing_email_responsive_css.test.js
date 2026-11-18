'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDocument, DomUtils } = require('htmlparser2');
const html = require('../../services/marketingEmailHtml.service');
const css = require('../../lib/marketing-email-css');

const URL = 'https://crm.example.test/email/baja?token=current&scope=one';
const TWO_COLUMNS = `<!doctype html><html><head><style>
body{margin:0;background:#f3f4f6}table{border-collapse:collapse}.container{width:640px}
.column{width:50%;vertical-align:top;box-sizing:border-box;padding:12px}
@media only screen and (max-width:600px){.column{display:block !important;width:100% !important}.title{font-size:22px !important}}
@media screen and (min-width:601px){.title{font-size:30px}}
</style></head><body><table class="container" width="640" style="width:640px"><tr>
<td class="column" width="300"><img class="brand" src="https://cdn.example.test/brand.png" width="150" style="display:block;width:100%;max-width:150px;height:auto" alt="Marca"><h1 class="title">Primera columna</h1><p>Contenido de la primera columna.</p>
<table width="180" class="button"><tr><td><img class="icon" src="https://cdn.example.test/logo.png" width="35" height="35" alt="Logo"><a href="https://example.test">Botón</a></td></tr></table></td>
<td class="column" width="300"><h1 class="title">Segunda columna</h1><p>Contenido de la segunda columna.</p></td>
</tr></table></body></html>`;

test('compiled email keeps safe media rules/classes and constrains every selector to author content', () => {
  const clean = html.compileHtmlSource(TWO_COLUMNS);
  assert.match(clean, /@media \(max-width:600px\)/);
  assert.match(clean, /@media \(min-width:601px\)/);
  assert.match(clean, /\.cc-email-imported \.cc-e-column\{display:block !important;width:100% !important\}/);
  assert.match(clean, /class="cc-e-container cc-e-fluid"/);
  assert.match(clean, /width="100%" style="width:100%;max-width:640px"/);
  assert.match(clean, /class="cc-e-column" width="300"/);
  assert.match(clean, /<table width="180" class="cc-e-button">/);
  assert.match(clean, /width="35" height="35"/);
  assert.match(clean, /width="150" style="display:block;width:100%;max-width:150px;height:auto"/);
  assert.doesNotMatch(clean, /\.cc-email-imported img\{max-width:100% !important/);
  assert.doesNotMatch(clean, /@media[^}]*\{\.cc-email-imported table\{width:100%/);
  const source = html.validateHtmlSourceCode(TWO_COLUMNS);
  assert.equal(source, TWO_COLUMNS);
  assert.equal(html.compileHtmlSource(clean), clean);
  assert.doesNotMatch(html.textFromHtml(clean), /@media|max-width|cc-e-column/);
});

test('style parser rejects imports, external resource functions, escapes, scripting and escaping selectors', () => {
  const attack = `<style>@import 'https://evil.example.test/a.css';@font-face{font-family:X;src:url(https://evil.example.test/f)}
  @supports(display:grid){body{display:none}}@media print{a{display:none}}
  .good{color:#123456;background-image:url(https://evil.example.test/p);width:expression(bad());position:fixed;--x:1;color:var(--x)}
  .cc-email-imported + table{display:none}div:has(a){display:none}[data-email-footer]{display:none}
  .x\\000079{background:u\\72l(https://evil.example.test/p)}
  </style><p class="good" onclick="bad()">Seguro</p><script>bad()</script>`;
  const clean = html.compileHtmlSource(attack);
  assert.match(clean, /\.cc-email-imported \.cc-e-good\{color:#123456\}/);
  assert.doesNotMatch(clean, /@import|@font-face|@supports|print|https:\/\/evil|url\(|expression|position:|--x|var\(|:has|\[data|\\000079|<script|onclick/);
});

test('canonical visible links are exact, nonempty and never deduplicated when CSS can hide an ancestor', () => {
  const anchor = `<a href="${URL}">Dejar de recibir</a>`;
  assert.equal(html.hasVisibleSystemLink(html.sanitizeEmailHtml(anchor), URL), true);
  assert.equal(html.hasVisibleSystemLink(html.sanitizeEmailHtml(anchor), URL + '&other=1'), false);
  for (const source of [
    `<div style="display:none">${anchor}</div>`,
    `<style>.hidden{display:none}</style><div class="hidden">${anchor}</div>`,
    `<style>@media (max-width:600px){.hidden{font-size:0}}</style><div class="hidden">${anchor}</div>`,
    `<div style="color:transparent">${anchor}</div>`,
    `<div style="background-color:#fff;color:white">${anchor}</div>`,
    `<style>.hidden{color:#ffffff;background:white}</style><div class="hidden">${anchor}</div>`,
    `<div style="color:rgb(255,255,255);background:#ffffff">${anchor}</div>`,
    `<div style="font-size:1px">${anchor}</div>`,
    `<a href="${URL}"><span style="font-size:1px">Dejar de recibir</span></a>`,
    `<a href="${URL}"><span style="color:#fff;background:white">Dejar de recibir</span></a>`,
    `<style>@media (max-width:600px){.hidden{font:1px Arial}}</style><div class="hidden">${anchor}</div>`,
    `<a href="${URL}"> \u200b </a>`,
  ]) assert.equal(html.hasVisibleSystemLink(html.sanitizeEmailHtml(source), URL), false, source);
  assert.equal(html.hasVisibleSystemLink(html.sanitizeEmailHtml(`<style>.other{display:none}</style>${anchor}`), URL), true);
});

test('generated style bytes are bounded and malformed CSS is discarded rather than executed', () => {
  assert.equal(css.stylesheets(['.a{color:red}'.repeat(4000)]).css, '');
  assert.equal(css.stylesheets(['.a{color:red']).css, '');
  assert.equal(css.mediaCondition('(max-width:600px) and (min-width:300px)'), '(max-width:600px) and (min-width:300px)');
  for (const query of ['(prefers-color-scheme:dark)', '(max-width:600px) or (min-width:1px)', '(max-width:9000px)', 'screen', '(max-width:expression(x))']) assert.equal(css.mediaCondition(query), null);
});

test('two-column fixture reflows at real 360px and authored CSS cannot hide compositor footer', {
  skip: !process.env.CC_EMAIL_CSS_BROWSER_ENDPOINT,
}, async () => {
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.connect({ browserURL: process.env.CC_EMAIL_CSS_BROWSER_ENDPOINT });
  const context = await browser.createBrowserContext();
  try {
    const session = await browser.target().createCDPSession();
    const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', browserContextId: context.id, background: true });
    await session.detach();
    const target = await browser.waitForTarget(item => item._targetId === targetId);
    const page = await target.page();
    await page.setRequestInterception(true);
    page.on('request', request => request.abort());
    const clean = html.compileHtmlSource(TWO_COLUMNS + `<style>body{color:#123456}.cc-email-imported + table{display:none}table[data-email-footer]{display:none}</style>`);
    const document = `<html><body style="margin:0"><div style="max-width:640px;margin:auto">${clean}<table data-email-footer="unsubscribe"><tr><td><a href="${URL}">Baja protegida</a></td></tr></table></div></body></html>`;
    for (const width of [640, 360]) {
      await page.setViewport({ width, height: 900 }); await page.setContent(document);
      const measured = await page.evaluate(() => {
        const cells = [...document.querySelectorAll('.cc-e-column')].map(el => {
          const r=el.getBoundingClientRect();return { x:r.x,y:r.y,width:r.width,right:r.right };
        });
        const footer = document.querySelector('[data-email-footer]');
        return { viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,cells,
          buttonWidth:document.querySelector('.cc-e-button').getBoundingClientRect().width,
          logoWidth:document.querySelector('.cc-e-icon').getBoundingClientRect().width,
          brandWidth:document.querySelector('.cc-e-brand').getBoundingClientRect().width,
          footerVisible:footer.getBoundingClientRect().height>0&&getComputedStyle(footer).display!=='none' };
      });
      assert.equal(measured.scrollWidth, width);
      assert.equal(measured.footerVisible, true);
      assert.equal(measured.cells.length, 2);
      assert.equal(measured.buttonWidth, 180);
      assert.equal(measured.logoWidth, 35);
      assert.equal(measured.brandWidth, 150);
      assert.ok(measured.cells.every(c=>c.right<=width+1));
      if (width===360) { assert.ok(measured.cells[1].y>measured.cells[0].y);assert.ok(measured.cells.every(c=>c.width>=350)); }
      else { assert.equal(measured.cells[0].y, measured.cells[1].y);assert.ok(measured.cells[1].x>measured.cells[0].x); }
    }
  } finally { await context.close(); browser.disconnect(); }
});
