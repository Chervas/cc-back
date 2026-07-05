'use strict';

const FALLBACK_CODE = 'general';
const VERSION = 'medical-area-contracts-v1';
const db = require('../../models');
const MedicalAreaContract = db.MedicalAreaContract;

const TREATMENT_AREA_PROFILES = {
  dental: {
    label: 'Dental',
    hint: 'Tratamientos que pueden depender de piezas, arcadas, laboratorio y consentimientos clínicos.',
    defaultCategory: 'Odontología General',
    defaultDuration: 30,
    defaultSessions: 1,
    supportsPiece: true,
    supportsLaboratory: true,
    applicationHint: 'Define si se aplica a una pieza, rango, arcada o de forma general.',
    applicationOptions: [
      { value: 'pieza', label: 'Pieza dental' },
      { value: 'rango', label: 'Rango de piezas' },
      { value: 'arcada', label: 'Arcada completa' },
      { value: 'general', label: 'General' },
    ],
  },
  capilar: {
    label: 'Capilar',
    hint: 'Tratamientos por zona o sesión, con seguimiento visual y evolución.',
    defaultCategory: 'Diagnóstico capilar',
    defaultDuration: 45,
    defaultSessions: 1,
    supportsPiece: false,
    supportsLaboratory: false,
    applicationHint: 'No usa piezas dentales. La zona capilar se gestionará en la ficha capilar del paciente.',
    applicationOptions: [{ value: 'general', label: 'General / zona capilar' }],
  },
  nutricion: {
    label: 'Nutrición',
    hint: 'Servicios basados en objetivos, mediciones y revisiones periódicas.',
    defaultCategory: 'Nutrición clínica',
    defaultDuration: 45,
    defaultSessions: 1,
    supportsPiece: false,
    supportsLaboratory: false,
    applicationHint: 'No usa piezas ni laboratorio dental. El detalle vive en la ficha nutricional.',
    applicationOptions: [{ value: 'general', label: 'General / seguimiento' }],
  },
  psicologia: {
    label: 'Psicología',
    hint: 'Sesiones asistenciales por modalidad, duración y seguimiento.',
    defaultCategory: 'Terapia Individual',
    defaultDuration: 50,
    defaultSessions: 1,
    supportsPiece: false,
    supportsLaboratory: false,
    applicationHint: 'No usa piezas. La modalidad y el seguimiento se definen en la ficha clínica.',
    applicationOptions: [{ value: 'general', label: 'General / sesión' }],
  },
  fisioterapia: {
    label: 'Fisioterapia',
    hint: 'Tratamientos por zona corporal, sesiones y ejercicios asociados.',
    defaultCategory: 'Rehabilitación',
    defaultDuration: 45,
    defaultSessions: 1,
    supportsPiece: false,
    supportsLaboratory: false,
    applicationHint: 'No usa piezas dentales. La zona corporal se gestionará en la ficha funcional.',
    applicationOptions: [{ value: 'general', label: 'General / zona corporal' }],
  },
  estetica: {
    label: 'Estética',
    hint: 'Tratamientos por zona, sesión, consentimiento y revisión visual.',
    defaultCategory: 'Medicina Estética',
    defaultDuration: 45,
    defaultSessions: 1,
    supportsPiece: false,
    supportsLaboratory: false,
    applicationHint: 'No usa piezas dentales. La zona tratada se gestiona como dato clínico del tratamiento.',
    applicationOptions: [{ value: 'general', label: 'General / zona tratada' }],
  },
  veterinaria: {
    label: 'Veterinaria',
    hint: 'Servicios clínicos generales por mascota, procedimiento y seguimiento.',
    defaultCategory: 'Consulta General',
    defaultDuration: 30,
    defaultSessions: 1,
    supportsPiece: false,
    supportsLaboratory: false,
    applicationHint: 'No usa piezas dentales humanas. El detalle se gestiona en ficha específica.',
    applicationOptions: [{ value: 'general', label: 'General' }],
  },
  podologia: {
    label: 'Podología',
    hint: 'Servicios por zona, biomecánica, plantillas y seguimiento.',
    defaultCategory: 'Quiropodia',
    defaultDuration: 30,
    defaultSessions: 1,
    supportsPiece: false,
    supportsLaboratory: false,
    applicationHint: 'No usa piezas dentales. La zona podológica vive en la ficha clínica.',
    applicationOptions: [{ value: 'general', label: 'General / zona' }],
  },
  cirugia_digestiva: {
    label: 'Cirugía General y Digestiva',
    hint: 'Servicios quirúrgicos con valoración, procedimiento y seguimiento postoperatorio.',
    defaultCategory: 'Consulta quirúrgica',
    defaultDuration: 45,
    defaultSessions: 1,
    supportsPiece: false,
    supportsLaboratory: false,
    applicationHint: 'No usa piezas dentales. Los requisitos quirúrgicos se gestionan como protocolo del área.',
    applicationOptions: [{ value: 'general', label: 'General / procedimiento' }],
  },
  general: {
    label: 'General',
    hint: 'Servicio clínico estándar sin campos específicos de área.',
    defaultCategory: 'Consulta',
    defaultDuration: 30,
    defaultSessions: 1,
    supportsPiece: false,
    supportsLaboratory: false,
    applicationHint: 'Configuración genérica para agenda, duración y presupuesto.',
    applicationOptions: [{ value: 'general', label: 'General' }],
  },
};

