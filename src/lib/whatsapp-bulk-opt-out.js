'use strict';

const LABELS = { es: 'Pedir baja', ca: 'Donar-me de baixa', en: 'Unsubscribe' };
const OPT_OUT_PAYLOAD = 'cc-bulk-opt-out-v1';
const TEST_PAYLOAD = 'cc-bulk-opt-out-test-v1';

function buttonLabel(language) {
  return LABELS[String(language || '').toLowerCase().split(/[_-]/)[0]] || LABELS.es;
}

function matchesButton(button, language) {
  return String(button?.type || '').toUpperCase() === 'QUICK_REPLY'
    && String(button?.text || '').trim().toLowerCase() === buttonLabel(language).toLowerCase();
}

function requireOptOutButton(components, language) {
  const index = components.findIndex(component => component.type === 'BUTTONS');
  const buttons = index < 0 ? [] : components[index].buttons;
  if (buttons.some(button => matchesButton(button, language))) return components;
  if (buttons.length >= 10 || buttons.some(button => String(button.text || '').trim().toLowerCase() === buttonLabel(language).toLowerCase())) {
    throw Object.assign(new Error('template_bulk_opt_out_button_required'), {
      code: 'template_bulk_opt_out_button_required', statusCode: 400,
      details: ['Deja un espacio en la plantilla para el botón de baja obligatorio.'],
    });
  }
  const lastReply = buttons.findLastIndex(button => String(button.type || '').toUpperCase() === 'QUICK_REPLY');
  const insertion = lastReply < 0 ? buttons.length : lastReply + 1;
  const component = { type: 'BUTTONS', buttons: [
    ...buttons.slice(0, insertion), { type: 'QUICK_REPLY', text: buttonLabel(language) }, ...buttons.slice(insertion),
  ] };
  return index < 0 ? [...components, component] : components.map((existing, i) => i === index ? component : existing);
}

function buttonIndex(template) {
  const plain = template?.get ? template.get({ plain: true }) : template;
  const components = Array.isArray(plain?.components) ? plain.components : [];
  const buttons = components.find(component => String(component.type || '').toUpperCase() === 'BUTTONS')?.buttons;
  return Array.isArray(buttons) ? buttons.findIndex(button => matchesButton(button, plain.language)) : -1;
}

function sendComponent(template, { test = false } = {}) {
  const index = buttonIndex(template);
  if (index < 0) return null;
  return { type: 'button', sub_type: 'quick_reply', index: String(index),
    parameters: [{ type: 'payload', payload: test ? TEST_PAYLOAD : OPT_OUT_PAYLOAD }] };
}

function scopeForCategory(category) {
  const normalized = String(category || '').trim().toUpperCase();
  return normalized === 'MARKETING' ? 'marketing' : normalized === 'UTILITY' ? 'whatsapp_channel' : null;
}

module.exports = { OPT_OUT_PAYLOAD, TEST_PAYLOAD, buttonIndex, requireOptOutButton, sendComponent, scopeForCategory };
