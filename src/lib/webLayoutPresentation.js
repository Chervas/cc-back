'use strict';

const AXIS_X = ['start', 'center', 'end', 'stretch'];
const AXIS_Y = [...AXIS_X, 'space_between'];
const BREAKPOINTS = ['desktop', 'tablet', 'mobile'];

function presentationClasses(node) {
  const result = [];
  const add = (style, prefix) => {
    if (AXIS_X.includes(style?.content_align_x || '')) result.push(`cc-${prefix}content-x-${style.content_align_x}`);
    if (AXIS_Y.includes(style?.content_align_y || '')) result.push(`cc-${prefix}content-y-${style.content_align_y}`);
    if (typeof style?.min_height === 'number' && Number.isInteger(style.min_height) && style.min_height >= 0 && style.min_height <= 2000) result.push(`cc-${prefix}min-h-${style.min_height}`);
  };
  if (node.type === 'section') {
    add(node.style_tokens, '');
    for (const bp of BREAKPOINTS) add(node.responsive?.[bp], `${bp}-`);
    const bg = node.props.background_image;
    if (bg) result.push('cc-has-bg-image', `cc-bg-image-${bg.fit === 'contain' ? 'contain' : 'cover'}`, `cc-bg-position-${bg.focal_x ?? 50}-${bg.focal_y ?? 50}`);
  }
  if (node.type === 'image' && node.props.height_mode === 'fill') result.push('cc-image-fill');
  return result.join(' ');
}

function alignmentCss(prefix = '') {
  const value = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', space_between: 'space-between' };
  const rules = [];
  for (const x of AXIS_X) {
    const selector = `.cc-section.cc-${prefix}content-x-${x}`;
    rules.push(`${selector}.cc-layout-stack>.cc-container{align-items:${value[x]}}`);
    rules.push(`${selector}.cc-layout-row>.cc-container{justify-content:${x === 'stretch' ? 'normal' : value[x]}}`);
    rules.push(`${selector}.cc-layout-grid>.cc-container{justify-items:${x}}`);
  }
  for (const y of AXIS_Y) {
    const selector = `.cc-section.cc-${prefix}content-y-${y}`;
    rules.push(`${selector}.cc-layout-stack>.cc-container{justify-content:${y === 'stretch' ? 'normal' : value[y]}}`);
    rules.push(`${selector}.cc-layout-row>.cc-container{align-items:${y === 'space_between' ? 'stretch' : value[y]};align-content:${value[y]}}`);
    rules.push(`${selector}.cc-layout-grid>.cc-container{align-items:${y === 'space_between' ? 'start' : y};align-content:${value[y]}}`);
  }
  return rules.join('');
}

function presentationCss(document) {
  const rules = new Set();
  const heights = (bp) => {
    const list = new Set();
    for (const node of Object.values(document.nodes || {})) {
      if (node.type !== 'section') continue;
      const style = bp ? node.responsive?.[bp] : node.style_tokens;
      const height = style?.min_height;
      if (typeof height === 'number' && Number.isInteger(height) && height >= 0 && height <= 2000) list.add(`.cc-section.cc-${bp ? bp + '-' : ''}min-h-${height}{min-height:${height}px}`);
    }
    return [...list].sort().join('');
  };
  rules.add('.cc-has-bg-image{position:relative;isolation:isolate}.cc-section-bg{position:absolute;inset:0;z-index:0;overflow:hidden;border-radius:inherit;pointer-events:none}.cc-section-bg img{display:block;width:100%;height:100%;object-fit:cover}.cc-bg-image-contain>.cc-section-bg img{object-fit:contain}.cc-has-bg-image>.cc-container{position:relative;z-index:1}');
  rules.add('.cc-node.cc-image.cc-image-fill{display:flex;flex-direction:column;flex:1 1 auto;align-self:stretch;width:100%;min-height:0}.cc-image.cc-image-fill>.cc-image-frame{position:relative;flex:1 1 auto;min-height:0}.cc-image.cc-image-fill.cc-aspect-auto>.cc-image-frame{aspect-ratio:4/3}.cc-node.cc-image.cc-image-fill>.cc-image-frame>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.cc-node.cc-image.cc-image-fill.cc-fit-contain>.cc-image-frame>img{object-fit:contain}');
  for (const node of Object.values(document.nodes || {})) {
    if (node.type !== 'section' || !node.props.background_image) continue;
    const b = node.props.background_image, x = b.focal_x ?? 50, y = b.focal_y ?? 50;
    if ([x, y].every(n => Number.isInteger(n) && n >= 0 && n <= 100)) rules.add(`.cc-bg-position-${x}-${y}>.cc-section-bg img{object-position:${x}% ${y}%}`);
  }
  rules.add(alignmentCss() + heights(null));
  rules.add(`@media(min-width:1024px){${alignmentCss('desktop-')}${heights('desktop')}}`);
  rules.add(`@media(min-width:768px) and (max-width:1023px){${alignmentCss('tablet-')}${heights('tablet')}}`);
  rules.add(`@media(max-width:767px){${alignmentCss('mobile-')}${heights('mobile')}}`);
  return [...rules].join('\n');
}