const TREATMENT_SERVICE_EXAMPLES = {
  dental: ['Valoración dental', 'Limpieza dental', 'Revisión periodontal'],
  capilar: ['Valoración capilar', 'Mesoterapia capilar', 'Seguimiento postinjerto'],
  nutricion: ['Consulta nutricional', 'Seguimiento nutricional', 'Estudio antropométrico ISAK'],
  psicologia: ['Sesión de terapia individual', 'Evaluación psicológica inicial', 'Seguimiento terapéutico'],
  fisioterapia: ['Valoración fisioterapia', 'Sesión de rehabilitación', 'Revisión funcional'],
  estetica: ['Valoración estética facial', 'Tratamiento facial', 'Revisión postratamiento'],
  veterinaria: ['Consulta veterinaria', 'Revisión postoperatoria', 'Vacunación'],
  podologia: ['Valoración podológica', 'Quiropodia', 'Revisión de plantillas'],
  cirugia_digestiva: ['Consulta quirúrgica inicial', 'Revisión postoperatoria', 'Seguimiento digestivo'],
  general: ['Consulta inicial', 'Revisión clínica', 'Seguimiento'],
};

const NUTRITION_SERVICE_KIND_OPTIONS = [
  {
    value: 'consultation',
    label: 'Consulta o valoración',
    hint: 'Servicio cobrable para primera visita o valoración. En agenda se marcará si es primera cita, revisión o seguimiento.',
    icon: 'heroicons_outline:clipboard-document-list',
    recommendedProfile: 'none',
    profileLabel: 'Sin medición obligatoria',
  },
  {
    value: 'follow_up',
    label: 'Seguimiento nutricional',
    hint: 'Revisión periódica del plan. Puede comparar con mediciones previas si se activa un perfil.',
    icon: 'heroicons_outline:arrow-path',
    recommendedProfile: 'quick',
    profileLabel: 'Perfil rápido recomendado',
  },
  {
    value: 'quick_measurement',
    label: 'Medición rápida',
    hint: 'Peso y perímetros principales para control recurrente y proyección temporal.',
    icon: 'heroicons_outline:scale',
    recommendedProfile: 'quick',
    profileLabel: 'Perfil rápido',
  },
  {
    value: 'isak_study',
    label: 'Estudio express/ISAK',
    hint: 'Pliegues, perímetros, diámetros, sumatorios y somatotipo para informe antropométrico.',
    icon: 'heroicons_outline:chart-bar-square',
    recommendedProfile: 'express_isak',
    profileLabel: 'Perfil express/ISAK',
  },
  {
    value: 'nutrition_plan_pack',
    label: 'Plan o pack',
    hint: 'Servicio de varias sesiones. Mantiene el tratamiento como producto cobrable y la medición como configuración clínica.',
    icon: 'heroicons_outline:rectangle-stack',
    recommendedProfile: 'quick',
    profileLabel: 'Perfil rápido opcional',
  },
];

