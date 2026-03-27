'use strict';

const VARIABLE_METADATA = {
  nombre_paciente: { description: 'Nombre del paciente o lead', example: 'Juan' },
  apellido_paciente: { description: 'Apellidos del paciente', example: 'Pérez' },
  usuario_nombre: { description: 'Usuario que crea o agenda la cita', example: 'Graci Gonzalez' },
  usuario_email: { description: 'Email del usuario que crea o agenda la cita', example: 'graci@clinicaclick.com' },
  profesional_nombre: { description: 'Doctor o profesional asignado a la cita', example: 'Doctora' },
  profesional_email: { description: 'Email del doctor o profesional asignado', example: 'doctora@clinicaclick.com' },
  fecha_cita: { description: 'Fecha de la cita programada', example: '30/03/2026' },
  hora_cita: { description: 'Hora de la cita programada', example: '10:00' },
  nombre_clinica: { description: 'Nombre de la clínica', example: 'Propdental Eixample' },
  direccion_clinica: { description: 'Dirección completa de la clínica', example: 'Calle Rossello, 68' },
  telefono_clinica: { description: 'Teléfono de la clínica', example: '602 502 792' },
  url_web_clinica: { description: 'URL web de la clínica', example: 'https://propdental.es' },
  url_ficha_local_clinica: { description: 'URL de la ficha local de la clínica', example: 'https://g.page/r/...' },
  tratamiento: { description: 'Nombre del tratamiento', example: 'Ortodoncia' },
  enlace: { description: 'Enlace dinámico', example: 'https://clinicaclick.com' },
};

const VARIABLE_ALIASES = {
  paciente: 'nombre_paciente',
  nombre_paciente: 'nombre_paciente',
  patient_name: 'nombre_paciente',
  nombre_lead: 'nombre_paciente',
  lead_name: 'nombre_paciente',
  apellido_paciente: 'apellido_paciente',
  usuario: 'usuario_nombre',
  usuario_nombre: 'usuario_nombre',
  appointment_user_name: 'usuario_nombre',
  user_name: 'usuario_nombre',
  usuario_email: 'usuario_email',
  appointment_user_email: 'usuario_email',
  user_email: 'usuario_email',
  profesional: 'profesional_nombre',
  profesional_nombre: 'profesional_nombre',
  nombre_doctor: 'profesional_nombre',
  doctor: 'profesional_nombre',
  doctor_name: 'profesional_nombre',
  profesional_email: 'profesional_email',
  doctor_email: 'profesional_email',
  fecha_cita: 'fecha_cita',
  appointment_date: 'fecha_cita',
  hora_cita: 'hora_cita',
  appointment_time: 'hora_cita',
  nombre_clinica: 'nombre_clinica',
  clinic_name: 'nombre_clinica',
  direccion_clinica: 'direccion_clinica',
  ubicacion: 'direccion_clinica',
  ubicación: 'direccion_clinica',
  clinic_address: 'direccion_clinica',
  telefono_clinica: 'telefono_clinica',
  clinic_phone: 'telefono_clinica',
  url_web_clinica: 'url_web_clinica',
  clinic_website: 'url_web_clinica',
  url_ficha_local_clinica: 'url_ficha_local_clinica',
  clinic_local_profile_url: 'url_ficha_local_clinica',
  tratamiento: 'tratamiento',
  treatment_name: 'tratamiento',
  enlace: 'enlace',
  link: 'enlace',
};

const SYSTEM_TEMPLATE_OVERRIDES = {
  clinicaclick_confirmacion_cita: {
    4: ['nombre_paciente', 'usuario_nombre', 'fecha_cita', 'direccion_clinica'],
    5: ['nombre_paciente', 'usuario_nombre', 'fecha_cita', 'hora_cita', 'direccion_clinica'],
  },
  clinicaclick_recordatorio_dia_antes: {
    5: ['nombre_paciente', 'hora_cita', 'nombre_clinica', 'direccion_clinica', 'telefono_clinica'],
  },
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTemplateVariableName(rawName) {
  const normalized = cleanString(rawName)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!normalized) return '';
  return VARIABLE_ALIASES[normalized] || normalized;
}

function extractWhatsappTemplatePlaceholderIndexes(templateOrComponents) {
  const components = Array.isArray(templateOrComponents)
    ? templateOrComponents
    : (Array.isArray(templateOrComponents?.components) ? templateOrComponents.components : []);
  const indexes = new Set();
  for (const component of components) {
    if (String(component?.type || '').toUpperCase() !== 'BODY') continue;
    const text = String(component?.text || '');
    const regex = /{{\s*(\d+)\s*}}/g;
    let match = null;
    while ((match = regex.exec(text)) !== null) {
      const idx = Number(match[1]);
      if (Number.isFinite(idx) && idx > 0) indexes.add(idx);
    }
  }
  return Array.from(indexes).sort((a, b) => a - b);
}