function typographyCss(tokens) {
  const t = tokens.typography;
  if (!t) return '';
  const rules = [];
  const textSizes = { sm: .875, md: 1, lg: 1.125 };
  const bodySize = Number.isFinite(t.body_size) && t.body_size >= 12 && t.body_size <= 24 ? t.body_size : null;
  const bodyLine = Number.isFinite(t.body_line_height) && t.body_line_height >= 1.2 && t.body_line_height <= 2.2 ? t.body_line_height : null;
  if (bodySize || bodyLine) {
    rules.push(`body{${bodySize ? 'font-size:' + bodySize + 'px;' : ''}${bodyLine ? 'line-height:' + bodyLine + ';' : ''}}`);
    for (const [size, ratio] of Object.entries(textSizes)) rules.push(`.cc-node.cc-text.cc-size-${size}{${bodySize ? 'font-size:' + Math.round(bodySize * ratio * 100) / 100 + 'px;' : ''}${bodyLine ? 'line-height:' + bodyLine + ';' : ''}}`);
  }
  const line = Number.isFinite(t.heading_line_height) && t.heading_line_height >= 1 && t.heading_line_height <= 1.8 ? t.heading_line_height : null;
  const scale = Number.isFinite(t.heading_scale) && t.heading_scale >= .75 && t.heading_scale <= 1.5 ? t.heading_scale : null;
  const editorial = tokens.layout_preset === 'editorial';
  const sizes = editorial ? { sm: '22px', md: '28px', lg: '36px', xl: '42px', '2xl': '56px', '3xl': '64px' }
    : { sm: '1.25rem', md: '1.5rem', lg: '1.875rem', xl: 'clamp(1.55rem,3vw,2.35rem)', '2xl': 'clamp(1.9rem,4vw,3.2rem)', '3xl': 'clamp(2.25rem,6vw,4.5rem)' };
  const scaled = v => v.replace(/([0-9.]+)(px|rem|vw)/g, (_m, n, unit) => `calc(${n}${unit} * ${scale})`);
  for (const [size, value] of Object.entries(sizes)) if (line || scale) rules.push(`.cc-node.cc-heading.cc-size-${size}{${scale ? 'font-size:' + scaled(value) + ';' : ''}line-height:${line || (editorial ? 1.22 : 1.12)}}`);
  if (editorial && scale) rules.push(`@media(max-width:767px){${Object.entries({ md: '24px', lg: '28px', xl: '28px', '2xl': '36px', '3xl': '36px' }).map(([size, value]) => `.cc-node.cc-heading.cc-size-${size}{font-size:${scaled(value)}}`).join('')}}`);
  return rules.join('\n');
}

module.exports = { presentationClasses, presentationCss, typographyCss };
