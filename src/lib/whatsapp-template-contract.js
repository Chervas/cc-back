'use strict';

const VARIABLE_METADATA = {
  nombre_paciente: { description: 'Nombre del paciente o lead', example: 'Juan' },
  apellido_paciente: { description: 'Apellidos del paciente', example: 'García Pérez' },
  usuario_nombre: { description: 'Nombre del usuario que crea o agenda la cita', example: 'Graci' },
  usuario_apellidos: { description: 'Apellidos del usuario que crea o agenda la cita', example: 'Gonzalez' },
  usuario_email: { description: 'Email del usuario que crea o agenda la cita', example: 'graci@clinicaclick.com' },
  profesional_nombre: { description: 'Doctor o profesional asignado a la cita', example: 'Laura' },
  profesional_apellidos: { description: 'Apellidos del doctor o profesional asignado', example: 'Perez' },
  profesional_email: { description: 'Email del doctor o profesional asignado', example: 'laura.perez@clinicaclick.com' },
  fecha_cita: { description: 'Fecha de la cita programada', example: '30/03/2026' },
  hora_cita: { description: 'Hora de la cita programada', example: '10:00' },
  nombre_clinica: { description: 'Nombre de la clínica', example: 'Propdental Eixample' },
  firma_resenas: { description: 'Remitente que firma una solicitud de reseña', example: 'Recepción' },
  direccion_clinica: { description: 'Dirección completa de la clínica', example: 'Calle Rossello, 68' },
  telefono_clinica: { description: 'Teléfono de la clínica', example: '602 502 792' },
  url_web_clinica: { description: 'URL web de la clínica', example: 'https://propdental.es' },
  url_ficha_local_clinica: { description: 'URL de la ficha local de la clínica', example: 'https://g.page/r/...' },
  url_perfil_google_clinica: { description: 'URL del Perfil de Empresa Google de la clínica', example: 'https://www.google.com/maps/search/?api=1&query=Clinica&query_place_id=...' },
  url_como_llegar_clinica: { description: 'URL de Google Maps para llegar a la clínica', example: 'https://www.google.com/maps/dir/?api=1&destination=Clinica&destination_place_id=...' },
  indicaciones_acceso_clinica: { description: 'Indicaciones adicionales para encontrar el acceso de la clínica', example: 'Entra por el pasaje lateral junto a la farmacia y sube a la primera planta.' },
  url_dejar_resena_clinica: { description: 'URL oficial para dejar una reseña en Google', example: 'https://g.page/r/abcd1234/review' },
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
  apellidos_paciente: 'apellido_paciente',
  usuario: 'usuario_nombre',
  usuario_nombre: 'usuario_nombre',
  appointment_user_name: 'usuario_nombre',
  user_name: 'usuario_nombre',
  usuario_apellidos: 'usuario_apellidos',
  user_last_name: 'usuario_apellidos',
  usuario_email: 'usuario_email',
  appointment_user_email: 'usuario_email',
  user_email: 'usuario_email',
  profesional: 'profesional_nombre',
  profesional_nombre: 'profesional_nombre',
  nombre_doctor: 'profesional_nombre',
  doctor: 'profesional_nombre',
  doctor_name: 'profesional_nombre',
  profesional_apellidos: 'profesional_apellidos',
  apellidos_doctor: 'profesional_apellidos',
  doctor_last_name: 'profesional_apellidos',
  profesional_email: 'profesional_email',
  doctor_email: 'profesional_email',
  fecha_cita: 'fecha_cita',
  appointment_date: 'fecha_cita',
  hora_cita: 'hora_cita',
  appointment_time: 'hora_cita',
  nombre_clinica: 'nombre_clinica',
  clinic_name: 'nombre_clinica',
  firma_resenas: 'firma_resenas',
  remitente_resena: 'firma_resenas',
  nombre_remitente_resenas: 'firma_resenas',
  review_sender_name: 'firma_resenas',
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
  url_perfil_google_clinica: 'url_perfil_google_clinica',
  perfil_google: 'url_perfil_google_clinica',
  url_perfil_google: 'url_perfil_google_clinica',
  google_profile_url: 'url_perfil_google_clinica',
  clinic_google_profile_url: 'url_perfil_google_clinica',
  url_como_llegar_clinica: 'url_como_llegar_clinica',
  url_perfil_google_como_llegar: 'url_como_llegar_clinica',
  url_como_llegar: 'url_como_llegar_clinica',
  como_llegar: 'url_como_llegar_clinica',
  indicaciones: 'url_como_llegar_clinica',
  directions_url: 'url_como_llegar_clinica',
  clinic_directions_url: 'url_como_llegar_clinica',
  indicaciones_acceso_clinica: 'indicaciones_acceso_clinica',
  url_dejar_resena_clinica: 'url_dejar_resena_clinica',
  url_resena_google_clinica: 'url_dejar_resena_clinica',
  google_review_url: 'url_dejar_resena_clinica',
  tratamiento: 'tratamiento',
  treatment_name: 'tratamiento',
  enlace: 'enlace',
  link: 'enlace',
};