const NUTRITION_MEASUREMENT_PROFILE_OPTIONS = [
  {
    value: 'none',
    label: 'Sin medición',
    hint: 'Servicio nutricional sin registro antropométrico asociado.',
  },
  {
    value: 'quick',
    label: 'Perfil rápido',
    hint: 'Peso y perímetros principales para seguimiento recurrente.',
  },
  {
    value: 'express_isak',
    label: 'Perfil express/ISAK',
    hint: 'Pliegues, perímetros y diámetros para informe antropométrico.',
  },
];

const PATIENT_WORKSPACES = {
  dental: {
    enabled: false,
    route: 'tratamientos',
    labelKey: 'patients.detail.tabs.treatments',
    label: 'Tratamientos',
    icon: 'heroicons_outline:clipboard-document-list',
  },
  nutricion: {
    enabled: true,
    route: 'nutricion',
    labelKey: 'patients.detail.tabs.nutrition',
    label: 'Nutrición',
    icon: 'heroicons_outline:scale',
  },
  general: {
    enabled: false,
    route: null,
    labelKey: null,
    label: 'Ficha clínica',
    icon: 'heroicons_outline:squares-2x2',
  },
};

const APPOINTMENT_ACTIONS = {
  nutricion: {
    enabled: true,
    route: 'nutricion',
    label: 'Registrar medición',
    compareLabel: 'Registrar y comparar',
    detail: 'Abrirá la ficha nutricional para registrar medidas del perfil configurado.',
    icon: 'heroicons_outline:scale',
    compareIcon: 'heroicons_outline:arrows-right-left',
    noProfileMessage: 'Esta cita no tiene medición nutricional configurada',
    latestPrefix: 'Con anterior',
    profileDetails: {
      quick: 'Abrirá peso y perímetros principales para seguimiento.',
      express_isak: 'Abrirá pliegues, perímetros, diámetros y somatotipo.',
    },
    serviceDetails: {
      isak_study: 'Abrirá la ficha nutricional con perfil express/ISAK e informe.',
    },
  },
  general: {
    enabled: false,
    route: null,
    label: 'Abrir ficha clínica',
    compareLabel: 'Abrir seguimiento',
    detail: 'Abre el workspace clínico definido por el área médica.',
    icon: 'heroicons_outline:squares-2x2',
    compareIcon: 'heroicons_outline:arrows-right-left',
    noProfileMessage: 'Esta cita no tiene una acción clínica configurada',
    latestPrefix: 'Con anterior',
    profileDetails: {},
    serviceDetails: {},
  },
};

