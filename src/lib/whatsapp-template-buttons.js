'use strict';

// The editor currently creates quick replies. Other approved button families
// remain untouched when a caller does not explicitly replace the buttons.
function normalizeQuickReplyButtons(buttons) {
  if (buttons == null) return [];
  const invalid = () => {
    throw Object.assign(new Error('template_buttons_invalid'), {
      code: 'template_buttons_invalid', statusCode: 400,
      details: ['Añade hasta 10 respuestas rápidas, con textos distintos de entre 1 y 25 caracteres.'],
    });
  };
  if (!Array.isArray(buttons) || buttons.length > 10) return invalid();
  const seen = new Set();
  return buttons.map(button => {
    if (!button || button.type !== 'QUICK_REPLY' || typeof button.text !== 'string') return invalid();
    const text = button.text.trim();
    const key = text.toLocaleLowerCase('es');
    if (!text || text.length > 25 || /[\r\n\x00-\x1f{}]/.test(text) || seen.has(key)) return invalid();
    seen.add(key);
    return { type: 'QUICK_REPLY', text };
  });
}

module.exports = { normalizeQuickReplyButtons };