function resolveBodyText(components) {
  if (!Array.isArray(components)) return '';
  return components
    .filter((component) => String(component?.type || '').toUpperCase() === 'BODY')
    .map((component) => String(component?.text || ''))
    .join('\n');
}

function resolveBodyExamples(components) {
  if (!Array.isArray(components)) return [];
  const body = components.find((component) => String(component?.type || '').toUpperCase() === 'BODY');
  const examples = body?.example?.body_text;
  if (!Array.isArray(examples) || !Array.isArray(examples[0])) return [];
  return examples[0].map((value) => String(value ?? ''));
}

function inferVariableNameFromExample(example) {
  const value = cleanString(example).toLowerCase();
  if (!value) return '';
  if (value.includes('@')) return 'usuario_email';
  if (/^\+?\d[\d\s-]{5,}$/.test(value)) return 'telefono_clinica';
  if (/^\d{1,2}:\d{2}$/.test(value)) return 'hora_cita';
  if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(value) || /\d{1,2}\s+de\s+[a-záéíóú]/i.test(value)) return 'fecha_cita';
  if (/https?:\/\//.test(value)) return 'enlace';
  return '';
}

function inferVariableNameFromTemplateBody(bodyText, placeholderIndex, example) {
  const token = `{{${placeholderIndex}}}`;
  const at = bodyText.indexOf(token);
  if (at >= 0) {
    const before = bodyText.slice(Math.max(0, at - 60), at).toLowerCase();
    const after = bodyText.slice(at + token.length, Math.min(bodyText.length, at + token.length + 60)).toLowerCase();
    const windowText = `${before} ${after}`;

    if (/(soy|asesor|recepcion|recepción|hemos hablado|te escribo|te llamo)/.test(windowText)) return 'usuario_nombre';
    if (/(doctor|doctora|profesional|odontolog)/.test(windowText)) return 'profesional_nombre';
    if (/(estamos en|direccion|dirección|ubicacion|ubicación|calle|avenida|plaza|localizacion|localización)/.test(windowText)) return 'direccion_clinica';
    if (/(hora|horario|a las)/.test(windowText)) return 'hora_cita';
    if (/(dia|día|fecha|cita para el|visita del)/.test(windowText)) return 'fecha_cita';
    if (/(clinica|clínica|centro)/.test(windowText)) return 'nombre_clinica';
    if (/(telefono|teléfono|llamanos|llámanos|contacto|whatsapp)/.test(windowText)) return 'telefono_clinica';
    if (/(tratamiento|implante|ortodoncia|higiene|revision|revisión)/.test(windowText)) return 'tratamiento';
    if (/(web|enlace|link|url)/.test(windowText)) return 'enlace';
    if (/(hola|buenas|paciente|nombre)/.test(windowText)) return 'nombre_paciente';
  }

  return inferVariableNameFromExample(example) || `var_${placeholderIndex}`;
}