const MEDICAL_AREA_CONTRACT_SECTIONS = {
  dental: [
    {
      title: 'Servicio/tratamiento',
      icon: 'heroicons_outline:clipboard-document-list',
      body: 'El catálogo representa tratamientos presupuestables, normalmente ligados a pieza, rango o arcada.',
      chips: ['Pieza dental', 'Presupuesto', 'Plan por sesiones'],
    },
    {
      title: 'Cita',
      icon: 'heroicons_outline:calendar-days',
      body: 'La agenda decide si es primera cita, revisión, urgencia o continuación y arrastra duración/precio desde el tratamiento.',
      chips: ['primera_con_trat', 'continuacion', 'revision'],
    },
    {
      title: 'Workspace',
      icon: 'heroicons_outline:squares-2x2',
      body: 'Abre ficha dental, odontograma y reglas de laboratorio cuando el tratamiento lo requiere.',
      chips: ['Odontograma', 'Laboratorio', 'Consentimientos'],
    },
  ],
  nutricion: [
    {
      title: 'Servicio cobrable',
      icon: 'heroicons_outline:clipboard-document-list',
      body: 'El catálogo debe guardar servicios como Consulta nutricional, Seguimiento, Estudio ISAK o Plan mensual. No debe crear tratamientos llamados Primera cita.',
      chips: ['Consulta nutricional', 'Seguimiento', 'Estudio ISAK', 'Pack'],
    },
    {
      title: 'Tipo de cita',
      icon: 'heroicons_outline:calendar-days',
      body: 'La agenda marca primera visita, revisión o continuación. Si la primera visita tiene precio, se combina con un servicio cobrable.',
      chips: ['primera_sin_trat', 'primera_con_trat', 'revision'],
    },
    {
      title: 'Perfil clínico',
      icon: 'heroicons_outline:scale',
      body: 'El servicio puede activar medición rápida o express/ISAK; la ficha guarda medidas, informe, comparación y proyección temporal.',
      chips: ['Sin medición', 'Perfil rápido', 'Express/ISAK', 'Informe'],
    },
  ],
  capilar: [
    {
      title: 'Servicio/tratamiento',
      icon: 'heroicons_outline:clipboard-document-list',
      body: 'El catálogo diferencia valoración, procedimiento, sesiones de mantenimiento y packs de control.',
      chips: ['Valoración', 'Procedimiento', 'Sesiones'],
    },
    {
      title: 'Cita',
      icon: 'heroicons_outline:calendar-days',
      body: 'La agenda conserva el flujo de primera cita, continuación o revisión y puede activar recordatorios postprocedimiento.',
      chips: ['Primera visita', 'Sesión', 'Control'],
    },
    {
      title: 'Workspace',
      icon: 'heroicons_outline:camera',
      body: 'La ficha debe priorizar zonas capilares, fotos clínicas privadas, evolución y cuidados posteriores.',
      chips: ['Fotos privadas', 'Zonas', 'Cuidados post'],
    },
  ],
  psicologia: [
    {
      title: 'Servicio',
      icon: 'heroicons_outline:clipboard-document-list',
      body: 'El catálogo guarda sesiones, evaluaciones y bonos; la información clínica sensible vive en la ficha del paciente.',
      chips: ['Sesión', 'Evaluación', 'Bono'],
    },
    {
      title: 'Cita',
      icon: 'heroicons_outline:calendar-days',
      body: 'La agenda decide modalidad y recurrencia sin convertir cada revisión en un tratamiento nuevo.',
      chips: ['Presencial', 'Online', 'Recurrente'],
    },
    {
      title: 'Workspace',
      icon: 'heroicons_outline:lock-closed',
      body: 'La ficha debe separar notas privadas, objetivos terapéuticos y seguimiento.',
      chips: ['Notas privadas', 'Objetivos', 'Seguimiento'],
    },
  ],
  fisioterapia: [
    {
      title: 'Servicio',
      icon: 'heroicons_outline:clipboard-document-list',
      body: 'El catálogo guarda sesiones, bonos o valoraciones funcionales, no cada revisión operativa.',
      chips: ['Valoración', 'Sesión', 'Bono'],
    },
    {
      title: 'Cita',
      icon: 'heroicons_outline:calendar-days',
      body: 'La cita define primera visita, sesión de continuidad o reevaluación.',
      chips: ['Primera visita', 'Sesión', 'Reevaluación'],
    },
    {
      title: 'Workspace',
      icon: 'heroicons_outline:hand-raised',
      body: 'La ficha debe trabajar con zona corporal, ejercicios, evolución y alta funcional.',
      chips: ['Zona corporal', 'Ejercicios', 'Evolución'],
    },
  ],
  estetica: [
    {
      title: 'Servicio',
      icon: 'heroicons_outline:clipboard-document-list',
      body: 'El catálogo guarda sesiones, tratamientos por zona y packs estéticos.',
      chips: ['Zona', 'Sesiones', 'Pack'],
    },
    {
      title: 'Cita',
      icon: 'heroicons_outline:calendar-days',
      body: 'La agenda diferencia valoración, sesión y revisión, manteniendo el precio en el servicio.',
      chips: ['Valoración', 'Sesión', 'Revisión'],
    },
    {
      title: 'Workspace',
      icon: 'heroicons_outline:sparkles',
      body: 'La ficha debe activar zona tratada, consentimiento, fotos privadas y controles.',
      chips: ['Consentimiento', 'Fotos privadas', 'Control'],
    },
  ],
};

