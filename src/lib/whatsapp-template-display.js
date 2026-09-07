'use strict';

function cleanString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function parseComponents(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function extractWhatsappTemplateDisplayButtons(templateOrComponents) {
  const components = parseComponents(
    Array.isArray(templateOrComponents)
      ? templateOrComponents
      : templateOrComponents?.components
  );
  const buttons = components
    .filter((component) => cleanString(component?.type).toUpperCase() === 'BUTTONS')
    .flatMap((component) => (Array.isArray(component?.buttons) ? component.buttons : []));

  return buttons
    .map((button) => ({
      type: cleanString(button?.type).toUpperCase() || 'QUICK_REPLY',
      text: cleanString(button?.text),
    }))
    .filter((button) => button.text);
}

module.exports = {
  extractWhatsappTemplateDisplayButtons,
};
