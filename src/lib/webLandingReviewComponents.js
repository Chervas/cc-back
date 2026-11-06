'use strict';

// Native, editable composites. These are data factories, not raw HTML widgets
// or global heading rules. Both the editor and compiler use the same nodes.
function createReviewComponents(document, prefix, assets = {}) {
  const nodes = document.nodes;
  const id = (key) => `${prefix}_${key}`;
  const make = (key, type, props, children = [], style = {}) => {
    const nodeId = id(key);
    nodes[nodeId] = {
      id: nodeId, type, version: 1, props, children,
      style_tokens: {
        content_width: 'full', background: 'transparent', spacing_top: 'none',
        spacing_bottom: 'none', gap: 'md', ...style,
      },
    };
    return nodeId;
  };
  const text = (key, value, { size = 'lg', tone = 'default', ...extra } = {}) =>
    make(key, 'text', { text: value, size, tone, align: 'left', ...extra });
  const heading = (key, value, { level = 2, size = 'lg', tone = 'default' } = {}) =>
    make(key, 'heading', { text: value, level, size, tone, align: 'left' });
  const group = (key, children, style = {}, props = {}) => make(key, 'section', {
    // A content composite lives inside the existing structural column. Using
    // container here would require a row/column-only child hierarchy and make
    // the visual editor reject ordinary text/image widgets inside the group.
    layout: 'stack', columns: 1, structure_role: 'section', ...props,
  }, children, style);
  const grid = (key, children, columns = 2, mobileColumns = 1, style = {}) => {
    const nodeId = group(key, children, { gap: 'lg', ...style }, { layout: 'grid', columns });
    nodes[nodeId].responsive = { mobile: { columns: mobileColumns } };
    return nodeId;
  };
  const image = (key, resource, alt, options = {}) => {
    const asset = assets[resource];
    if (!asset?.id || !asset.width || !asset.height) throw Error(`review_asset_missing:${resource}`);
    return make(key, 'image', {
      asset_id: asset.id, alt, decorative: false, loading: 'lazy', fit: 'cover',
      aspect_ratio: 'custom', frame_width: asset.width, frame_height: asset.height,
      focal_x: 50, focal_y: 50, ...options,
    }, [], { radius: 'lg' });
  };
  const imagePair = (key, resources, alt, options = {}) => {
    const desktop = image(`${key}_desktop`, resources[0], alt, options);
    const mobile = image(`${key}_mobile`, resources[1] || resources[0], alt, options);
    nodes[desktop].responsive = { mobile: { visible: false } };
    nodes[mobile].responsive = { desktop: { visible: false }, tablet: { visible: false } };
    return group(key, [desktop, mobile], { gap: 'none' });
  };
  const price = (key, offer, { inverse = false } = {}) => {
    const children = [];
    // A reference has exactly one meaning, with only its amount struck through.
    if (offer.reference_amount) {
      if (!offer.reference_label || offer.cash_price) throw Error('review_reference_meaning_required');
      const reference = group(`${key}_reference`, [
        text(`${key}_reference_label`, offer.reference_label, { size: 'md', tone: 'muted' }),
        text(`${key}_reference_amount`, offer.reference_amount, { size: 'md', tone: 'muted', decoration: 'line_through' }),
      ], { gap: 'none' });
      children.push(reference);
    }
    children.push(heading(`${key}_amount`, offer.amount, { level: 3, size: 'xl', tone: inverse ? 'inverse' : 'brand' }));
    if (offer.quantity) children.push(text(`${key}_quantity`, offer.quantity, { tone: inverse ? 'inverse' : 'default' }));
    if (offer.cash_price) children.push(text(`${key}_cash`, offer.cash_price));
    return group(key, children, { gap: 'none' });
  };
  return { id, make, text, heading, group, grid, image, imagePair, price };
}

module.exports = { createReviewComponents };