const FALLBACK_AREA_CONTRACT_SECTIONS = [
  {
    title: 'Servicio/tratamiento',
    icon: 'heroicons_outline:clipboard-document-list',
    body: 'El catálogo guarda lo que se cobra o presupuesta.',
    chips: ['Precio', 'Duración', 'Sesiones'],
  },
  {
    title: 'Cita',
    icon: 'heroicons_outline:calendar-days',
    body: 'La agenda marca el flujo operativo sin duplicar servicios.',
    chips: ['Primera cita', 'Revisión', 'Continuación'],
  },
  {
    title: 'Workspace',
    icon: 'heroicons_outline:squares-2x2',
    body: 'La ficha clínica activa los campos propios del área médica.',
    chips: ['Ficha clínica', 'Seguimiento', 'Informes'],
  },
];

const DEFAULT_TREATMENT_SETUP_STEPS = [
  {
    title: 'Servicio cobrable',
    icon: 'heroicons_outline:tag',
    body: 'Área médica, familia y nombre del servicio que se presupuesta.',
    section: 'service',
  },
  {
    title: 'Precio y duración',
    icon: 'heroicons_outline:currency-euro',
    body: 'Importe, IVA, duración y sesiones por defecto.',
    section: 'pricing',
  },
  {
    title: 'Agenda y reglas',
    icon: 'heroicons_outline:calendar-days',
    body: 'Aplicación clínica, instalación, consentimientos y automatizaciones.',
    section: 'agenda',
  },
];

const TREATMENT_SETUP_STEPS_BY_AREA = {
  dental: [
    {
      title: 'Tratamiento dental',
      icon: 'heroicons_outline:tag',
      body: 'Área, familia, nombre y si aplica a pieza, rango, arcada o general.',
      section: 'service',
    },
    {
      title: 'Precio y sesiones',
      icon: 'heroicons_outline:currency-euro',
      body: 'Importe, IVA, duración, sesiones y financiación.',
      section: 'pricing',
    },
    {
      title: 'Reglas clínicas',
      icon: 'heroicons_outline:face-smile',
      body: 'Pieza, laboratorio, consentimientos e instalación necesaria.',
      section: 'clinical',
    },
    {
      title: 'Agenda',
      icon: 'heroicons_outline:calendar-days',
      body: 'Profesionales, automatizaciones y visibilidad del servicio.',
      section: 'agenda',
    },
  ],
  nutricion: [
    {
      title: 'Servicio cobrable',
      icon: 'heroicons_outline:tag',
      body: 'Consulta, seguimiento, estudio ISAK o pack. No es el tipo de cita.',
      section: 'service',
    },
    {
      title: 'Precio y duración',
      icon: 'heroicons_outline:currency-euro',
      body: 'Importe, IVA, duración prevista y sesiones si es un plan.',
      section: 'pricing',
    },
    {
      title: 'Perfil de medición',
      icon: 'heroicons_outline:scale',
      body: 'Sin medición, perfil rápido o express/ISAK con informe y evolución.',
      section: 'nutrition',
    },
    {
      title: 'Agenda y reglas',
      icon: 'heroicons_outline:calendar-days',
      body: 'Tipo de cita, profesional, instalación y automatizaciones.',
      section: 'agenda',
    },
  ],
};

function normalizeCode(code) {
  return String(code || FALLBACK_CODE).trim().toLowerCase() || FALLBACK_CODE;
}

