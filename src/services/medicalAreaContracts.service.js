'use strict';

const FALLBACK_CODE = 'general';
const VERSION = 'medical-area-contracts-v1';
const db = require('../../models');
const MedicalAreaContract = db.MedicalAreaContract;
const LEGACY_APPLICATION_HINT_REPLACEMENTS = new Map([
  ['No usa piezas dentales. La zona capilar se gestionará en la ficha capilar del paciente.', 'La zona capilar se gestionará en la ficha clínica propia del área.'],
  ['No usa piezas ni laboratorio dental. El detalle vive en la ficha nutricional.', 'El detalle clínico y las mediciones viven en la ficha nutricional.'],
  ['No usa piezas. La modalidad y el seguimiento se definen en la ficha clínica.', 'La modalidad y el seguimiento se definen en la ficha clínica del área.'],
  ['No usa piezas dentales. La zona corporal se gestionará en la ficha funcional.', 'La zona corporal se gestionará en la ficha funcional del área.'],
  ['No usa piezas dentales. La zona tratada se gestiona como dato clínico del tratamiento.', 'La zona tratada se gestiona como dato clínico del tratamiento.'],
  ['No usa piezas dentales humanas. El detalle se gestiona en ficha específica.', 'El detalle clínico se gestiona en la ficha específica del área.'],
  ['No usa piezas dentales. La zona podológica vive en la ficha clínica.', 'La zona podológica vive en la ficha clínica del área.'],
  ['No usa piezas dentales. Los requisitos quirúrgicos se gestionan como protocolo del área.', 'Los requisitos quirúrgicos se gestionan como protocolo del área.'],
]);

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
    applicationHint: 'La zona capilar se gestionará en la ficha clínica propia del área.',
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
    applicationHint: 'El detalle clínico y las mediciones viven en la ficha nutricional.',
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
    applicationHint: 'La modalidad y el seguimiento se definen en la ficha clínica del área.',
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
    applicationHint: 'La zona corporal se gestionará en la ficha funcional del área.',
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
    applicationHint: 'La zona tratada se gestiona como dato clínico del tratamiento.',
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
    applicationHint: 'El detalle clínico se gestiona en la ficha específica del área.',
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
    applicationHint: 'La zona podológica vive en la ficha clínica del área.',
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
    applicationHint: 'Los requisitos quirúrgicos se gestionan como protocolo del área.',
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
  nutricion: ['Consulta nutricional', 'Valoración nutricional', 'Seguimiento nutricional', 'Estudio antropométrico completo', 'Plan de seguimiento mensual'],
  psicologia: ['Sesión de terapia individual', 'Evaluación psicológica inicial', 'Seguimiento terapéutico'],
  fisioterapia: ['Valoración fisioterapia', 'Sesión de rehabilitación', 'Revisión funcional'],
  estetica: ['Valoración estética facial', 'Tratamiento facial', 'Revisión postratamiento'],
  veterinaria: ['Consulta veterinaria', 'Revisión postoperatoria', 'Vacunación'],
  podologia: ['Valoración podológica', 'Quiropodia', 'Revisión de plantillas'],
  cirugia_digestiva: ['Consulta quirúrgica inicial', 'Revisión postoperatoria', 'Seguimiento digestivo'],
  general: ['Consulta inicial', 'Revisión clínica', 'Seguimiento clínico'],
};

const NUTRITION_SERVICE_KIND_OPTIONS = [
  {
    value: 'consultation',
    label: 'Consulta o valoración',
    hint: 'Servicio cobrable para primera visita o valoración. En agenda se marcará si es primera cita, revisión o seguimiento.',
    icon: 'heroicons_outline:clipboard-document-list',
    recommendedProfile: 'none',
    profileLabel: 'Sin medición obligatoria',
    recommendedName: 'Consulta nutricional',
    defaultCategory: 'Consulta nutricional',
    defaultGenerateReport: false,
    defaultComparePrevious: false,
    defaultSessions: 1,
  },
  {
    value: 'follow_up',
    label: 'Seguimiento nutricional',
    hint: 'Revisión periódica del plan. Puede comparar con mediciones previas si se activa un perfil.',
    icon: 'heroicons_outline:arrow-path',
    recommendedProfile: 'quick',
    profileLabel: 'Express recomendado',
    recommendedName: 'Seguimiento nutricional',
    defaultCategory: 'Nutrición clínica',
    defaultGenerateReport: false,
    defaultComparePrevious: true,
    defaultSessions: 1,
  },
  {
    value: 'quick_measurement',
    label: 'Medición rápida',
    hint: 'Peso y perímetros principales para control recurrente y proyección temporal.',
    icon: 'heroicons_outline:scale',
    recommendedProfile: 'quick',
    profileLabel: 'Express',
    recommendedName: 'Medición rápida nutricional',
    defaultCategory: 'Consulta nutricional',
    defaultGenerateReport: false,
    defaultComparePrevious: true,
    defaultSessions: 1,
  },
  {
    value: 'isak_study',
    label: 'Estudio completo',
    hint: 'Pliegues, perímetros, diámetros, sumatorios y somatotipo para informe antropométrico.',
    icon: 'heroicons_outline:chart-bar-square',
    recommendedProfile: 'express_isak',
    profileLabel: 'Perfil completo',
    recommendedName: 'Estudio antropométrico completo',
    defaultCategory: 'Antropometría avanzada',
    defaultGenerateReport: true,
    defaultComparePrevious: true,
    defaultSessions: 1,
  },
  {
    value: 'nutrition_plan_pack',
    label: 'Plan o pack',
    hint: 'Servicio de varias sesiones. Mantiene el tratamiento como producto cobrable y la medición como configuración clínica.',
    icon: 'heroicons_outline:rectangle-stack',
    recommendedProfile: 'quick',
    profileLabel: 'Express opcional',
    recommendedName: 'Plan de seguimiento mensual',
    defaultCategory: 'Nutrición clínica',
    defaultGenerateReport: false,
    defaultComparePrevious: true,
    defaultSessions: 4,
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
    label: 'Express',
    hint: 'Peso y perímetros principales para seguimiento recurrente.',
  },
  {
    value: 'express_isak',
    label: 'Completa',
    hint: 'Pliegues, perímetros y diámetros para informe antropométrico.',
  },
];

