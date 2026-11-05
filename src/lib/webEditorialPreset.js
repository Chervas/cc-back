'use strict';

function editorialPresetCss(tokens) {
  if (tokens.layout_preset !== 'editorial') return '';
  return `.cc-editorial{--cc-radius:8px;--cc-sm:8px;--cc-md:16px;--cc-lg:24px;--cc-xl:32px;--cc-2xl:64px}
.cc-editorial .cc-section.cc-width-wide>.cc-container{width:min(calc(100% - 48px),1280px)}.cc-editorial .cc-section.cc-width-full>.cc-container{padding-inline:0}
.cc-editorial .cc-heading{font-weight:600;line-height:1.22;letter-spacing:0;white-space:pre-line}.cc-editorial .cc-heading.cc-size-sm{font-size:22px;line-height:28px}.cc-editorial .cc-heading.cc-size-md{font-size:28px;line-height:34px}.cc-editorial .cc-heading.cc-size-lg{font-size:36px;line-height:44px}.cc-editorial .cc-heading.cc-size-xl{font-size:42px;line-height:48px}.cc-editorial .cc-heading.cc-size-2xl{font-size:56px;line-height:64px;font-weight:700}.cc-editorial .cc-heading.cc-size-3xl{font-size:64px;line-height:70px;font-weight:700}
.cc-editorial .cc-text{max-width:none}.cc-editorial .cc-text.cc-size-sm{font-size:12px;line-height:18px}.cc-editorial .cc-text.cc-size-sm.cc-tone-brand{font-size:13px;font-weight:700}.cc-editorial .cc-text.cc-size-md{font-size:16px;line-height:24px}.cc-editorial .cc-text.cc-size-lg{font-size:18px;line-height:27px}
.cc-editorial .cc-tone-muted,.cc-editorial .cc-node.cc-fg-muted{color:#656565}.cc-editorial .cc-bg-muted{background:#faf8f5}.cc-bg-contrast{background:#262623}.cc-editorial .cc-node.cc-radius-sm{border-radius:4px}.cc-editorial .cc-node.cc-radius-md{border-radius:8px}.cc-editorial .cc-node.cc-radius-lg{border-radius:16px}.cc-editorial .cc-node.cc-radius-xl{border-radius:24px}
.cc-editorial .cc-section.cc-shadow-sm{box-shadow:none;border:1px solid #dedbd7}.cc-editorial .cc-section.cc-shadow-sm>.cc-container{padding-inline:24px}
.cc-editorial .cc-button{font-size:16px;line-height:22px;font-weight:700;letter-spacing:0;border-radius:8px;padding:16px}.cc-editorial .cc-button-primary{background:var(--cc-secondary);color:#fff}.cc-editorial .cc-site-header .cc-button{width:auto}
.cc-editorial .cc-node.cc-form{width:min(100%,640px);border:0;border-radius:24px;padding:24px;box-shadow:none}.cc-editorial .cc-form>h2{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.cc-editorial .cc-form input:not([type=checkbox]),.cc-editorial .cc-form select{min-height:52px;border-color:#dedbd7;border-radius:8px}.cc-editorial .cc-form label{font-size:13px;line-height:18px}.cc-editorial .cc-form textarea{border-color:#dedbd7;border-radius:8px}
.cc-editorial .cc-image .cc-image-frame{background:transparent}.cc-editorial .cc-image.cc-bg-accent{padding:12px}.cc-editorial .cc-bg-contrast .cc-button-outline,.cc-editorial .cc-bg-contrast .cc-link-list a{color:#fff}
@media(max-width:767px){.cc-editorial .cc-heading.cc-size-3xl,.cc-editorial .cc-heading.cc-size-2xl{font-size:36px;line-height:42px}.cc-editorial .cc-heading.cc-size-xl,.cc-editorial .cc-heading.cc-size-lg{font-size:28px;line-height:34px}.cc-editorial .cc-heading.cc-size-md{font-size:24px;line-height:30px}.cc-editorial .cc-text.cc-size-lg{font-size:16px;line-height:24px}}`;
}
function imageFrameClasses(props) {
  const classes = [];
  if (props.aspect_ratio === 'custom' && [props.frame_width, props.frame_height].every(n => Number.isInteger(n) && n > 0 && n <= 4096)) classes.push(`cc-image-frame-${props.frame_width}-${props.frame_height}`);
  if (Number.isInteger(props.display_width) && props.display_width > 0 && props.display_width <= 1600) classes.push(`cc-image-width-${props.display_width}`);
  return classes.join(' ');
}

function imageFrameRules(document) {
  const rules = new Set();
  for (const node of Object.values(document.nodes || {})) {
    if (node.type !== 'image') continue;
    const p = node.props, classes = imageFrameClasses(p);
    if (classes.includes('cc-image-frame-')) rules.add(`.cc-image-frame-${p.frame_width}-${p.frame_height} .cc-image-frame{aspect-ratio:${p.frame_width}/${p.frame_height}}`);
    if (classes.includes('cc-image-width-')) rules.add(`.cc-node.cc-image-width-${p.display_width}:not(.cc-section){width:${p.display_width}px;max-width:100%}`);
  }
  return [...rules].sort().join('\n');
}

module.exports = { editorialPresetCss, imageFrameClasses, imageFrameRules };
