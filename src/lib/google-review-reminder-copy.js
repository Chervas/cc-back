'use strict';

const DEFAULT_MESSAGE_TEXT = '¡Hola {{nombre}}! ¿Pudiste publicarla en Google? Si ya lo hiciste, ¡muchas gracias!';
const MAX_MESSAGE_LENGTH = 4000;

function messageTemplate(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MESSAGE_TEXT;
  if (typeof value !== 'string') throw Object.assign(new Error('El mensaje debe ser texto.'), { code: 'review_reminder_message_invalid' });
  const template = value.trim() || DEFAULT_MESSAGE_TEXT;
  const remainder = template.replace(/\{\{\s*nombre\s*\}\}/g, '');
  if (template.length > MAX_MESSAGE_LENGTH || /\{\{|\}\}/.test(remainder)) {
    throw Object.assign(new Error('El mensaje admite hasta 4000 caracteres y sólo la variable {{nombre}}.'), { code: 'review_reminder_message_invalid' });
  }
  return template;
}

function renderMessage(value, name) {
  const template = messageTemplate(value);
  const recipientName = String(name || '').replace(/\s+/g, ' ').trim();
  if (!recipientName && template === DEFAULT_MESSAGE_TEXT) return template.replace(' {{nombre}}', '');
  if (!recipientName && /\{\{\s*nombre\s*\}\}/.test(template)) {
    throw Object.assign(new Error('Falta el nombre del destinatario.'), { code: 'review_reminder_recipient_name_missing' });
  }
  const content = template.replace(/\{\{\s*nombre\s*\}\}/g, () => recipientName);
  if (content.length > MAX_MESSAGE_LENGTH) throw Object.assign(new Error('El mensaje es demasiado largo.'), { code: 'review_reminder_message_invalid' });
  return content;
}

module.exports = { DEFAULT_MESSAGE_TEXT, messageTemplate, renderMessage };