const NUTRITION_MEASUREMENT_FIELD_DEFINITIONS = {
  weight_kg: { label: 'Peso', unit: 'kg', min: 20, max: 300 },
  stature_cm: { label: 'Estatura', unit: 'cm', min: 80, max: 230 },
  arm_span_cm: { label: 'Envergadura de brazos', unit: 'cm', min: 80, max: 260 },
  waist_cm: { label: 'Cintura', unit: 'cm', min: 30, max: 220 },
  hip_cm: { label: 'Cadera', unit: 'cm', min: 30, max: 240 },
  arm_relaxed_cm: { label: 'Brazo relajado', unit: 'cm', min: 10, max: 80 },
  arm_flexed_tensed_cm: { label: 'Brazo flexionado', unit: 'cm', min: 10, max: 90 },
  forearm_cm: { label: 'Antebrazo', unit: 'cm', min: 10, max: 60 },
  thigh_cm: { label: 'Muslo', unit: 'cm', min: 20, max: 100 },
  chest_cm: { label: 'Tórax', unit: 'cm', min: 50, max: 180 },
  head_cm: { label: 'Perímetro cefálico', unit: 'cm', min: 35, max: 75 },
  calf_cm: { label: 'Pantorrilla', unit: 'cm', min: 10, max: 90 },
  sitting_height_cm: { label: 'Altura sentado', unit: 'cm', min: 40, max: 140 },
  skinfold_triceps_mm: { label: 'Tríceps', unit: 'mm', min: 1, max: 80 },
  skinfold_subscapular_mm: { label: 'Subescapular', unit: 'mm', min: 1, max: 90 },
  skinfold_biceps_mm: { label: 'Bíceps', unit: 'mm', min: 1, max: 70 },
  skinfold_iliac_crest_mm: { label: 'Cresta ilíaca', unit: 'mm', min: 1, max: 100 },
  skinfold_supraspinale_mm: { label: 'Supraespinal', unit: 'mm', min: 1, max: 100 },
  skinfold_abdominal_mm: { label: 'Abdominal', unit: 'mm', min: 1, max: 120 },
  skinfold_front_thigh_mm: { label: 'Muslo frontal', unit: 'mm', min: 1, max: 120 },
  skinfold_medial_calf_mm: { label: 'Pantorrilla medial', unit: 'mm', min: 1, max: 90 },
  breadth_biacromial_cm: { label: 'Diámetro biacromial', unit: 'cm', min: 20, max: 60 },
  breadth_biiliocristal_cm: { label: 'Diámetro biiliocrestal', unit: 'cm', min: 15, max: 50 },
  breadth_humerus_cm: { label: 'Diámetro húmero', unit: 'cm', min: 3, max: 12 },
  breadth_wrist_bistyloid_cm: { label: 'Diámetro biestiloideo', unit: 'cm', min: 3, max: 12 },
  breadth_femur_cm: { label: 'Diámetro fémur', unit: 'cm', min: 5, max: 16 },
  depth_chest_ap_cm: { label: 'Diámetro tórax AP', unit: 'cm', min: 10, max: 40 },
  breadth_chest_transverse_cm: { label: 'Diámetro tórax transverso', unit: 'cm', min: 15, max: 50 },
};

