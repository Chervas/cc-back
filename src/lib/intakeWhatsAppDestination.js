'use strict';

const TEMPLATE_DESTINATION_ERROR = 'chat_template_fixed_whatsapp_destination';
const normalizePhone = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/[+\s().-]/g, '');
  if (!/^\d{9,15}$/.test(digits)) return null;
  return /^34\d{9}$/.test(digits) ? digits.slice(2) : digits;
};

function walkActions(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'open_whatsapp') visit(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(item => walkActions(item, visit));
    else if (child && typeof child === 'object') walkActions(child, visit);
  }
}

function assertReusableWhatsAppTemplate(template) {
  walkActions({ flow: template?.flow, flows: template?.flows }, action => {
    const phone = action.config?.phone ?? action.phone;
    if (phone == null || phone === '' || phone === 'auto') return;
    throw Object.assign(new Error('Las plantillas compartidas deben usar el WhatsApp de la sede, no un telefono fijo.'),
      { code: TEMPLATE_DESTINATION_ERROR, status: 400 });
  });
}

// Legacy copies remain editable, but a public response never authorizes a foreign destination.
function scopeWhatsAppFlows({ flow, flows, availableLocations = [] }) {
  const result = structuredClone({ flow, flows });
  const allowed = new Set(availableLocations.map(location => normalizePhone(location.whatsapp)).filter(Boolean));
  walkActions(result, action => {
    const phone = action.config?.phone;
    if (phone == null || phone === '' || phone === 'auto') {
      if (!allowed.size) action.enabled = false;
      return;
    }
    if (!allowed.has(normalizePhone(phone))) {
      action.enabled = false;
      action.config = { ...action.config, phone: 'auto' };
      delete action.phone;
    }
  });
  return result;
}

module.exports = { TEMPLATE_DESTINATION_ERROR, assertReusableWhatsAppTemplate, scopeWhatsAppFlows };