function getKnownCodes() {
  return Array.from(new Set([
    ...Object.keys(TREATMENT_AREA_PROFILES),
    ...Object.keys(TREATMENT_SERVICE_EXAMPLES),
    ...Object.keys(MEDICAL_AREA_CONTRACT_SECTIONS),
    ...Object.keys(TREATMENT_SETUP_STEPS_BY_AREA),
    ...Object.keys(APPOINTMENT_ACTIONS),
  ])).sort((a, b) => a.localeCompare(b, 'es'));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseStoredContract(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function cleanString(value, fallback = '') {
  const cleaned = String(value ?? '').trim();
  return cleaned || fallback;
}

function normalizeStringArray(value, fallback = []) {
  if (!Array.isArray(value)) {
    return cloneJson(fallback);
  }

  const unique = [];
  value.forEach((item) => {
    const cleaned = cleanString(item);
    if (cleaned && !unique.includes(cleaned)) {
      unique.push(cleaned);
    }
  });

  return unique.length ? unique : cloneJson(fallback);
}

function normalizeApplicationOptions(value, fallback = []) {
  if (!Array.isArray(value)) {
    return cloneJson(fallback);
  }

  const options = value
    .map((option) => ({
      value: cleanString(option?.value || option?.code),
      label: cleanString(option?.label),
    }))
    .filter((option) => option.value && option.label);

  return options.length ? options : cloneJson(fallback);
}

function normalizeProfile(value, fallback) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    label: cleanString(source.label, fallback.label),
    hint: cleanString(source.hint, fallback.hint),
    defaultCategory: cleanString(source.defaultCategory, fallback.defaultCategory),
    defaultDuration: Number.isFinite(Number(source.defaultDuration))
      ? Math.max(1, Number.parseInt(String(source.defaultDuration), 10))
      : fallback.defaultDuration,
    defaultSessions: Number.isFinite(Number(source.defaultSessions))
      ? Math.max(1, Number.parseInt(String(source.defaultSessions), 10))
      : fallback.defaultSessions,
    supportsPiece: source.supportsPiece === undefined ? !!fallback.supportsPiece : !!source.supportsPiece,
    supportsLaboratory: source.supportsLaboratory === undefined ? !!fallback.supportsLaboratory : !!source.supportsLaboratory,
    applicationHint: cleanString(source.applicationHint, fallback.applicationHint),
    applicationOptions: normalizeApplicationOptions(source.applicationOptions, fallback.applicationOptions),
  };
}

function normalizeContractSections(value, fallback = []) {
  if (!Array.isArray(value)) {
    return cloneJson(fallback);
  }

  const sections = value
    .map((section, index) => {
      const fallbackSection = fallback[index] || fallback[0] || {};
      return {
        title: cleanString(section?.title, fallbackSection.title || 'Sección'),
        icon: cleanString(section?.icon, fallbackSection.icon || 'heroicons_outline:squares-2x2'),
        body: cleanString(section?.body, fallbackSection.body || ''),
        chips: normalizeStringArray(section?.chips, fallbackSection.chips || []),
      };
    })
    .filter((section) => section.title && section.body);

  return sections.length ? sections : cloneJson(fallback);
}

function normalizeSetupSteps(value, fallback = []) {
  const validSections = new Set(['service', 'pricing', 'clinical', 'nutrition', 'agenda']);
  if (!Array.isArray(value)) {
    return cloneJson(fallback);
  }

  const steps = value
    .map((step, index) => {
      const fallbackStep = fallback[index] || fallback[0] || {};
      const requestedSection = cleanString(step?.section, fallbackStep.section || 'service');
      return {
        title: cleanString(step?.title, fallbackStep.title || 'Paso'),
        icon: cleanString(step?.icon, fallbackStep.icon || 'heroicons_outline:tag'),
        body: cleanString(step?.body, fallbackStep.body || ''),
        section: validSections.has(requestedSection)
          ? requestedSection
          : (validSections.has(fallbackStep.section) ? fallbackStep.section : 'service'),
      };
    })
    .filter((step) => step.title && step.body);

  return steps.length ? steps : cloneJson(fallback);
}

function normalizeNutritionServiceKindOptions(value, fallback = []) {
  if (!Array.isArray(value)) {
    return cloneJson(fallback);
  }

  const options = value
    .map((option) => ({
      value: cleanString(option?.value),
      label: cleanString(option?.label),
      hint: cleanString(option?.hint),
      icon: cleanString(option?.icon, 'heroicons_outline:clipboard-document-list'),
      recommendedProfile: cleanString(option?.recommendedProfile, 'none'),
      profileLabel: cleanString(option?.profileLabel),
    }))
    .filter((option) => option.value && option.label && option.hint);

  return options.length ? options : cloneJson(fallback);
}