const NUTRITION_MEASUREMENT_PROFILE_SCHEMAS = [
  {
    code: 'quick',
    name: 'Express',
    description: 'Seguimiento de consulta con peso y perímetros principales.',
    groups: [
      {
        key: 'base',
        label: 'Datos base',
        fields: ['weight_kg', 'stature_cm', 'waist_cm', 'hip_cm', 'arm_relaxed_cm', 'calf_cm'],
        required_fields: ['weight_kg', 'stature_cm'],
      },
    ],
  },
  {
    code: 'express_isak',
    name: 'Completa',
    description: 'Perfil antropométrico restringido para informe y evolución.',
    groups: [
      {
        key: 'base',
        label: 'Datos base',
        fields: ['weight_kg', 'stature_cm', 'sitting_height_cm', 'arm_span_cm'],
        required_fields: ['weight_kg', 'stature_cm'],
      },
      {
        key: 'skinfolds',
        label: 'Pliegues',
        fields: [
          'skinfold_triceps_mm',
          'skinfold_subscapular_mm',
          'skinfold_biceps_mm',
          'skinfold_iliac_crest_mm',
          'skinfold_supraspinale_mm',
          'skinfold_abdominal_mm',
          'skinfold_front_thigh_mm',
          'skinfold_medial_calf_mm',
        ],
        required_fields: [
          'skinfold_triceps_mm',
          'skinfold_subscapular_mm',
          'skinfold_biceps_mm',
          'skinfold_iliac_crest_mm',
          'skinfold_supraspinale_mm',
          'skinfold_medial_calf_mm',
        ],
      },
      {
        key: 'girths',
        label: 'Perímetros',
        fields: [
          'arm_relaxed_cm',
          'arm_flexed_tensed_cm',
          'forearm_cm',
          'thigh_cm',
          'chest_cm',
          'head_cm',
          'waist_cm',
          'hip_cm',
          'calf_cm',
        ],
        required_fields: ['arm_flexed_tensed_cm', 'calf_cm'],
      },
      {
        key: 'breadths',
        label: 'Diámetros',
        fields: [
          'breadth_humerus_cm',
          'breadth_wrist_bistyloid_cm',
          'breadth_femur_cm',
          'breadth_biacromial_cm',
          'breadth_biiliocristal_cm',
          'depth_chest_ap_cm',
          'breadth_chest_transverse_cm',
        ],
        required_fields: ['breadth_humerus_cm', 'breadth_femur_cm'],
      },
    ],
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
  capilar: {
    enabled: false,
    route: 'capilar',
    labelKey: null,
    label: 'Capilar',
    icon: 'heroicons_outline:camera',
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
    requiresProfile: true,
    profileDetails: {
      quick: 'Abrirá peso y perímetros principales para seguimiento.',
      express_isak: 'Abrirá pliegues, perímetros, diámetros y somatotipo.',
    },
    serviceDetails: {
      isak_study: 'Abrirá la ficha nutricional con perfil completo e informe.',
    },
  },
  capilar: {
    enabled: false,
    route: 'capilar',
    label: 'Abrir seguimiento capilar',
    compareLabel: 'Abrir evolución capilar',
    detail: 'Abrirá la ficha capilar con zonas, fotos clínicas privadas y evolución.',
    icon: 'heroicons_outline:camera',
    compareIcon: 'heroicons_outline:arrows-right-left',
    noProfileMessage: 'Esta cita no tiene seguimiento capilar configurado',
    latestPrefix: 'Con anterior',
    requiresProfile: false,
    profileDetails: {},
    serviceDetails: {},
  },
  general: {
    enabled: false,
    route: null,
    label: 'Abrir ficha clínica',
    compareLabel: 'Abrir seguimiento',
    detail: 'Abre la ficha clínica definida por el área médica.',
    icon: 'heroicons_outline:squares-2x2',
    compareIcon: 'heroicons_outline:arrows-right-left',
    noProfileMessage: 'Esta cita no tiene una acción clínica configurada',
    latestPrefix: 'Con anterior',
    requiresProfile: false,
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
      title: 'Ficha clínica',
      icon: 'heroicons_outline:squares-2x2',
      body: 'Abre ficha dental, odontograma y reglas de laboratorio cuando el tratamiento lo requiere.',
      chips: ['Odontograma', 'Laboratorio', 'Consentimientos'],
    },
  ],
  nutricion: [
    {
      title: 'Servicio cobrable',
      icon: 'heroicons_outline:clipboard-document-list',
      body: 'El catálogo debe guardar servicios como Consulta nutricional, Valoración nutricional, Seguimiento, Estudio antropométrico completo o Plan mensual. No debe crear tratamientos llamados Primera cita.',
      chips: ['Consulta nutricional', 'Valoración nutricional', 'Seguimiento', 'Antropometría completa', 'Pack'],
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
      body: 'El servicio puede activar medición Express o Completa; la ficha guarda medidas, informe, comparación y proyección temporal.',
      chips: ['Sin medición', 'Express', 'Completa', 'Informe'],
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
      title: 'Ficha clínica',
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
      title: 'Ficha clínica',
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
      title: 'Ficha clínica',
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
      title: 'Ficha clínica',
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
    title: 'Ficha clínica',
    icon: 'heroicons_outline:squares-2x2',
    body: 'La ficha clínica activa los campos propios del área médica.',
    chips: ['Ficha clínica', 'Seguimiento', 'Informes'],
  },
];

const DEFAULT_TREATMENT_SETUP_STEPS = [
  {
    title: 'Servicio cobrable',
    icon: 'heroicons_outline:tag',
    body: 'Área médica, familia y nombre del servicio o tratamiento que se cobra.',
    section: 'service',
  },
  {
    title: 'Tarifas y duración',
    icon: 'heroicons_outline:currency-euro',
    body: 'Precio base y excepciones opcionales para primera visita, seguimiento, revisión o urgencia.',
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
      title: 'Tarifas y sesiones',
      icon: 'heroicons_outline:currency-euro',
      body: 'Precio base, sesiones y precios propios si primera visita, revisión o urgencia no cuestan igual.',
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
      body: 'Consulta, valoración, seguimiento, estudio antropométrico completo o pack. No es el tipo de cita.',
      section: 'service',
    },
    {
      title: 'Tarifas y duración',
      icon: 'heroicons_outline:currency-euro',
      body: 'Precio base del servicio y precio propio si primera visita, revisión o seguimiento cambian.',
      section: 'pricing',
    },
    {
      title: 'Perfil de medición',
      icon: 'heroicons_outline:scale',
      body: 'Sin medición, Express o Completa con informe y evolución.',
      section: 'nutrition',
    },
    {
      title: 'Agenda y reglas',
      icon: 'heroicons_outline:calendar-days',
      body: 'Tipo de cita en agenda, profesional, instalación y automatizaciones.',
      section: 'agenda',
    },
  ],
};

