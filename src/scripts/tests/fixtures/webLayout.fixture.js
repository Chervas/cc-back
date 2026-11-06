'use strict';

const { buildValidWebDocument } = require('./webDocumentV1.fixture');

function webLayoutFixture({ layout = 'stack', images = false } = {}) {
  const document = buildValidWebDocument();
  document.bindings = {};
  document.integrations.intake_config_id = null;
  document.seo.default_social_asset_id = null;
  document.pages[0].slug = 'inicio';
  document.pages[0].seo.social_asset_id = null;
  document.pages[0].root_node_ids = ['layout'];
  document.nodes = {
    layout: {
      id: 'layout', type: 'section', version: 1,
      props: { layout, columns: 1 }, children: ['first', 'middle', 'last'],
      style_tokens: { content_width: 'full', gap: 'md', align: 'start', min_height: 400 },
    },
    first: { id: 'first', type: 'text', version: 1, props: { text: 'Título' }, children: [] },
    middle: { id: 'middle', type: 'text', version: 1, props: { text: 'Contenido' }, children: [] },
    last: {
      id: 'last', type: 'button', version: 1, children: [],
      props: { label: 'CTA', action: 'external_url', target: 'https://example.test/', variant: 'primary' },
    },
  };
  const contentSnapshot = { schema_version: 1, content_entries: {}, media_assets: {}, live_bindings: [] };
  if (images) {
    for (const id of ['first', 'middle', 'last']) document.nodes[id] = {
      id, type: 'image', version: 1, children: [],
      props: { asset_id: 'layout_media', alt: id, decorative: false, loading: 'eager',
        aspect_ratio: 'custom', frame_width: 80, frame_height: 40, display_width: 80 },
    };
    contentSnapshot.media_assets.layout_media = { variants: [
      { key: 'original', url: 'https://media.clinicaclick.com/web/layout.webp', width: 80, height: 40 },
    ] };
  }
  return {
    document, contentSnapshot,
    project: { id: 'layout_project', name: 'Layout fixture', locale: 'es-ES' },
    revisionId: 'layout_revision', baseUrl: 'https://example.test', environment: 'preview',
  };
}

function webColumnsFixture(count = 2) {
  const input = webLayoutFixture({ layout: 'grid', images: true });
  const row = input.document.nodes.layout;
  row.props = { ...row.props, structure_role: 'row', columns: 2 };
  row.style_tokens.gap = 'none';
  row.children = [];
  for (const [index, id] of ['first', 'middle', 'last'].entries()) {
    if (index >= count) { delete input.document.nodes[id]; continue; }
    const columnId = `column_${index}`;
    row.children.push(columnId);
    input.document.nodes[columnId] = {
      id: columnId, type: 'section', version: 1,
      props: { layout: 'stack', columns: 1, structure_role: 'column' }, children: [id],
      style_tokens: { content_width: 'full', gap: 'none' },
    };
  }
  return input;
}

module.exports = { webLayoutFixture, webColumnsFixture };
