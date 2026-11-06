'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compileWebArtifact } = require('../../lib/webArtifactCompiler');
const { webLayoutFixture, webColumnsFixture } = require('./fixtures/webLayout.fixture');

// Opt in with a local Chromium executable; all page requests are aborted and CDP uses pipes.
test('compiled layout geometry in Chromium', { skip: !process.env.WEB_LAYOUT_CHROMIUM_PATH }, async (t) => {
  const browser = await require('puppeteer-core').launch({
    executablePath: process.env.WEB_LAYOUT_CHROMIUM_PATH, headless: true, pipe: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => request.abort());
  await page.setBypassCSP(true);
  async function render(input, width = 1280) {
    const artifact = compileWebArtifact(input);
    const css = Object.entries(artifact.files).find(([name]) => name.startsWith('assets/styles.'))[1];
    await page.setViewport({ width, height: 900 });
    await page.setContent(artifact.files['index.html'], { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: css });
  }
  async function measure() {
    return page.evaluate(() => Object.fromEntries([
      ['outer', '#cc-layout'], ['inner', '#cc-layout>.cc-container'],
      ['first', '#cc-first'], ['middle', '#cc-middle'], ['last', '#cc-last'],
    ].map(([key, selector]) => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
      return [key, { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
        width: rect.width, height: rect.height, alignItems: css.alignItems,
        justifyContent: css.justifyContent, flexDirection: css.flexDirection, position: css.position }];
    })));
  }
  const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1, `${message}: ${actual} vs ${expected}`);

  await t.test('min-height and stretch propagate through inner wrappers without fixed positioning', async () => {
    const input = webLayoutFixture();
    input.document.nodes.layout.style_tokens.content_align_y = 'end';
    await render(input);
    let boxes = await measure();
    near(boxes.inner.height, boxes.outer.height, 'inner fills min-height');
    near(boxes.last.bottom, boxes.inner.bottom, 'end alignment reaches bottom');

    const parent = structuredClone(input.document.nodes.layout);
    parent.id = 'parent'; parent.props.layout = 'row'; parent.children = ['layout'];
    parent.style_tokens = { content_width: 'full', gap: 'none', min_height: 600 };
    input.document.nodes.parent = parent;
    input.document.pages[0].root_node_ids = ['parent'];
    input.document.nodes.layout.style_tokens.align = 'stretch';
    delete input.document.nodes.layout.style_tokens.min_height;
    await render(input);
    boxes = await measure();
    near(boxes.outer.height, 600, 'nested section stretches');
    near(boxes.inner.height, 600, 'nested inner stretches');
    near(boxes.last.bottom, boxes.inner.bottom, 'nested CTA reaches bottom');
    assert.equal(boxes.last.position, 'static');
  });

  await t.test('pinning moves only the final content node and ignores editor targets', async () => {
    const input = webLayoutFixture();
    await render(input);
    const original = await measure();
    input.document.nodes.layout.props.pin_last_child = true;
    input.document.nodes.layout.responsive = { mobile: { min_height: 320 } };
    for (const width of [1280, 390]) {
      await render(input, width);
      let boxes = await measure();
      near(boxes.inner.height, width === 390 ? 320 : 400, 'responsive height');
      near(boxes.first.top, boxes.inner.top, 'first remains at top');
      near(boxes.middle.top - boxes.first.bottom, original.middle.top - original.first.bottom, 'earlier gap retained');
      near(boxes.last.bottom, boxes.inner.bottom, 'only final child pinned');
      // Targets have their real editor classes and remain outside the content-node selector.
      await page.evaluate(() => {
        const inner = document.querySelector('#cc-layout>.cc-container');
        for (const className of ['cc-widget-insert-target', 'cc-structure-insert-target cc-placement-target-live']) {
          const target = document.createElement('div'); target.className = className; target.hidden = true;
          inner.append(target);
        }
      });
      boxes = await measure();
      near(boxes.last.bottom, boxes.inner.bottom, 'trailing targets ignored');
      assert.equal(boxes.last.position, 'static');
    }
  });

  await t.test('pinning is opt-in and inert in row/grid including mobile rows', async () => {
    for (const layout of ['stack', 'row', 'grid']) {
      for (const width of [1280, 390]) {
        const input = webLayoutFixture({ layout, images: true });
        await render(input, width);
        const original = await measure();
        input.document.nodes.layout.props.pin_last_child = false;
        await render(input, width);
        assert.deepEqual(await measure(), original);
        if (layout !== 'stack') {
          input.document.nodes.layout.props.pin_last_child = true;
          await render(input, width);
          assert.deepEqual(await measure(), original);
        }
      }
    }
  });

  await t.test('pinning handles a single child, natural height and section padding', async () => {
    const input = webLayoutFixture();
    const section = input.document.nodes.layout;
    section.props.pin_last_child = true;
    delete section.style_tokens.min_height;
    await render(input);
    let boxes = await measure();
    near(boxes.first.top, boxes.inner.top, 'natural height starts normally');
    near(boxes.middle.top - boxes.first.bottom, 16, 'natural height keeps its gap');
    near(boxes.last.top - boxes.middle.bottom, 16, 'auto margin does not create extra height');
    section.children = ['last'];
    delete input.document.nodes.first;
    delete input.document.nodes.middle;
    section.style_tokens.min_height = 400;
    section.style_tokens.spacing_top = 'md';
    section.style_tokens.spacing_bottom = 'md';
    await render(input);
    const result = await page.evaluate(() => {
      const outer = document.querySelector('#cc-layout').getBoundingClientRect();
      const inner = document.querySelector('#cc-layout>.cc-container').getBoundingClientRect();
      const last = document.querySelector('#cc-last').getBoundingClientRect();
      return { outerHeight: outer.height, innerHeight: inner.height, innerTop: inner.top,
        lastBottom: last.bottom, innerBottom: inner.bottom, outerBottom: outer.bottom };
    });
    near(result.outerHeight, 400, 'min-height includes padding');
    near(result.innerHeight, 368, 'wrapper uses content height');
    near(result.innerTop, 16, 'top padding preserved');
    near(result.lastBottom, result.innerBottom, 'single child pinned');
    near(result.outerBottom - result.lastBottom, 16, 'bottom padding preserved');
  });

  await t.test('row distribution follows its effective axis at every breakpoint', async () => {
    const input = webLayoutFixture({ layout: 'row', images: true });
    const section = input.document.nodes.layout;
    section.style_tokens.content_align_x = 'space_between';
    section.style_tokens.content_align_y = 'end';
    section.responsive = { desktop: { content_align_y: 'center' }, mobile: { content_align_y: 'start' } };
    for (const width of [1280, 800, 390]) {
      await render(input, width);
      const boxes = await measure();
      if (width >= 768) {
        assert.equal(boxes.inner.flexDirection, 'row');
        assert.equal(boxes.inner.justifyContent, 'space-between');
        assert.equal(boxes.inner.alignItems, width >= 1024 ? 'center' : 'flex-end');
        near(boxes.first.left - boxes.inner.left, boxes.inner.right - boxes.last.right, 'row edges');
        near(boxes.middle.left - boxes.first.right, boxes.last.left - boxes.middle.right, 'equal horizontal distribution');
      } else {
        assert.equal(boxes.inner.flexDirection, 'column');
        assert.equal(boxes.inner.alignItems, 'stretch');
        assert.equal(boxes.inner.justifyContent, 'flex-start');
        near(boxes.first.top, boxes.inner.top, 'mobile override wins over base y');
        near(boxes.middle.top - boxes.first.bottom, boxes.last.top - boxes.middle.bottom, 'mobile keeps normal gaps');
        delete section.responsive.mobile;
        await render(input, width);
        const inherited = await measure();
        assert.equal(inherited.inner.justifyContent, 'flex-end');
        near(inherited.last.bottom, inherited.inner.bottom, 'base y maps to mobile vertical axis');
      }
    }
  });

  await t.test('mobile x/y overrides preserve the other base axis and x alone never distributes vertically', async () => {
    const input = webLayoutFixture({ layout: 'row', images: true });
    const section = input.document.nodes.layout;
    section.style_tokens.content_align_x = 'end';
    section.style_tokens.content_align_y = 'end';
    section.responsive = { mobile: { content_align_x: 'center' } };
    await render(input, 390);
    let boxes = await measure();
    assert.equal(boxes.inner.alignItems, 'center');
    assert.equal(boxes.inner.justifyContent, 'flex-end');
    near(boxes.last.bottom, boxes.inner.bottom, 'base y survives mobile x override');
    section.responsive.mobile = { content_align_y: 'space_between' };
    await render(input, 390);
    boxes = await measure();
    assert.equal(boxes.inner.alignItems, 'flex-end');
    assert.equal(boxes.inner.justifyContent, 'space-between');
    near(boxes.first.top, boxes.inner.top, 'vertical distribution starts at top');
    near(boxes.last.bottom, boxes.inner.bottom, 'vertical distribution reaches bottom');
    section.style_tokens.content_align_x = 'space_between';
    delete section.style_tokens.content_align_y;
    delete section.responsive;
    await render(input, 390);
    boxes = await measure();
    assert.equal(boxes.inner.alignItems, 'stretch');
    assert.equal(boxes.inner.justifyContent, 'normal');
    near(boxes.middle.top - boxes.first.bottom, 16, 'x alone keeps the normal gap');
    near(boxes.last.top - boxes.middle.bottom, 16, 'x does not distribute vertically');
  });

  async function measureColumns() {
    return page.evaluate(() => {
      const inner = document.querySelector('#cc-layout>.cc-container'), css = getComputedStyle(inner);
      const rect = inner.getBoundingClientRect();
      return { width: inner.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
        top: rect.top, direction: css.flexDirection, display: css.display,
        gap: parseFloat(css.columnGap),
        alignItems: css.alignItems, justifyContent: css.justifyContent,
        columns: [...inner.children].map(element => {
          const r = element.getBoundingClientRect(); return { width: r.width, top: r.top, bottom: r.bottom };
        }) };
    });
  }

  await t.test('Auto uses actual columns without reserving stale grid slots on desktop/tablet/mobile', async () => {
    for (const count of [1, 2, 3]) for (const width of [1280, 800, 390]) {
      const input = webColumnsFixture(count);
      await render(input, width);
      const boxes = await measureColumns();
      assert.equal(boxes.display, 'flex');
      assert.equal(boxes.direction, 'row');
      for (const column of boxes.columns) {
        near(column.width, boxes.width / count, 'Auto shares actual free width');
        near(column.top, boxes.top, 'columns remain in a single row');
      }
    }
  });

  await t.test('manual and Fit columns leave the rest for Auto and preserve breakpoint widths', async () => {
    const input = webColumnsFixture(3);
    input.document.nodes.column_0.props.column_widths = { desktop: 6, tablet: 4, mobile: 12 };
    input.document.nodes.column_1.props.column_width_modes = { desktop: 'fit', tablet: 'fit' };
    input.document.nodes.column_1.props.column_widths = { mobile: 6 };
    input.document.nodes.column_2.props.column_widths = { mobile: 6 };
    for (const width of [1280, 800, 390]) {
      await render(input, width);
      const boxes = await measureColumns();
      const [manual, fit, auto] = boxes.columns;
      if (width >= 768) {
        near(manual.width, boxes.width * (width === 1280 ? .5 : 1 / 3), 'manual span');
        assert.ok(fit.width > 0 && fit.width < boxes.width / 3, 'Fit follows its content');
        near(auto.width, boxes.width - manual.width - fit.width, 'Auto receives remaining width');
        near(auto.top, manual.top, 'mixed columns share a row');
      } else {
        near(manual.width, boxes.width, 'mobile full span');
        near(fit.width, boxes.width / 2, 'mobile Fit override');
        near(auto.width, boxes.width / 2, 'mobile second fixed span');
        assert.ok(fit.top >= manual.bottom, 'mobile full span forces following row');
        near(auto.top, fit.top, 'mobile halves stay together');
      }
    }
  });

  await t.test('legacy tracks remain fixed widths and structural row axes follow horizontal flex', async () => {
    const input = webColumnsFixture(2);
    const row = input.document.nodes.layout;
    row.props.column_tracks = { desktop: [8, 4], tablet: [6, 6], mobile: [6, 6] };
    row.style_tokens.content_align_x = 'space_between';
    row.style_tokens.content_align_y = 'end';
    row.responsive = { mobile: { content_align_x: 'center', content_align_y: 'start' } };
    for (const width of [1280, 800, 390]) {
      await render(input, width);
      const boxes = await measureColumns();
      near(boxes.columns[0].width, boxes.width * (width === 1280 ? 2 / 3 : .5), 'legacy first track');
      near(boxes.columns[1].width, boxes.width * (width === 1280 ? 1 / 3 : .5), 'legacy second track');
      assert.equal(boxes.direction, 'row');
      assert.equal(boxes.justifyContent, width === 390 ? 'center' : 'space-between');
      assert.equal(boxes.alignItems, width === 390 ? 'flex-start' : 'flex-end');
    }
  });

  await t.test('explicit responsive gaps fit 6+6 and 4+4+4 on one line without changing selected gaps', async () => {
    for (const count of [2, 3]) {
      const input = webColumnsFixture(count);
      const row = input.document.nodes.layout;
      row.style_tokens.gap = 'md';
      row.responsive = { desktop: { gap: 'lg' }, mobile: { gap: 'sm' } };
      for (let i = 0; i < count; i++) input.document.nodes[`column_${i}`].props.column_widths = {
        desktop: 12 / count, tablet: 12 / count, mobile: 12 / count,
      };
      for (const width of [1280, 800, 390]) {
        await render(input, width);
        const boxes = await measureColumns();
        near(boxes.gap, width === 1280 ? 25.6 : width === 800 ? 16 : 9.6, 'selected responsive gap');
        for (const column of boxes.columns) {
          near(column.width, (boxes.width - boxes.gap * (count - 1)) / count, 'gap-adjusted span');
          near(column.top, boxes.top, 'manual columns do not wrap because of gap');
        }
        near(boxes.columns.reduce((sum, column) => sum + column.width, 0) + boxes.gap * (count - 1), boxes.width, 'columns and gaps fill row');
      }
    }
  });
});
