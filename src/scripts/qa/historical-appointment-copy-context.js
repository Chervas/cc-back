'use strict';

function extractParameters(pattern, text) {
  const indexes = [];
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let cursor = 0, expression = '';
  for (const match of pattern.matchAll(/\{\{(\d+)\}\}/g)) {
    expression += escape(pattern.slice(cursor, match.index)) + '([\\s\\S]*?)';
    indexes.push(match[1]); cursor = match.index + match[0].length;
  }
  const result = text.match(new RegExp('^' + expression + escape(pattern.slice(cursor)) + '$'));
  return result ? Object.fromEntries(indexes.map((index, i) => [index, result[i + 1]])) : null;
}

function rewrite(item, plan) {
  const next = structuredClone(item), replacements = new Map();
  let changed = 0;
  for (const message of next.messages) {
    if (message.direction !== 'outbound' || message.message_type === 'event') continue;
    for (const entry of plan.catalogPlan) {
      const params = extractParameters(entry.source.body_text, String(message.content || ''));
      if (!params) continue;
      const isReminder = entry.source.family_key === 'clinicaclick_recordatorio_dia_antes'
        && entry.next.variables?.length === 7;
      const values = { ...params };
      if (isReminder) {
        const links = plan.clinicLinks[item.clinic_id];
        if (!links?.url_como_llegar) throw Error('historical_clinic_directions_missing');
        const date = new Date(item.context.appointment?.inicio);
        if (!Number.isFinite(date.getTime())) throw Error('historical_appointment_date_missing');
        const formatted = new Intl.DateTimeFormat('en-GB', { timeZone: links.timezone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(date).replaceAll('/', '-');
        Object.assign(values, { 1: params[1], 2: formatted, 3: params[2], 4: params[3], 5: params[4], 6: links.url_como_llegar, 7: params[5] });
      }
      const body = entry.next.body_text.replace(/\{\{(\d+)\}\}/g, (_, key) => {
        if (!values[key]) throw Error('historical_copy_parameter_missing');
        return values[key];
      });
      replacements.set(message.content, body); message.content = body; changed++;
      break;
    }
  }
  const replace = value => typeof value === 'string' ? [...replacements].reduce((text, [old, next]) => text.split(old).join(next), value)
    : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)])) : value;
  next.context = replace(next.context);
  next.messages = next.messages.map(replace);
  return { item: next, changed };
}
module.exports = { extractParameters, rewrite };