function normalizeNutritionMeasurementProfileOptions(value, fallback = []) {
  if (!Array.isArray(value)) {
    return cloneJson(fallback);
  }

  const options = value
    .map((option) => ({
      value: cleanString(option?.value),
      label: cleanString(option?.label),
      hint: cleanString(option?.hint),
    }))
    .filter((option) => option.value && option.label && option.hint);

  return options.length ? options : cloneJson(fallback);
}

function normalizePatientWorkspace(value, fallback = PATIENT_WORKSPACES[FALLBACK_CODE]) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled === undefined ? !!fallback.enabled : !!source.enabled,
    route: source.route === null ? null : cleanString(source.route, fallback.route || null),
    labelKey: source.labelKey === null ? null : cleanString(source.labelKey, fallback.labelKey || null),
    label: cleanString(source.label, fallback.label || 'Ficha clínica'),
    icon: cleanString(source.icon, fallback.icon || 'heroicons_outline:squares-2x2'),
  };
}

function normalizeStringMap(value, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  Object.keys(source).forEach((key) => {
    const cleanKey = cleanString(key);
    const cleanValue = cleanString(source[key]);
    if (cleanKey && cleanValue) {
      normalized[cleanKey] = cleanValue;
    }
  });

  return Object.keys(normalized).length ? normalized : cloneJson(fallback || {});
}

function normalizeAppointmentAction(value, fallback = APPOINTMENT_ACTIONS[FALLBACK_CODE]) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled === undefined ? !!fallback.enabled : !!source.enabled,
    route: source.route === null ? null : cleanString(source.route, fallback.route || null),
    label: cleanString(source.label, fallback.label || 'Abrir ficha clínica'),
    compareLabel: cleanString(source.compareLabel, fallback.compareLabel || fallback.label || 'Abrir seguimiento'),
    detail: cleanString(source.detail, fallback.detail || ''),
    icon: cleanString(source.icon, fallback.icon || 'heroicons_outline:squares-2x2'),
    compareIcon: cleanString(source.compareIcon, fallback.compareIcon || fallback.icon || 'heroicons_outline:arrows-right-left'),
    noProfileMessage: cleanString(source.noProfileMessage, fallback.noProfileMessage || 'Esta cita no tiene una acción clínica configurada'),
    latestPrefix: cleanString(source.latestPrefix, fallback.latestPrefix || 'Con anterior'),
    profileDetails: normalizeStringMap(source.profileDetails, fallback.profileDetails),
    serviceDetails: normalizeStringMap(source.serviceDetails, fallback.serviceDetails),
  };
}

function getBaseContractForArea(code) {
  const normalized = normalizeCode(code);
  const profile = TREATMENT_AREA_PROFILES[normalized] || TREATMENT_AREA_PROFILES[FALLBACK_CODE];
  return {
    code: normalized,
    profile,
    service_examples: TREATMENT_SERVICE_EXAMPLES[normalized] || TREATMENT_SERVICE_EXAMPLES[FALLBACK_CODE],
    contract_sections: MEDICAL_AREA_CONTRACT_SECTIONS[normalized] || FALLBACK_AREA_CONTRACT_SECTIONS,
    setup_steps: TREATMENT_SETUP_STEPS_BY_AREA[normalized] || DEFAULT_TREATMENT_SETUP_STEPS,
    patient_workspace: PATIENT_WORKSPACES[normalized] || PATIENT_WORKSPACES[FALLBACK_CODE],
    appointment_action: APPOINTMENT_ACTIONS[normalized] || APPOINTMENT_ACTIONS[FALLBACK_CODE],
    nutrition_service_kind_options: normalized === 'nutricion' ? NUTRITION_SERVICE_KIND_OPTIONS : [],
    nutrition_measurement_profile_options: normalized === 'nutricion' ? NUTRITION_MEASUREMENT_PROFILE_OPTIONS : [],
  };
}