const SYSTEM_DEFAULT_NAMED_BINDINGS = {
  nombre_paciente: '{{paciente.nombre}}',
  apellido_paciente: '{{paciente.apellidos}}',
  usuario_nombre: '{{usuario.nombre}}',
  usuario_apellidos: '{{usuario.apellidos}}',
  usuario_email: '{{usuario.email}}',
  profesional_nombre: '{{profesional.nombre}}',
  profesional_apellidos: '{{profesional.apellidos}}',
  profesional_email: '{{profesional.email}}',
  fecha_cita: '{{cita.fecha}}',
  hora_cita: '{{cita.hora}}',
  nombre_clinica: '{{clinica.nombre}}',
  firma_resenas: '{{clinica.firma_resenas}}',
  direccion_clinica: '{{clinica.direccion}}',
  telefono_clinica: '{{clinica.telefono}}',
  url_web_clinica: '{{clinica.url_web}}',
  url_ficha_local_clinica: '{{clinica.url_ficha_local}}',
  url_perfil_google_clinica: '{{clinica.url_perfil_google}}',
  url_como_llegar_clinica: '{{clinica.url_como_llegar}}',
  indicaciones_acceso_clinica: '{{clinica.indicaciones_acceso}}',
  url_dejar_resena_clinica: '{{clinica.url_dejar_resena}}',
};