const MEDICAL_AREA_PROTOCOL_RULES = {
  dental: [
    {
      code: 'dental-consent-before-surgery',
      title: 'Consentimiento antes de cirugía',
      description: 'Bloquea la sesión quirúrgica si el consentimiento asociado no está firmado.',
      source_type: 'document',
      source_ref: 'surgical_consent_signed',
      target_type: 'treatment',
      target_ref: 'dental_surgery',
      wait_min_value: 0,
      wait_min_unit: 'days',
      condition: 'Consentimiento quirúrgico firmado y vigente',
      action: 'block',
      scope: 'medical_area',
      enabled: true,
    },
    {
      code: 'dental-lab-before-prosthesis',
      title: 'Laboratorio recibido antes de prótesis',
      description: 'Impide programar la colocación si el trabajo de laboratorio requerido no consta como recibido.',
      source_type: 'laboratory',
      source_ref: 'lab_work_received',
      target_type: 'treatment',
      target_ref: 'prosthesis_placement',
      wait_min_value: 0,
      wait_min_unit: 'days',
      condition: 'Pedido de laboratorio recibido en clínica',
      action: 'block',
      scope: 'treatment_group',
      enabled: true,
    },
    {
      code: 'dental-review-after-surgery',
      title: 'Revisión tras cirugía',
      description: 'Sugiere una revisión posterior a tratamientos quirúrgicos para cerrar seguimiento clínico.',
      source_type: 'treatment',
      source_ref: 'surgery_completed',
      target_type: 'appointment',
      target_ref: 'post_surgery_review',
      wait_min_value: 7,
      wait_min_unit: 'days',
      condition: 'Tratamiento quirúrgico marcado como realizado',
      action: 'suggest',
      scope: 'medical_area',
      enabled: true,
    },
  ],
  nutricion: [
    {
      code: 'nutrition-measurement-before-report',
      title: 'Medición completa antes de informe',
      description: 'Evita generar un informe antropométrico completo sin una medición compatible.',
      source_type: 'measurement',
      source_ref: 'express_isak_completed',
      target_type: 'document',
      target_ref: 'nutrition_report',
      wait_min_value: 0,
      wait_min_unit: 'days',
      condition: 'Medición Completa guardada con campos mínimos de cálculo',
      action: 'block',
      scope: 'medical_area',
      enabled: true,
    },
    {
      code: 'nutrition-follow-up-after-measurement',
      title: 'Seguimiento tras medición',
      description: 'Sugiere una cita de seguimiento cuando ya existe una medición reciente.',
      source_type: 'measurement',
      source_ref: 'latest_measurement',
      target_type: 'appointment',
      target_ref: 'nutrition_follow_up',
      wait_min_value: 2,
      wait_min_unit: 'weeks',
      condition: 'Medición guardada con objetivo activo',
      action: 'suggest',
      scope: 'medical_area',
      enabled: true,
    },
    {
      code: 'nutrition-compare-with-previous',
      title: 'Comparar con medición previa',
      description: 'Sugiere comparar con la medición anterior cuando el perfil sea compatible.',
      source_type: 'measurement',
      source_ref: 'previous_compatible_measurement',
      target_type: 'measurement',
      target_ref: 'current_measurement',
      wait_min_value: 0,
      wait_min_unit: 'days',
      condition: 'Existe medición anterior del mismo paciente y perfil comparable',
      action: 'suggest',
      scope: 'medical_area',
      enabled: true,
    },
  ],
  capilar: [
    {
      code: 'capilar-photo-before-control',
      title: 'Foto clínica antes de control',
      description: 'Sugiere añadir fotos privadas antes de valorar evolución capilar.',
      source_type: 'document',
      source_ref: 'clinical_photos',
      target_type: 'appointment',
      target_ref: 'capilar_control',
      wait_min_value: 0,
      wait_min_unit: 'days',
      condition: 'Control evolutivo capilar abierto',
      action: 'suggest',
      scope: 'medical_area',
      enabled: true,
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
    ...Object.keys(MEDICAL_AREA_PROTOCOL_RULES),
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

function sanitizeNutritionLegalText(value) {
  const cleaned = cleanString(value);
  if (!cleaned) return '';
  return cleaned
    .replace(/Estudio antropom[eé]trico ISAK/gi, 'Estudio antropométrico completo')
    .replace(/Antropometr[ií]a ISAK/gi, 'Antropometría avanzada')
    .replace(/estudio ISAK/gi, 'estudio antropométrico completo')
    .replace(/Express\/ISAK/gi, 'Completa')
    .replace(/express\/ISAK/gi, 'Completa')
    .replace(/Perfil r[aá]pido/gi, 'Express')
    .replace(/\bisak\b/gi, 'antropometría');
}

function sanitizeNutritionTextArray(value = []) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((item) => sanitizeNutritionLegalText(item))
    .filter(Boolean)));
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

function normalizeServiceExamples(code, value, fallback = []) {
  const normalized = normalizeStringArray(value, fallback);
  if (normalizeCode(code) !== 'nutricion') {
    return normalized;
  }

  const required = TREATMENT_SERVICE_EXAMPLES.nutricion;
  return [
    ...required,
    ...normalized.filter((item) => !required.includes(item)),
  ];
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

function normalizeApplicationHint(value, fallback) {
  const hint = cleanString(value, fallback);
  return LEGACY_APPLICATION_HINT_REPLACEMENTS.get(hint) || hint;
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
    applicationHint: normalizeApplicationHint(source.applicationHint, fallback.applicationHint),
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

  const fallbackBySection = new Map((fallback || [])
    .filter((step) => validSections.has(step?.section))
    .map((step) => [step.section, step]));

  const steps = value
    .map((step, index) => {
      const indexedFallbackStep = fallback[index] || fallback[0] || {};
      const requestedSection = cleanString(step?.section, indexedFallbackStep.section || 'service');
      const resolvedSection = validSections.has(requestedSection)
        ? requestedSection
        : (validSections.has(indexedFallbackStep.section) ? indexedFallbackStep.section : 'service');
      const fallbackStep = fallbackBySection.get(resolvedSection) || indexedFallbackStep;
      const title = cleanString(step?.title, fallbackStep.title || 'Paso');
      const body = cleanString(step?.body, fallbackStep.body || '');
      const useFallbackCopy = isLegacySetupStepCopy(resolvedSection, title, body);
      return {
        title: useFallbackCopy ? (fallbackStep.title || title) : title,
        icon: cleanString(step?.icon, fallbackStep.icon || 'heroicons_outline:tag'),
        body: useFallbackCopy ? (fallbackStep.body || body) : body,
        section: resolvedSection,
      };
    })
    .filter((step) => step.title && step.body);

  return steps.length ? steps : cloneJson(fallback);
}

function isLegacySetupStepCopy(section, title, body) {
  const normalizedTitle = cleanString(title).toLowerCase();
  const normalizedBody = cleanString(body).toLowerCase();

  if (section === 'service') {
    return normalizedBody === 'área médica, familia y nombre del servicio que se presupuesta.';
  }

  if (section === 'pricing') {
    return ['precio y duración', 'precio y sesiones'].includes(normalizedTitle)
      || normalizedBody.startsWith('importe, iva');
  }

  if (section === 'agenda') {
    return normalizedBody === 'tipo de cita, profesional, instalación y automatizaciones.';
  }

  return false;
}

function normalizeProtocolRules(value, fallback = []) {
  const validEntityTypes = new Set(['treatment', 'test', 'clinical_condition', 'document', 'laboratory', 'measurement', 'appointment']);
  const validActions = new Set(['suggest', 'block', 'allow_override_with_reason', 'system_block']);
  const validScopes = new Set(['medical_area', 'treatment', 'treatment_group', 'clinic']);
  const validWaitUnits = new Set(['days', 'weeks', 'months']);

  if (value === undefined || value === null) {
    return cloneJson(fallback);
  }
  if (!Array.isArray(value)) {
    return cloneJson(fallback);
  }

  const fallbackByCode = new Map((fallback || []).map((rule) => [rule.code, rule]));
  const rules = value
    .map((rule, index) => {
      const code = cleanString(rule?.code, `rule_${index + 1}`).replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
      const matchedFallbackRule = fallbackByCode.get(code) || null;
      const fallbackRule = matchedFallbackRule || fallback[index] || fallback[0] || {};
      const sourceType = cleanString(rule?.source_type, fallbackRule.source_type || 'treatment');
      const targetType = cleanString(rule?.target_type, fallbackRule.target_type || 'appointment');
      const action = cleanString(rule?.action, fallbackRule.action || 'suggest');
      const scope = cleanString(rule?.scope, fallbackRule.scope || 'medical_area');
      const waitUnit = cleanString(rule?.wait_min_unit, fallbackRule.wait_min_unit || 'days');
      const waitMinValue = Number.isFinite(Number(rule?.wait_min_value))
        ? Math.max(0, Number.parseInt(String(rule.wait_min_value), 10))
        : Math.max(0, Number.parseInt(String(fallbackRule.wait_min_value || 0), 10));

      return {
        code,
        title: cleanString(rule?.title, fallbackRule.title || 'Regla de protocolo'),
        description: cleanString(rule?.description, fallbackRule.description || ''),
        source_type: validEntityTypes.has(sourceType) ? sourceType : (fallbackRule.source_type || 'treatment'),
        source_ref: cleanString(rule?.source_ref, matchedFallbackRule?.source_ref || null) || null,
        target_type: validEntityTypes.has(targetType) ? targetType : (fallbackRule.target_type || 'appointment'),
        target_ref: cleanString(rule?.target_ref, matchedFallbackRule?.target_ref || null) || null,
        wait_min_value: Number.isFinite(waitMinValue) ? waitMinValue : 0,
        wait_min_unit: validWaitUnits.has(waitUnit) ? waitUnit : (fallbackRule.wait_min_unit || 'days'),
        condition: cleanString(rule?.condition, fallbackRule.condition || ''),
        action: validActions.has(action) ? action : (fallbackRule.action || 'suggest'),
        scope: validScopes.has(scope) ? scope : (fallbackRule.scope || 'medical_area'),
        enabled: rule?.enabled === undefined ? (fallbackRule.enabled === undefined ? true : !!fallbackRule.enabled) : !!rule.enabled,
      };
    })
    .filter((rule, index, list) => rule.code && rule.title && rule.description && list.findIndex((item) => item.code === rule.code) === index);

  return rules;
}

function normalizeNutritionServiceKindOptions(value, fallback = []) {
  if (!Array.isArray(value)) {
    return cloneJson(fallback);
  }

  const fallbackByValue = new Map((fallback || []).map((option) => [option.value, option]));
  const sourceByValue = new Map(value.map((option) => [cleanString(option?.value), option]).filter(([optionValue]) => optionValue));
  const orderedValues = [
    ...(fallback || []).map((option) => option.value),
    ...Array.from(sourceByValue.keys()).filter((optionValue) => !fallbackByValue.has(optionValue)),
  ];
  const options = orderedValues
    .map((optionValue) => {
      const option = sourceByValue.get(optionValue) || {};
      const fallbackOption = fallbackByValue.get(optionValue) || {};
      const defaultSessions = Number.isFinite(Number(option?.defaultSessions))
        ? Math.max(1, Number.parseInt(String(option.defaultSessions), 10))
        : (fallbackOption.defaultSessions || 1);
      return {
        value: optionValue,
        label: cleanString(option?.label, fallbackOption.label),
        hint: cleanString(option?.hint, fallbackOption.hint),
        icon: cleanString(option?.icon, fallbackOption.icon || 'heroicons_outline:clipboard-document-list'),
        recommendedProfile: cleanString(option?.recommendedProfile, fallbackOption.recommendedProfile || 'none'),
        profileLabel: cleanString(option?.profileLabel, fallbackOption.profileLabel),
        recommendedName: cleanString(option?.recommendedName, fallbackOption.recommendedName),
        defaultCategory: cleanString(option?.defaultCategory, fallbackOption.defaultCategory),
        defaultGenerateReport: option?.defaultGenerateReport === undefined ? !!fallbackOption.defaultGenerateReport : !!option.defaultGenerateReport,
        defaultComparePrevious: option?.defaultComparePrevious === undefined ? !!fallbackOption.defaultComparePrevious : !!option.defaultComparePrevious,
        defaultSessions,
      };
    })
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

function normalizeNutritionMeasurementFields(value, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  Object.keys(fallback || {}).forEach((key) => {
    const item = source[key] && typeof source[key] === 'object' ? source[key] : {};
    const fallbackField = fallback[key] || {};
    const next = {
      label: cleanString(item.label, fallbackField.label || key),
      unit: cleanString(item.unit, fallbackField.unit || ''),
    };
    const min = Number(item.min ?? fallbackField.min);
    const max = Number(item.max ?? fallbackField.max);
    if (Number.isFinite(min)) next.min = min;
    if (Number.isFinite(max)) next.max = max;
    normalized[key] = next;
  });

  return Object.keys(normalized).length ? normalized : cloneJson(fallback);
}

function normalizeNutritionMeasurementProfileSchemas(value, fallback = [], fields = {}) {
  if (!Array.isArray(value)) {
    return cloneJson(fallback);
  }

  const knownFields = new Set(Object.keys(fields || {}));
  const fallbackByCode = new Map((fallback || []).map((profile) => [profile.code, profile]));
  const schemas = value
    .map((profile) => {
      const code = cleanString(profile?.code);
      const fallbackProfile = fallbackByCode.get(code);
      if (!code || !fallbackProfile) {
        return null;
      }

      const providedGroups = Array.isArray(profile?.groups) ? profile.groups : [];
      const providedGroupsByKey = new Map(providedGroups
        .map((group) => [cleanString(group?.key), group])
        .filter(([key]) => key));
      const groups = Array.isArray(fallbackProfile.groups)
        ? fallbackProfile.groups.map((fallbackGroup, index) => {
          const group = providedGroupsByKey.get(fallbackGroup.key) || {};
          const fallbackRequiredFields = normalizeStringArray(fallbackGroup.required_fields, [])
            .filter((field) => knownFields.has(field) && (fallbackGroup.fields || []).includes(field));
          const groupFields = normalizeStringArray(group?.fields, fallbackGroup.fields || [])
            .filter((field) => knownFields.has(field));
          const fieldsWithRequired = Array.from(new Set([
            ...fallbackRequiredFields,
            ...(groupFields.length ? groupFields : cloneJson(fallbackGroup.fields || [])),
          ]));
          return {
            key: cleanString(group?.key, fallbackGroup.key || `group_${index + 1}`),
            label: cleanString(group?.label, fallbackGroup.label || 'Grupo'),
            fields: fieldsWithRequired,
            required_fields: fallbackRequiredFields,
          };
        })
        : cloneJson(fallbackProfile.groups || []);

      return {
        code: fallbackProfile.code,
        name: cleanString(profile?.name, fallbackProfile.name),
        description: cleanString(profile?.description, fallbackProfile.description),
        groups: groups.filter((group) => group.key && group.label && group.fields?.length),
      };
    })
    .filter(Boolean);

  const schemaByCode = new Map(schemas.map((schema) => [schema.code, schema]));
  return fallback.map((profile) => schemaByCode.get(profile.code) || cloneJson(profile));
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
    requiresProfile: source.requiresProfile === undefined ? !!fallback.requiresProfile : !!source.requiresProfile,
    profileDetails: normalizeStringMap(source.profileDetails, fallback.profileDetails),
    serviceDetails: normalizeStringMap(source.serviceDetails, fallback.serviceDetails),
  };
}

function normalizeNutritionContractDefaults(contract, fallback) {
  if (contract.code !== 'nutricion') {
    return contract;
  }

  const serviceSection = fallback.contract_sections?.[0];
  const serviceStep = fallback.setup_steps?.find((step) => step.section === 'service');

  return {
    ...contract,
    service_examples: sanitizeNutritionTextArray(contract.service_examples),
    contract_sections: contract.contract_sections.map((section, index) => {
      const sanitized = {
        ...section,
        title: sanitizeNutritionLegalText(section.title) || section.title,
        body: sanitizeNutritionLegalText(section.body) || section.body,
        chips: sanitizeNutritionTextArray(section.chips),
      };
      if (index !== 0 || !serviceSection || /Valoraci[oó]n nutricional/i.test(sanitized.body)) {
        return sanitized;
      }
      return {
        ...sanitized,
        body: serviceSection.body,
        chips: normalizeStringArray([
          ...(serviceSection.chips || []),
          ...(sanitized.chips || []),
        ], serviceSection.chips || []),
      };
    }),
    setup_steps: contract.setup_steps.map((step) => {
      const sanitized = {
        ...step,
        title: sanitizeNutritionLegalText(step.title) || step.title,
        body: sanitizeNutritionLegalText(step.body) || step.body,
      };
      if (step.section !== 'service' || !serviceStep || /valoraci[oó]n/i.test(sanitized.body)) {
        return sanitized;
      }
      return {
        ...sanitized,
        body: serviceStep.body,
      };
    }),
    appointment_action: {
      ...contract.appointment_action,
      detail: sanitizeNutritionLegalText(contract.appointment_action?.detail) || contract.appointment_action?.detail,
      noProfileMessage: sanitizeNutritionLegalText(contract.appointment_action?.noProfileMessage) || contract.appointment_action?.noProfileMessage,
      profileDetails: Object.fromEntries(Object.entries(contract.appointment_action?.profileDetails || {})
        .map(([key, value]) => [key, sanitizeNutritionLegalText(value) || value])),
      serviceDetails: Object.fromEntries(Object.entries(contract.appointment_action?.serviceDetails || {})
        .map(([key, value]) => [key, sanitizeNutritionLegalText(value) || value])),
    },
    protocol_rules: contract.protocol_rules.map((rule) => ({
      ...rule,
      title: sanitizeNutritionLegalText(rule.title) || rule.title,
      description: sanitizeNutritionLegalText(rule.description) || rule.description,
      condition: sanitizeNutritionLegalText(rule.condition) || rule.condition,
    })),
    nutrition_service_kind_options: contract.nutrition_service_kind_options.map((option) => ({
      ...option,
      label: sanitizeNutritionLegalText(option.label) || option.label,
      hint: sanitizeNutritionLegalText(option.hint) || option.hint,
      profileLabel: sanitizeNutritionLegalText(option.profileLabel) || option.profileLabel,
      recommendedName: sanitizeNutritionLegalText(option.recommendedName) || option.recommendedName,
      defaultCategory: sanitizeNutritionLegalText(option.defaultCategory) || option.defaultCategory,
    })),
    nutrition_measurement_profile_options: contract.nutrition_measurement_profile_options.map((option) => ({
      ...option,
      label: sanitizeNutritionLegalText(option.label) || option.label,
      hint: sanitizeNutritionLegalText(option.hint) || option.hint,
    })),
    nutrition_measurement_profile_schemas: contract.nutrition_measurement_profile_schemas.map((profile) => ({
      ...profile,
      name: sanitizeNutritionLegalText(profile.name) || profile.name,
      description: sanitizeNutritionLegalText(profile.description) || profile.description,
      groups: (profile.groups || []).map((group) => ({
        ...group,
        label: sanitizeNutritionLegalText(group.label) || group.label,
      })),
    })),
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
    protocol_rules: MEDICAL_AREA_PROTOCOL_RULES[normalized] || [],
    patient_workspace: PATIENT_WORKSPACES[normalized] || PATIENT_WORKSPACES[FALLBACK_CODE],
    appointment_action: APPOINTMENT_ACTIONS[normalized] || APPOINTMENT_ACTIONS[FALLBACK_CODE],
    nutrition_service_kind_options: normalized === 'nutricion' ? NUTRITION_SERVICE_KIND_OPTIONS : [],
    nutrition_measurement_profile_options: normalized === 'nutricion' ? NUTRITION_MEASUREMENT_PROFILE_OPTIONS : [],
    nutrition_measurement_profile_schemas: normalized === 'nutricion' ? NUTRITION_MEASUREMENT_PROFILE_SCHEMAS : [],
    nutrition_measurement_fields: normalized === 'nutricion' ? NUTRITION_MEASUREMENT_FIELD_DEFINITIONS : {},
  };
}

function normalizeContractPayload(code, payload = {}) {
  const base = getBaseContractForArea(code);
  const source = payload?.contract && typeof payload.contract === 'object' ? payload.contract : payload;
  const normalizedCode = normalizeCode(source?.code || code);
  const normalizedBase = normalizedCode === base.code ? base : getBaseContractForArea(normalizedCode);
  const contract = {
    code: normalizedCode,
    profile: normalizeProfile(source?.profile, normalizedBase.profile),
    service_examples: normalizeServiceExamples(normalizedCode, source?.service_examples, normalizedBase.service_examples),
    contract_sections: normalizeContractSections(source?.contract_sections, normalizedBase.contract_sections),
    setup_steps: normalizeSetupSteps(source?.setup_steps, normalizedBase.setup_steps),
    protocol_rules: normalizeProtocolRules(source?.protocol_rules, normalizedBase.protocol_rules),
    patient_workspace: normalizePatientWorkspace(source?.patient_workspace, normalizedBase.patient_workspace),
    appointment_action: normalizeAppointmentAction(source?.appointment_action, normalizedBase.appointment_action),
    nutrition_service_kind_options: normalizedCode === 'nutricion'
      ? normalizeNutritionServiceKindOptions(source?.nutrition_service_kind_options, normalizedBase.nutrition_service_kind_options)
      : [],
    nutrition_measurement_profile_options: normalizedCode === 'nutricion'
      ? normalizeNutritionMeasurementProfileOptions(source?.nutrition_measurement_profile_options, normalizedBase.nutrition_measurement_profile_options)
      : [],
    nutrition_measurement_fields: normalizedCode === 'nutricion'
      ? normalizeNutritionMeasurementFields(source?.nutrition_measurement_fields, normalizedBase.nutrition_measurement_fields)
      : {},
    nutrition_measurement_profile_schemas: normalizedCode === 'nutricion'
      ? normalizeNutritionMeasurementProfileSchemas(
        source?.nutrition_measurement_profile_schemas,
        normalizedBase.nutrition_measurement_profile_schemas,
        normalizedBase.nutrition_measurement_fields,
      )
      : [],
  };

  return normalizeNutritionContractDefaults(contract, normalizedBase);
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
  NUTRITION_MEASUREMENT_FIELD_DEFINITIONS,
  NUTRITION_MEASUREMENT_PROFILE_SCHEMAS,
  getBaseContractForArea,
  getContractForArea,
  getMedicalAreaContracts,
  normalizeContractPayload,
  upsertMedicalAreaContract,
};