function normalizeContractPayload(code, payload = {}) {
  const base = getBaseContractForArea(code);
  const source = payload?.contract && typeof payload.contract === 'object' ? payload.contract : payload;
  const normalizedCode = normalizeCode(source?.code || code);
  const normalizedBase = normalizedCode === base.code ? base : getBaseContractForArea(normalizedCode);
  return {
    code: normalizedCode,
    profile: normalizeProfile(source?.profile, normalizedBase.profile),
    service_examples: normalizeStringArray(source?.service_examples, normalizedBase.service_examples),
    contract_sections: normalizeContractSections(source?.contract_sections, normalizedBase.contract_sections),
    setup_steps: normalizeSetupSteps(source?.setup_steps, normalizedBase.setup_steps),
    patient_workspace: normalizePatientWorkspace(source?.patient_workspace, normalizedBase.patient_workspace),
    appointment_action: normalizeAppointmentAction(source?.appointment_action, normalizedBase.appointment_action),
    nutrition_service_kind_options: normalizedCode === 'nutricion'
      ? normalizeNutritionServiceKindOptions(source?.nutrition_service_kind_options, normalizedBase.nutrition_service_kind_options)
      : [],
    nutrition_measurement_profile_options: normalizedCode === 'nutricion'
      ? normalizeNutritionMeasurementProfileOptions(source?.nutrition_measurement_profile_options, normalizedBase.nutrition_measurement_profile_options)
      : [],
  };
}

function mergeContract(base, override) {
  if (!override) {
    return cloneJson(base);
  }
  return normalizeContractPayload(base.code, {
    ...base,
    ...override,
    profile: { ...base.profile, ...(override.profile || {}) },
  });
}

function isMissingTableError(error) {
  const message = `${error?.name || ''} ${error?.message || ''} ${error?.parent?.code || ''}`;
  return /no such table|doesn't exist|ER_NO_SUCH_TABLE|Unknown table/i.test(message);
}

async function getOverrideRows() {
  if (!MedicalAreaContract) {
    return [];
  }

  try {
    return await MedicalAreaContract.findAll({
      where: { active: true },
      attributes: ['code', 'contract_json', 'version', 'updated_at'],
      raw: true,
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return [];
    }
    throw error;
  }
}

async function getOverrideMap() {
  const rows = await getOverrideRows();
  const map = new Map();
  rows.forEach((row) => {
    const code = normalizeCode(row.code);
    const contract = parseStoredContract(row.contract_json);
    if (contract) {
      map.set(code, contract);
    }
  });
  return map;
}

async function getContractForArea(code) {
  const normalized = normalizeCode(code);
  const base = getBaseContractForArea(normalized);
  const overrides = await getOverrideMap();
  return mergeContract(base, overrides.get(normalized));
}

async function getMedicalAreaContracts() {
  const overrides = await getOverrideMap();
  const contracts = {};
  const codes = new Set([...getKnownCodes(), ...Array.from(overrides.keys())]);
  Array.from(codes).sort((a, b) => a.localeCompare(b, 'es')).forEach((code) => {
    contracts[code] = mergeContract(getBaseContractForArea(code), overrides.get(code));
  });

  return {
    version: VERSION,
    source: overrides.size ? 'backend-db' : 'backend-static',
    fallback_code: FALLBACK_CODE,
    contracts,
  };
}

async function upsertMedicalAreaContract(code, payload, updatedBy = null) {
  if (!MedicalAreaContract) {
    const error = new Error('MedicalAreaContract model is not available');
    error.statusCode = 503;
    throw error;
  }

  const normalized = normalizeContractPayload(code, payload);

  try {
    const existing = await MedicalAreaContract.findOne({ where: { code: normalized.code } });
    if (existing) {
      await existing.update({
        contract_json: normalized,
        version: 'custom-v1',
        active: true,
        updated_by: updatedBy || null,
      });
    } else {
      await MedicalAreaContract.create({
        code: normalized.code,
        contract_json: normalized,
        version: 'custom-v1',
        active: true,
        updated_by: updatedBy || null,
      });
    }
  } catch (error) {
    if (isMissingTableError(error)) {
      error.statusCode = 503;
    }
    throw error;
  }

  return mergeContract(getBaseContractForArea(normalized.code), normalized);
}

module.exports = {
  VERSION,
  FALLBACK_CODE,
  getBaseContractForArea,
  getContractForArea,
  getMedicalAreaContracts,
  normalizeContractPayload,
  upsertMedicalAreaContract,
};