const SYSTEM_TEMPLATE_OVERRIDES = {
  clinicaclick_confirmacion_cita: {
    4: ['nombre_paciente', 'usuario_nombre', 'fecha_cita', 'direccion_clinica'],
    5: ['nombre_paciente', 'usuario_nombre', 'fecha_cita', 'hora_cita', 'direccion_clinica'],
  },
  clinicaclick_recordatorio_dia_antes: {
    5: ['nombre_paciente', 'hora_cita', 'nombre_clinica', 'direccion_clinica', 'telefono_clinica'],
  },
  clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil: {
    5: ['nombre_paciente', 'hora_cita', 'direccion_clinica', 'url_como_llegar_clinica', 'indicaciones_acceso_clinica'],
  },
  clinicaclick_solicitar_resena: {
    2: ['nombre_paciente', 'nombre_clinica'],
    3: ['nombre_paciente', 'firma_resenas', 'nombre_clinica'],
  },
  clinicaclick_solicitar_resena_foto: {
    2: ['nombre_paciente', 'nombre_clinica'],
    3: ['nombre_paciente', 'firma_resenas', 'nombre_clinica'],
  },
  clinicaclick_recordatorio_resena_sin_respuesta: {
    1: ['nombre_paciente'],
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

function isOpaqueTemplateVariableName(name, index) {
  const normalized = normalizeTemplateVariableName(name || '');
  const safeIndex = Number(index || 0);
  if (!normalized || !Number.isFinite(safeIndex) || safeIndex <= 0) return false;
  return normalized === String(safeIndex)
    || normalized === `var_${safeIndex}`
    || normalized === `variable_${safeIndex}`;
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

function isReviewRequestTemplateName(templateName) {
  const normalizedTemplateName = cleanString(templateName).toLowerCase();
  return normalizedTemplateName.includes('solicitar_resena')
    || normalizedTemplateName.includes('solicitud_resena')
    || normalizedTemplateName.includes('solicitud_de_opinion')
    || normalizedTemplateName.includes('opinion_tras_visita')
    || normalizedTemplateName.includes('valoracion_tras_visita');
}

function buildVariablesFromNames(indexes, names, examples = []) {
  if (!Array.isArray(names) || names.length !== indexes.length) return null;
  return indexes.map((index, offset) => {
    const name = normalizeTemplateVariableName(names[offset] || `var_${index}`);
    const rawExample = cleanString(examples[offset]);
    const usableExample = rawExample && rawExample !== String(index) ? rawExample : '';
    return {
      index,
      position: index,
      name,
      example: usableExample || VARIABLE_METADATA[name]?.example || undefined,
      description: VARIABLE_METADATA[name]?.description || `Variable ${index}`,
    };
  });
}

function buildReviewRequestVariablesFromBody(templateName, indexes, bodyText, examples = []) {
  if (!isReviewRequestTemplateName(templateName)) return null;
  if (indexes.length === 1) return buildVariablesFromNames(indexes, ['nombre_paciente'], examples);
  if (indexes.length === 2) return buildVariablesFromNames(indexes, ['nombre_paciente', 'nombre_clinica'], examples);
  if (indexes.length !== 3) return null;

  if (/soy\s*\{\{\s*2\s*\}\}\s+de\s+\{\{\s*3\s*\}\}/i.test(bodyText)) {
    return buildVariablesFromNames(indexes, ['nombre_paciente', 'firma_resenas', 'nombre_clinica'], examples);
  }
  if (/soy\s*\{\{\s*3\s*\}\}\s+de\s+\{\{\s*2\s*\}\}/i.test(bodyText)) {
    return buildVariablesFromNames(indexes, ['nombre_paciente', 'nombre_clinica', 'firma_resenas'], examples);
  }

  return buildVariablesFromNames(indexes, ['nombre_paciente', 'firma_resenas', 'nombre_clinica'], examples);
}

function buildVariablesFromOverride(templateName, indexes, examples = [], bodyText = '') {
  const reviewVariables = buildReviewRequestVariablesFromBody(templateName, indexes, bodyText, examples);
  if (reviewVariables) {
    return reviewVariables;
  }

  const normalizedTemplateName = cleanString(templateName).replace(/_v\d+$/i, '');
  const byCount = SYSTEM_TEMPLATE_OVERRIDES[normalizedTemplateName];
  if (!byCount) return null;
  const names = byCount[indexes.length];
  return buildVariablesFromNames(indexes, names, examples);
}

function buildWhatsappTemplateVariableContract(template) {
  const components = Array.isArray(template?.components) ? template.components : [];
  const actualIndexes = extractWhatsappTemplatePlaceholderIndexes(components);
  if (!actualIndexes.length) return [];
  const examples = resolveBodyExamples(components);
  const bodyText = resolveBodyText(components);

  const overrideVariables = buildVariablesFromOverride(template?.name, actualIndexes, examples, bodyText);
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
    && actualIndexes.every((index) => explicitByIndex.has(index))
    && explicitVariables.every((variable) => !isOpaqueTemplateVariableName(variable.name, variable.index));

  if (canUseExplicit) {
    return actualIndexes.map((index) => ({ ...explicitByIndex.get(index) }));
  }

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

function buildSystemNamedBindingsForTemplateVariables(templateVariables) {
  const output = {};
  const variables = Array.isArray(templateVariables) ? templateVariables : [];
  for (const variable of variables) {
    const semanticKey = normalizeTemplateVariableName(variable?.name || '');
    if (!semanticKey || output[semanticKey]) continue;
    const defaultBinding = SYSTEM_DEFAULT_NAMED_BINDINGS[semanticKey];
    if (!defaultBinding) continue;
    output[semanticKey] = defaultBinding;
  }
  return output;
}

function buildEffectiveNamedBindings(namedBindings, positionalBindings, templateVariables) {
  const variables = Array.isArray(templateVariables) ? templateVariables : [];
  const rawNamed = normalizeNamedBindings(namedBindings);
  const rawPositional = normalizePositionalBindings(positionalBindings);
  const defaultNamed = buildSystemNamedBindingsForTemplateVariables(variables);
  const fallbackNamed = buildNamedBindingsFromPositional(rawPositional, variables);
  const canonicalDefaultValues = new Set(Object.values(defaultNamed).filter(Boolean));
  const output = {};

  for (const variable of variables) {
    const semanticKey = normalizeTemplateVariableName(
      variable?.name || `var_${variable?.index || variable?.position || ''}`
    );
    if (!semanticKey) continue;

    const defaultValue = defaultNamed[semanticKey] || '';
    const rawValue = rawNamed[semanticKey] || '';
    const fallbackValue = fallbackNamed[semanticKey] || '';
    const candidate = rawValue || fallbackValue || defaultValue || '';
    if (!candidate) continue;

    if (!defaultValue) {
      output[semanticKey] = candidate;
      continue;
    }

    if (!rawValue) {
      output[semanticKey] = defaultValue;
      continue;
    }

    if (rawValue === defaultValue) {
      output[semanticKey] = rawValue;
      continue;
    }

    if (canonicalDefaultValues.has(rawValue)) {
      output[semanticKey] = defaultValue;
      continue;
    }

    output[semanticKey] = rawValue;
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
  buildSystemNamedBindingsForTemplateVariables,
  buildEffectiveNamedBindings,
};