function normalizeExplicitVariables(rawVariables) {
  if (!Array.isArray(rawVariables)) return [];
  return rawVariables
    .map((variable) => {
      const index = Number(variable?.index ?? variable?.position);
      if (!Number.isFinite(index) || index <= 0) return null;
      const normalizedName = normalizeTemplateVariableName(variable?.name || `var_${index}`);
      return {
        index,
        position: index,
        name: normalizedName || `var_${index}`,
        example: cleanString(variable?.example) || VARIABLE_METADATA[normalizedName]?.example || undefined,
        description: cleanString(variable?.description) || VARIABLE_METADATA[normalizedName]?.description || `Variable ${index}`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
}

function buildVariablesFromOverride(templateName, indexes, examples = []) {
  const normalizedTemplateName = cleanString(templateName);
  const byCount = SYSTEM_TEMPLATE_OVERRIDES[normalizedTemplateName];
  if (!byCount) return null;
  const names = byCount[indexes.length];
  if (!Array.isArray(names) || names.length !== indexes.length) return null;
  return indexes.map((index, offset) => {
    const name = normalizeTemplateVariableName(names[offset] || `var_${index}`);
    return {
      index,
      position: index,
      name,
      example: cleanString(examples[offset]) || VARIABLE_METADATA[name]?.example || undefined,
      description: VARIABLE_METADATA[name]?.description || `Variable ${index}`,
    };
  });
}

function buildWhatsappTemplateVariableContract(template) {
  const components = Array.isArray(template?.components) ? template.components : [];
  const actualIndexes = extractWhatsappTemplatePlaceholderIndexes(components);
  if (!actualIndexes.length) return [];
  const examples = resolveBodyExamples(components);

  const overrideVariables = buildVariablesFromOverride(template?.name, actualIndexes, examples);
  if (overrideVariables) {
    return overrideVariables;
  }

  const explicitVariables = normalizeExplicitVariables(
    template?.variables
      || template?.catalog?.variables
      || template?.catalogVariables
      || null
  );
  const explicitByIndex = new Map(explicitVariables.map((variable) => [variable.index, variable]));
  const canUseExplicit =
    explicitVariables.length > 0
    && explicitVariables.length === actualIndexes.length
    && actualIndexes.every((index) => explicitByIndex.has(index));

  if (canUseExplicit) {
    return actualIndexes.map((index) => ({ ...explicitByIndex.get(index) }));
  }

  const bodyText = resolveBodyText(components);
  return actualIndexes.map((index) => {
    const explicit = explicitByIndex.get(index) || null;
    const inferredName = inferVariableNameFromTemplateBody(bodyText, index, examples[index - 1] || explicit?.example || '');
    const normalizedInferredName = normalizeTemplateVariableName(inferredName || `var_${index}`);
    const normalizedExplicitName = normalizeTemplateVariableName(explicit?.name || '');
    const shouldTrustExplicitMetadata = !!normalizedExplicitName && normalizedExplicitName === normalizedInferredName;
    const normalizedName = normalizedInferredName || normalizedExplicitName || `var_${index}`;
    return {
      index,
      position: index,
      name: normalizedName || `var_${index}`,
      example: (shouldTrustExplicitMetadata ? explicit?.example : '') || examples[index - 1] || VARIABLE_METADATA[normalizedName]?.example || undefined,
      description: (shouldTrustExplicitMetadata ? explicit?.description : '') || VARIABLE_METADATA[normalizedName]?.description || `Variable ${index}`,
    };
  });
}

function normalizeNamedBindings(rawBindings) {
  if (!rawBindings || typeof rawBindings !== 'object' || Array.isArray(rawBindings)) return {};
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(rawBindings)) {
    const normalizedKey = normalizeTemplateVariableName(rawKey);
    const value = rawValue === undefined || rawValue === null ? '' : String(rawValue).trim();
    if (!normalizedKey || !value) continue;
    output[normalizedKey] = value;
  }
  return output;
}

function normalizePositionalBindings(rawBindings) {
  if (!rawBindings || typeof rawBindings !== 'object' || Array.isArray(rawBindings)) return {};
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(rawBindings)) {
    const key = String(rawKey).trim();
    if (!/^\d+$/.test(key)) continue;
    const value = rawValue === undefined || rawValue === null ? '' : String(rawValue).trim();
    if (!value) continue;
    output[key] = value;
  }
  return output;
}

function buildNamedBindingsFromPositional(positionalBindings, templateVariables) {
  const positional = normalizePositionalBindings(positionalBindings);
  const output = {};
  const variables = Array.isArray(templateVariables) ? templateVariables : [];
  for (const variable of variables) {
    const key = String(variable?.index);
    const binding = positional[key];
    if (!binding) continue;
    const semanticKey = normalizeTemplateVariableName(variable?.name || `var_${key}`);
    if (!semanticKey) continue;
    output[semanticKey] = binding;
  }
  return output;
}

function buildPositionalBindingsFromNamed(namedBindings, legacyPositionalBindings, templateVariables) {
  const named = normalizeNamedBindings(namedBindings);
  const legacy = normalizePositionalBindings(legacyPositionalBindings);
  const output = {};
  const variables = Array.isArray(templateVariables) ? templateVariables : [];
  for (const variable of variables) {
    const indexKey = String(variable?.index);
    const semanticKey = normalizeTemplateVariableName(variable?.name || `var_${indexKey}`);
    const value = named[semanticKey] || legacy[indexKey] || '';
    if (!value) continue;
    output[indexKey] = value;
  }
  return output;
}

module.exports = {
  normalizeTemplateVariableName,
  extractWhatsappTemplatePlaceholderIndexes,
  buildWhatsappTemplateVariableContract,
  normalizeNamedBindings,
  normalizePositionalBindings,
  buildNamedBindingsFromPositional,
  buildPositionalBindingsFromNamed,
};
