'use strict';

const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const db = require('../../models');
const medicalAreaContracts = require('./medicalAreaContracts.service');
const clinicalPrivateStorage = require('./clinicalPrivateStorage.service');

const { Op } = db.Sequelize;
const execFileAsync = promisify(execFile);
const FORMULA_VERSION = 'nutrition-basic-v3';
const NUTRITION_REPORT_SNAPSHOT_VERSION = 11;
const NUTRITION_REPORT_CURRENT_STATUSES = ['final', 'active'];
const NUTRITION_REPORT_BRANDING_MODES = new Set(['clinicaclick', 'clinic']);
const DEFAULT_CHROMIUM_PATH = '/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell';
const NUTRITION_ASSET_DIR = path.join(__dirname, '..', 'assets', 'nutrition');
const NUTRITION_BRAND_ASSET_DIR = path.join(NUTRITION_ASSET_DIR, 'brand');
const NUTRITION_SOMATOTYPE_ASSET_DIR = path.join(NUTRITION_ASSET_DIR, 'somatotypes');
const nutritionReportImageCache = new Map();

const FORMULA_REFERENCES = [
  {
    key: 'bmi',
    label: 'IMC',
    description: 'Peso en kg dividido por la estatura en metros al cuadrado.',
    source: 'NHS BMI adult calculation',
    url: 'https://www.nhs.uk/health-assessment-tools/calculate-your-body-mass-index/calculate-bmi-for-adults/',
    profiles: ['quick', 'express_isak'],
  },
  {
    key: 'isak_restricted_profile',
    label: 'Perfil antropométrico completo',
    description: 'Estructura de medición antropométrica restringida: medidas base, pliegues, perímetros y diámetros.',
    source: 'Australian Institute of Sport anthropometry resources',
    url: 'https://www.ausport.gov.au/ais/performance-support/anthropometry',
    profiles: ['express_isak'],
  },
  {
    key: 'waist_hip_ratio',
    label: 'Ratio cintura/cadera',
    description: 'Relación entre perímetro de cintura y perímetro de cadera como indicador antropométrico.',
    source: 'WHO waist circumference and waist-hip ratio report',
    url: 'https://www.who.int/publications/i/item/9789241501491',
    profiles: ['quick', 'express_isak'],
  },
  {
    key: 'heath_carter_somatotype',
    label: 'Somatotipo Heath-Carter',
    description: 'Cálculo de endomorfia, mesomorfia y ectomorfia a partir de medidas antropométricas.',
    source: 'The Heath-Carter Anthropometric Somatotype Instruction Manual',
    url: 'https://phentermineclinics.net/wp-content/uploads/2023/09/Heath-CarterManual.pdf',
    profiles: ['express_isak'],
  },
  {
    key: 'durnin_womersley_body_density',
    label: 'Densidad corporal Durnin-Womersley',
    description: 'Estimación de densidad corporal por sexo y edad usando la suma de bíceps, tríceps, subescapular e ilíaco/suprailiaco.',
    source: 'Durnin & Womersley 1974',
    url: 'https://pubmed.ncbi.nlm.nih.gov/4843734/',
    profiles: ['express_isak'],
    fat_mass_equation: true,
  },
  {
    key: 'siri_body_fat',
    label: 'Porcentaje graso Siri',
    description: 'Conversión de densidad corporal a porcentaje estimado de grasa corporal.',
    source: 'Siri body density conversion',
    url: 'https://www.ncbi.nlm.nih.gov/books/NBK235961/',
    profiles: ['express_isak'],
    fat_mass_equation: true,
  },
  {
    key: 'faulkner_body_fat',
    label: 'Porcentaje graso Faulkner',
    description: 'Estimación directa de porcentaje graso con cuatro pliegues: tríceps, subescapular, suprailiaco/supraespinal y abdominal.',
    source: 'Faulkner 1966 / Yuhasz modificado',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9467702/',
    profiles: [],
    fat_mass_equation: true,
  },
  {
    key: 'jackson_pollock_body_fat',
    label: 'Jackson-Pollock 4 sitios',
    description: 'Estimación de porcentaje graso con abdominal, tríceps, muslo anterior, suprailiaco y edad.',
    source: 'Jackson-Pollock skinfold equations',
    url: 'https://www.measurement-toolkit.org/anthropometry/objective-methods/simple-measures-skinfolds',
    profiles: [],
    fat_mass_equation: true,
  },
  {
    key: 'katch_mcardle_body_density',
    label: 'Densidad corporal Katch-McArdle',
    description: 'Estimación de densidad corporal con fórmulas específicas por sexo para población universitaria joven.',
    source: 'Katch & McArdle 1973',
    url: 'https://digitalcommons.wayne.edu/humbiol/vol45/iss3/12/',
    profiles: [],
    fat_mass_equation: true,
  },
  {
    key: 'sloan_body_density',
    label: 'Densidad corporal Sloan',
    description: 'Estimación de densidad corporal con dos pliegues y fórmula específica por sexo.',
    source: 'Sloan 1962/1967',
    url: 'https://www.topendsports.com/testing/density-sloan.htm',
    profiles: [],
    fat_mass_equation: true,
  },
  {
    key: 'withers_body_density',
    label: 'Densidad corporal Withers',
    description: 'Estimación de densidad corporal en población deportiva con sumas de pliegues antropométricos.',
    source: 'Withers et al. 1987',
    url: 'https://pubmed.ncbi.nlm.nih.gov/3569225/',
    profiles: [],
    fat_mass_equation: true,
  },
  {
    key: 'yuhasz_carter_body_fat',
    label: 'Porcentaje graso Yuhasz-Carter',
    description: 'Estimación directa de porcentaje graso con seis pliegues usados en evaluación deportiva.',
    source: 'Yuhasz modificado por Carter',
    url: 'https://www.anthrometrix.com/pages/yuhasz-formula-for-body-fat-percentage',
    profiles: [],
    fat_mass_equation: true,
  },
  {
    key: 'slaughter_body_fat',
    label: 'Porcentaje graso Slaughter',
    description: 'Estimación directa de porcentaje graso con tríceps y subescapular; referencia clásica en población juvenil.',
    source: 'Slaughter et al. 1988',
    url: 'https://search.r-project.org/CRAN/refmans/bodycomp/html/Slaughter.2sites.Matur.html',
    profiles: [],
    fat_mass_equation: true,
  },
  {
    key: 'kerr_ross_five_component_fractionation',
    label: 'Fraccionamiento Kerr-Ross 5 componentes',
    description: 'Estimación antropométrica de piel, tejido adiposo, masa muscular, masa ósea y masa residual mediante táctica Phantom.',
    source: 'Kerr 1988, Simon Fraser University',
    url: 'https://summit.sfu.ca/item/5139',
    profiles: ['express_isak'],
  },
  {
    key: 'linear_projection',
    label: 'Proyección temporal',
    description: 'Estimación lineal simple basada en las dos últimas mediciones comparables con fechas distintas.',
    source: 'Cálculo interno ClinicaClick',
    url: null,
    profiles: ['quick', 'express_isak'],
  },
];

const FORMULA_REFERENCES_BY_KEY = new Map(FORMULA_REFERENCES.map((reference) => [reference.key, reference]));
const FAT_MASS_EQUATION_OPTIONS = [
  {
    code: 'durnin_womersley_siri',
    label: 'Durnin-Womersley + Siri',
    status: 'active',
    source_reference_keys: ['durnin_womersley_body_density', 'siri_body_fat'],
  },
  {
    code: 'faulkner_1966',
    label: 'Faulkner (1966)',
    status: 'available',
    source_reference_keys: ['faulkner_body_fat'],
  },
  {
    code: 'jackson_pollock_1975',
    label: 'Jackson y Pollock (1975)',
    status: 'available',
    source_reference_keys: ['jackson_pollock_body_fat'],
  },
  {
    code: 'katch_mcardle_1973',
    label: 'Katch-McArdle (1973)',
    status: 'available',
    source_reference_keys: ['katch_mcardle_body_density', 'siri_body_fat'],
  },
  {
    code: 'sloan_1962',
    label: 'Sloan (1962)',
    status: 'available',
    source_reference_keys: ['sloan_body_density', 'siri_body_fat'],
  },
  {
    code: 'withers_1987',
    label: 'Withers (1987)',
    status: 'available',
    source_reference_keys: ['withers_body_density', 'siri_body_fat'],
  },
  {
    code: 'yuhasz_carter_1982',
    label: 'Yuhasz modificado por Carter (1982)',
    status: 'available',
    source_reference_keys: ['yuhasz_carter_body_fat'],
  },
  {
    code: 'slaughter_1988',
    label: 'Slaughter (1988)',
    status: 'available',
    source_reference_keys: ['slaughter_body_fat'],
  },
];
const CALCULATION_PROFILE = {
  code: 'clinicaclick-anthropometry-v3',
  label: 'Perfil ClinicaClick Antropometría v3',
  description: 'Perfil de cálculo aplicado por bloques: seguimiento express, antropometría completa, composición corporal y proyección.',
  strategy: 'calculation_blocks',
  fat_mass_model: {
    code: 'durnin_womersley_siri',
    label: 'Durnin-Womersley + Siri',
    role: 'Masa grasa estimada',
    source_reference_keys: ['durnin_womersley_body_density', 'siri_body_fat'],
  },
  fat_mass_equations: FAT_MASS_EQUATION_OPTIONS,
  automatic_models: [
    {
      code: 'heath_carter_somatotype',
      label: 'Somatotipo Heath-Carter',
      role: 'Somatotipo',
      source_reference_keys: ['heath_carter_somatotype'],
    },
    {
      code: 'kerr_ross_five_component_fractionation',
      label: 'Kerr-Ross 5 componentes',
      role: 'Fraccionamiento por componentes',
      source_reference_keys: ['kerr_ross_five_component_fractionation'],
    },
    {
      code: 'linear_projection',
      label: 'Proyección lineal simple',
      role: 'Evolución temporal',
      source_reference_keys: ['linear_projection'],
    },
  ],
};
const DEFAULT_FAT_MASS_EQUATION_CODE = 'durnin_womersley_siri';
const FAT_MASS_EQUATION_OPTIONS_BY_CODE = new Map(FAT_MASS_EQUATION_OPTIONS.map((item) => [item.code, item]));

function fatMassEquationOption(code = DEFAULT_FAT_MASS_EQUATION_CODE) {
  return FAT_MASS_EQUATION_OPTIONS_BY_CODE.get(code) || FAT_MASS_EQUATION_OPTIONS_BY_CODE.get(DEFAULT_FAT_MASS_EQUATION_CODE);
}

function normalizeFatMassEquationCode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return FAT_MASS_EQUATION_OPTIONS_BY_CODE.has(normalized) ? normalized : DEFAULT_FAT_MASS_EQUATION_CODE;
}

function calculationProfileForFatMassEquation(code = DEFAULT_FAT_MASS_EQUATION_CODE) {
  const equation = fatMassEquationOption(normalizeFatMassEquationCode(code));
  const fatMassModel = {
    code: equation.code,
    label: equation.label,
    role: 'Masa grasa estimada',
    source_reference_keys: equation.source_reference_keys || [],
  };
  return {
    ...CALCULATION_PROFILE,
    fat_mass_model: fatMassModel,
    fat_mass_equations: FAT_MASS_EQUATION_OPTIONS.map((item) => ({
      ...item,
      status: item.code === equation.code ? 'active' : 'available',
    })),
  };
}

function selectedFatMassEquationCodeFromOptions(options = {}) {
  return normalizeFatMassEquationCode(options.fatMassEquationCode || options.fat_mass_equation);
}

const PROFILE_DEFINITIONS = medicalAreaContracts.NUTRITION_MEASUREMENT_PROFILE_SCHEMAS;
const FIELD_DEFINITIONS = medicalAreaContracts.NUTRITION_MEASUREMENT_FIELD_DEFINITIONS;

function buildClinicalStoragePolicy({
  storageStrategy = null,
  status = null,
  snapshotPersisted = true,
  primary = null,
  pdfPersisted = false,
  pdfAssetId = null,
  privateBinaryStorage = null,
} = {}) {
  const normalizedStrategy = String(storageStrategy || '').trim() || (
    snapshotPersisted
      ? 'json_snapshot_printable_on_demand'
      : 'calculated_report_not_persisted'
  );
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const isFinal = normalizedStatus === 'final' || normalizedStrategy.startsWith('final_');
  const documentStatus = isFinal ? 'final' : 'draft';
  const resolvedPrimary = primary || (snapshotPersisted ? 'database_snapshot' : 'calculated_report');
  const label = snapshotPersisted
    ? (isFinal ? 'Informe clínico cerrado' : 'Informe clínico privado')
    : 'Informe generado bajo demanda';
  const detail = snapshotPersisted
    ? `Documento clínico guardado en base de datos privada. PDF ${pdfPersisted ? 'guardado como archivo clínico privado' : 'generado bajo demanda'}.`
    : 'Informe calculado en backend y PDF generado bajo demanda.';

  return {
    sensitivity: 'clinical_private',
    primary: resolvedPrimary,
    snapshot_persisted: Boolean(snapshotPersisted),
    pdf_strategy: pdfPersisted ? 'private_asset_cached' : 'generated_on_demand',
    pdf_persisted: Boolean(pdfPersisted),
    pdf_asset_id: pdfAssetId || null,
    public_media: false,
    public_media_allowed: false,
    private_binary_storage: privateBinaryStorage || (pdfPersisted ? 'clinical_private_asset' : 'pending'),
    storage_strategy: normalizedStrategy,
    document_status: documentStatus,
    label,
    detail,
  };
}

const REPORT_METRIC_DEFINITIONS = [
  { key: 'weight_kg', label: 'Peso', unit: 'kg', source: 'raw_values', decimals: 1, section: 'base' },
  { key: 'stature_cm', label: 'Estatura', unit: 'cm', source: 'raw_values', decimals: 1, section: 'base' },
  { key: 'arm_span_cm', label: 'Envergadura', unit: 'cm', source: 'raw_values', decimals: 1, section: 'base' },
  { key: 'bmi', label: 'IMC', unit: '', source: 'calculated_values', decimals: 1, section: 'base' },
  { key: 'waist_cm', label: 'Cintura', unit: 'cm', source: 'raw_values', decimals: 1, section: 'base' },
  { key: 'hip_cm', label: 'Cadera', unit: 'cm', source: 'raw_values', decimals: 1, section: 'base' },
  { key: 'waist_hip_ratio', label: 'Ratio cintura/cadera', unit: '', source: 'calculated_values', decimals: 2, section: 'base' },
  { key: 'skinfold_triceps_mm', label: 'Pliegue tríceps', unit: 'mm', source: 'raw_values', decimals: 1, section: 'skinfolds' },
  { key: 'skinfold_subscapular_mm', label: 'Pliegue subescapular', unit: 'mm', source: 'raw_values', decimals: 1, section: 'skinfolds' },
  { key: 'skinfold_biceps_mm', label: 'Pliegue bíceps', unit: 'mm', source: 'raw_values', decimals: 1, section: 'skinfolds' },
  { key: 'skinfold_iliac_crest_mm', label: 'Pliegue cresta ilíaca', unit: 'mm', source: 'raw_values', decimals: 1, section: 'skinfolds' },
  { key: 'skinfold_supraspinale_mm', label: 'Pliegue supraespinal', unit: 'mm', source: 'raw_values', decimals: 1, section: 'skinfolds' },
  { key: 'skinfold_abdominal_mm', label: 'Pliegue abdominal', unit: 'mm', source: 'raw_values', decimals: 1, section: 'skinfolds' },
  { key: 'skinfold_front_thigh_mm', label: 'Pliegue muslo frontal', unit: 'mm', source: 'raw_values', decimals: 1, section: 'skinfolds' },
  { key: 'skinfold_medial_calf_mm', label: 'Pliegue pantorrilla medial', unit: 'mm', source: 'raw_values', decimals: 1, section: 'skinfolds' },
  { key: 'skinfold_sum_mm', label: 'Suma de pliegues', unit: 'mm', source: 'calculated_values', decimals: 1, section: 'anthropometry' },
  { key: 'arm_relaxed_cm', label: 'Brazo relajado', unit: 'cm', source: 'raw_values', decimals: 1, section: 'girths' },
  { key: 'arm_flexed_tensed_cm', label: 'Brazo flexionado', unit: 'cm', source: 'raw_values', decimals: 1, section: 'girths' },
  { key: 'forearm_cm', label: 'Antebrazo', unit: 'cm', source: 'raw_values', decimals: 1, section: 'girths' },
  { key: 'chest_cm', label: 'Tórax', unit: 'cm', source: 'raw_values', decimals: 1, section: 'girths' },
  { key: 'thigh_cm', label: 'Muslo', unit: 'cm', source: 'raw_values', decimals: 1, section: 'girths' },
  { key: 'calf_cm', label: 'Pantorrilla', unit: 'cm', source: 'raw_values', decimals: 1, section: 'girths' },
  { key: 'corrected_arm_girth_cm', label: 'Brazo corregido', unit: 'cm', source: 'calculated_values', decimals: 1, section: 'anthropometry' },
  { key: 'corrected_calf_girth_cm', label: 'Pantorrilla corregida', unit: 'cm', source: 'calculated_values', decimals: 1, section: 'anthropometry' },
  { key: 'breadth_humerus_cm', label: 'Diámetro húmero', unit: 'cm', source: 'raw_values', decimals: 1, section: 'breadths' },
  { key: 'breadth_wrist_bistyloid_cm', label: 'Diámetro biestiloideo', unit: 'cm', source: 'raw_values', decimals: 1, section: 'breadths' },
  { key: 'breadth_femur_cm', label: 'Diámetro fémur', unit: 'cm', source: 'raw_values', decimals: 1, section: 'breadths' },
  { key: 'breadth_biacromial_cm', label: 'Diámetro biacromial', unit: 'cm', source: 'raw_values', decimals: 1, section: 'breadths' },
  { key: 'breadth_biiliocristal_cm', label: 'Diámetro biiliocrestal', unit: 'cm', source: 'raw_values', decimals: 1, section: 'breadths' },
  { key: 'depth_chest_ap_cm', label: 'Diámetro tórax AP', unit: 'cm', source: 'raw_values', decimals: 1, section: 'breadths' },
  { key: 'breadth_chest_transverse_cm', label: 'Diámetro tórax transverso', unit: 'cm', source: 'raw_values', decimals: 1, section: 'breadths' },
  { key: 'body_fat_percent', label: 'Grasa estimada', unit: '%', source: 'body_composition', decimals: 1, section: 'body_composition' },
  { key: 'fat_mass_kg', label: 'Masa grasa estimada', unit: 'kg', source: 'body_composition', decimals: 1, section: 'body_composition' },
  { key: 'fat_free_mass_kg', label: 'Masa libre de grasa', unit: 'kg', source: 'body_composition', decimals: 1, section: 'body_composition' },
  { key: 'body_density', label: 'Densidad corporal', unit: 'g/ml', source: 'body_composition', decimals: 4, section: 'body_composition' },
  { key: 'adipose_mass_kg', label: 'Masa adiposa Kerr', unit: 'kg', source: 'body_fractionation', decimals: 1, section: 'five_component' },
  { key: 'muscle_mass_kg', label: 'Masa muscular Kerr', unit: 'kg', source: 'body_fractionation', decimals: 1, section: 'five_component' },
  { key: 'bone_mass_kg', label: 'Masa ósea Kerr', unit: 'kg', source: 'body_fractionation', decimals: 1, section: 'five_component' },
  { key: 'skin_mass_kg', label: 'Masa piel Kerr', unit: 'kg', source: 'body_fractionation', decimals: 1, section: 'five_component' },
  { key: 'residual_mass_kg', label: 'Masa residual Kerr', unit: 'kg', source: 'body_fractionation', decimals: 1, section: 'five_component' },
  { key: 'prediction_error_percent', label: 'Error predicción Kerr', unit: '%', source: 'body_fractionation', decimals: 1, section: 'five_component' },
  { key: 'endomorphy', label: 'Endomorfia', unit: '', source: 'somatotype', decimals: 1, section: 'somatotype' },
  { key: 'mesomorphy', label: 'Mesomorfia', unit: '', source: 'somatotype', decimals: 1, section: 'somatotype' },
  { key: 'ectomorphy', label: 'Ectomorfia', unit: '', source: 'somatotype', decimals: 1, section: 'somatotype' },
];

const PROJECTION_METRIC_DEFINITIONS = [
  {
    key: 'weight_kg',
    label: 'Peso',
    unit: 'kg',
    source: 'raw_values',
    decimals: 1,
    per_week_key: 'weight_change_per_week_kg',
    projected_key: 'projected_8_week_weight_kg',
  },
  {
    key: 'waist_cm',
    label: 'Cintura',
    unit: 'cm',
    source: 'raw_values',
    decimals: 1,
    per_week_key: 'waist_change_per_week_cm',
    projected_key: 'projected_8_week_waist_cm',
  },
  {
    key: 'skinfold_sum_mm',
    label: 'Suma de pliegues',
    unit: 'mm',
    source: 'calculated_values',
    decimals: 1,
    per_week_key: 'skinfold_sum_change_per_week_mm',
    projected_key: 'projected_8_week_skinfold_sum_mm',
  },
  {
    key: 'body_fat_percent',
    label: 'Grasa estimada',
    unit: '%',
    source: 'body_composition',
    decimals: 1,
    per_week_key: 'body_fat_change_per_week_percent',
    projected_key: 'projected_8_week_body_fat_percent',
  },
  {
    key: 'adipose_mass_kg',
    label: 'Masa adiposa Kerr',
    unit: 'kg',
    source: 'body_fractionation',
    decimals: 1,
    per_week_key: 'adipose_mass_change_per_week_kg',
    projected_key: 'projected_8_week_adipose_mass_kg',
  },
  {
    key: 'muscle_mass_kg',
    label: 'Masa muscular Kerr',
    unit: 'kg',
    source: 'body_fractionation',
    decimals: 1,
    per_week_key: 'muscle_mass_change_per_week_kg',
    projected_key: 'projected_8_week_muscle_mass_kg',
  },
];

const REPORT_SECTION_DEFINITIONS = {
  base: 'Datos principales',
  skinfolds: 'Pliegues',
  girths: 'Perímetros',
  breadths: 'Diámetros',
  anthropometry: 'Antropometría',
  body_composition: 'Composición corporal',
  five_component: 'Cinco componentes Kerr-Ross',
  somatotype: 'Somatotipo Heath-Carter',
};

const DURNIN_WOMERSLEY_COEFFICIENTS = {
  male: [
    { maxAge: 16, c: 1.1533, m: 0.0643, label: '<17' },
    { maxAge: 19, c: 1.1620, m: 0.0630, label: '17-19' },
    { maxAge: 29, c: 1.1631, m: 0.0632, label: '20-29' },
    { maxAge: 39, c: 1.1422, m: 0.0544, label: '30-39' },
    { maxAge: 49, c: 1.1620, m: 0.0700, label: '40-49' },
    { maxAge: Infinity, c: 1.1715, m: 0.0779, label: '50+' },
  ],
  female: [
    { maxAge: 16, c: 1.1369, m: 0.0598, label: '<17' },
    { maxAge: 19, c: 1.1549, m: 0.0678, label: '17-19' },
    { maxAge: 29, c: 1.1599, m: 0.0717, label: '20-29' },
    { maxAge: 39, c: 1.1423, m: 0.0632, label: '30-39' },
    { maxAge: 49, c: 1.1333, m: 0.0612, label: '40-49' },
    { maxAge: Infinity, c: 1.1339, m: 0.0645, label: '50+' },
  ],
};

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeReportBrandingOptions(options = {}) {
  const rawMode = String(options?.brandingMode || options?.report_branding_mode || '').trim().toLowerCase();
  const mode = NUTRITION_REPORT_BRANDING_MODES.has(rawMode) ? rawMode : 'clinicaclick';
  return { mode };
}

function isDefaultReportBranding(options = {}) {
  return normalizeReportBrandingOptions(options).mode === 'clinicaclick';
}

function initialsFromName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  return initials || 'CC';
}

function displayNutritionText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .replace(/Informe (?:de )?antropometr[ií]a ISAK/gi, 'Informe de antropometría completa')
    .replace(/Informe antropom[eé]trico ISAK/gi, 'Informe de antropometría completa')
    .replace(/Estudio antropom[eé]trico ISAK/gi, 'Estudio antropométrico completo')
    .replace(/Antropometr[ií]a ISAK/gi, 'Antropometría avanzada')
    .replace(/Estudio ISAK/gi, 'Estudio antropométrico completo')
    .replace(/Express\/ISAK/gi, 'Completa')
    .replace(/express\/ISAK/gi, 'Completa')
    .replace(/\bisak\b/gi, 'antropometría');
}

function hashSnapshot(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload || {}))
    .digest('hex');
}

function isMissingReportTableError(error) {
  const message = String(error?.message || '');
  const code = String(error?.original?.code || error?.parent?.code || error?.code || '');
  return code === 'ER_NO_SUCH_TABLE'
    || code === '42P01'
    || /PatientNutritionReports/i.test(message) && /doesn't exist|does not exist|no such table/i.test(message);
}

async function generateUniqueNutritionReportPublicId() {
  const model = db.PatientNutritionReport;
  if (!model) return `nrep_${crypto.randomBytes(10).toString('hex')}`;
  for (let i = 0; i < 5; i += 1) {
    const publicId = `nrep_${crypto.randomBytes(10).toString('hex')}`;
    const existing = await model.findOne({ where: { public_id: publicId }, attributes: ['id'] });
    if (!existing) return publicId;
  }
  return `nrep_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function formatDate(value, withTime = true) {
  if (!value) return 'No indicado';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'No indicado';
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

function formatMetricValue(metric = {}) {
  const value = metric.value;
  if (value === null || value === undefined || value === '') return '-';
  return `${value}${metric.unit ? ` ${metric.unit}` : ''}`;
}

function formatDelta(metric = {}) {
  const delta = metric.delta;
  if (delta === null || delta === undefined) return '-';
  const sign = Number(delta) > 0 ? '+' : '';
  return `${sign}${delta}${metric.unit ? ` ${metric.unit}` : ''}`;
}

function formatDeltaWithPercent(metric = {}) {
  const delta = finiteNumber(metric.delta);
  if (delta === null) return '-';
  const previous = finiteNumber(metric.previous_value);
  const sign = delta > 0 ? '+' : '';
  const percent = previous !== null && previous !== 0
    ? ` (${sign}${round((delta / previous) * 100, 1)}%)`
    : '';
  return `${sign}${delta}${metric.unit ? ` ${metric.unit}` : ''}${percent}`;
}

function metricTrendClass(metric = {}) {
  if (metric.delta === null || metric.delta === undefined) return '';
  const decreasePreferred = ['weight_kg', 'bmi', 'waist_cm', 'skinfold_sum_mm', 'body_fat_percent', 'fat_mass_kg', 'adipose_mass_kg'];
  const delta = finiteNumber(metric.delta);
  if (delta === null || Math.abs(delta) < 0.0001) return 'delta-stable';
  const key = String(metric.key || '');
  const improved = decreasePreferred.includes(key) || key.startsWith('skinfold_') ? delta < 0 : delta > 0;
  return improved ? 'delta-good' : 'delta-bad';
}

function formatProjectionMetricLabel(metric = {}) {
  const label = String(metric.label || 'Métrica').trim();
  return /estimad[ao]$/i.test(label)
    ? `${label} 8 semanas`
    : `${label} estimada 8 semanas`;
}

function nutritionProfileLabel(profileCode, { sentenceCase = false } = {}) {
  if (profileCode === 'express_isak') return sentenceCase ? 'Completa' : 'Completa';
  if (profileCode === 'quick') return sentenceCase ? 'Express' : 'Express';
  return sentenceCase ? 'Sin medición' : 'Sin medición';
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildMetricSparklineSvg(metric, color = '#2563eb') {
  const points = [
    { label: 'Anterior', value: finiteNumber(metric.previous_value), x: 26, projection: false },
    { label: 'Actual', value: finiteNumber(metric.current_value), x: 130, projection: false },
    { label: '8 sem.', value: finiteNumber(metric.projected_8_week_value), x: 234, projection: true },
  ].filter((point) => point.value !== null);

  if (points.length < 2) return '';

  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || Math.max(Math.abs(max), 1);
  const chartTop = 18;
  const chartBottom = 82;
  const yForValue = (value) => chartBottom - (((value - min) / range) * (chartBottom - chartTop));
  const svgPoints = points.map((point) => ({
    ...point,
    y: yForValue(point.value),
  }));
  const actualPoints = svgPoints.filter((point) => !point.projection);
  const projectedPoint = svgPoints.find((point) => point.projection);
  const projectionAnchor = actualPoints[actualPoints.length - 1];
  const actualPolyline = actualPoints.length > 1
    ? actualPoints.map((point) => `${round(point.x, 1)},${round(point.y, 1)}`).join(' ')
    : '';
  const projectionPolyline = projectionAnchor && projectedPoint
    ? [projectionAnchor, projectedPoint].map((point) => `${round(point.x, 1)},${round(point.y, 1)}`).join(' ')
    : '';

  return `
    <svg class="sparkline" viewBox="0 0 260 112" role="img" aria-label="${escapeHtml(metric.label || 'Métrica')}">
      <line x1="20" y1="${chartBottom}" x2="240" y2="${chartBottom}" class="chart-axis" />
      ${actualPolyline ? `<polyline points="${escapeHtml(actualPolyline)}" fill="none" stroke="${escapeHtml(color)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />` : ''}
      ${projectionPolyline ? `<polyline points="${escapeHtml(projectionPolyline)}" fill="none" stroke="${escapeHtml(color)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="5 5" />` : ''}
      ${svgPoints.map((point) => `
        <circle cx="${round(point.x, 1)}" cy="${round(point.y, 1)}" r="4.5" fill="${point.projection ? '#fff' : escapeHtml(color)}" stroke="${escapeHtml(color)}" stroke-width="${point.projection ? '2' : '0'}" />
        <text x="${round(point.x, 1)}" y="101" text-anchor="middle" class="chart-label">${escapeHtml(point.label)}</text>
        <text x="${round(point.x, 1)}" y="${Math.max(11, round(point.y - 9, 1))}" text-anchor="middle" class="chart-value">${escapeHtml(formatMetricValue({ value: point.value, unit: metric.unit }))}</text>
      `).join('')}
    </svg>
  `;
}

function buildProjectionVisualHtml(projection) {
  const metrics = (projection?.metric_projections || [])
    .filter((metric) => ['weight_kg', 'waist_cm', 'skinfold_sum_mm', 'body_fat_percent'].includes(metric.key))
    .slice(0, 4);

  if (!projection?.available || !metrics.length) return '';

  const colors = ['#0f766e', '#2563eb', '#7c3aed', '#e11d48'];
  return `
    <section class="card">
      ${sectionVisualHeaderHtml({
        kicker: 'Evolución',
        title: 'Gráficas de evolución',
        body: 'Anterior, actual y proyección lineal a 8 semanas por métrica comparable.',
        imageFilename: 'images/nutrition-progress-evolution.webp',
        imageAlt: 'Evolución visual de medidas',
      })}
      <div class="sparkline-grid">
        ${metrics.map((metric, index) => `
          <div class="sparkline-card">
            <div class="sparkline-title">${escapeHtml(metric.label || metric.key)}</div>
            ${buildMetricSparklineSvg(metric, colors[index % colors.length])}
            <div class="sparkline-caption">Ritmo ${escapeHtml(formatDelta({ delta: metric.change_per_week, unit: metric.unit ? `${metric.unit}/sem` : '/sem' }))}</div>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function buildReportVisualIntroHtml(measurement = {}) {
  const patientImage = reportAssetImageHtml('images/nutrition-report-patient-friendly.webp', 'Profesional explicando el informe al paciente', 'report-intro-img');
  const profileLabel = nutritionProfileLabel(measurement.profile_code);
  if (!patientImage) return '';
  return `
    <section class="card report-visual-intro report-visual-intro-with-image">
      <figure class="report-intro-main">
        ${patientImage}
      </figure>
      <div class="report-intro-content">
        <div class="section-kicker">Guía de lectura</div>
        <div class="report-intro-title">
          <h2>Cómo leer el informe</h2>
          <span>${escapeHtml(profileLabel)}</span>
        </div>
        <p class="muted small-note">Primero mira los cuatro indicadores principales; después revisa evolución, composición y distribución. Las ilustraciones ayudan a ubicar qué significa cada bloque, pero los valores clínicos son los números y barras.</p>
        <ul class="report-reading-list">
          <li><strong>Actual</strong><span>Medición seleccionada en esta visita.</span></li>
          <li><strong>Comparación</strong><span>Medición elegida para ver cambios.</span></li>
          <li><strong>Proyección</strong><span>Estimación lineal, no diagnóstico.</span></li>
        </ul>
      </div>
    </section>
  `;
}

function reportAssetImageHtml(filename, alt, className = '') {
  const src = nutritionAssetDataUri(filename);
  if (!src) return '';
  return `<img${className ? ` class="${escapeHtml(className)}"` : ''} src="${src}" alt="${escapeHtml(alt)}">`;
}

function sectionVisualHeaderHtml({
  kicker = '',
  title = '',
  body = '',
  imageFilename = '',
  imageAlt = '',
  titleTag = 'h2',
} = {}) {
  const image = imageFilename
    ? reportAssetImageHtml(imageFilename, imageAlt || title, 'section-story-img')
    : '';
  const safeTitleTag = titleTag === 'h3' ? 'h3' : 'h2';
  return `
    <div class="section-story-header ${image ? 'section-story-header-with-image' : ''}">
      ${image ? `
        <figure class="section-story-figure">
          ${image}
        </figure>
      ` : ''}
      <div class="section-story-copy">
        ${kicker ? `<div class="section-kicker">${escapeHtml(kicker)}</div>` : ''}
        <${safeTitleTag}>${escapeHtml(title)}</${safeTitleTag}>
        ${body ? `<p class="muted small-note">${escapeHtml(body)}</p>` : ''}
      </div>
    </div>
  `;
}

function componentExplainGridHtml(explainItems = [], barItems = []) {
  if (!explainItems.length) return '';
  const normalizedBarItems = barItems
    .map((item) => ({ ...item, value: finiteNumber(item.value) }))
    .filter((item) => item.value !== null && item.value > 0);
  const max = Math.max(...normalizedBarItems.map((item) => item.value), 1);
  const barItemsByLabel = new Map(normalizedBarItems.map((item) => [item.label, item]));
  return `
    <div class="component-explain-grid">
      ${explainItems.map((item) => {
        const barItem = barItemsByLabel.get(item.label);
        const width = barItem ? Math.max(4, (barItem.value / max) * 100) : 0;
        return `
          <div class="component-explain-card ${item.image ? 'component-explain-card-with-image' : ''}">
            ${item.image ? '' : `<span class="component-explain-dot" style="background:${escapeHtml(item.color)}"></span>`}
            <div class="component-explain-body">
              <strong>${escapeHtml(item.label)}</strong>
              <small>${escapeHtml(item.detail)}</small>
              ${barItem ? `
                <div class="component-inline-bar">
                  <i style="width:${escapeHtml(round(width, 1))}%;background:${escapeHtml(barItem.color || item.color)}"></i>
                  <em>${escapeHtml(formatMetricValue({ value: barItem.value, unit: barItem.unit }))}</em>
                </div>
              ` : ''}
            </div>
            ${item.image ? `
              <figure class="component-explain-figure">
                ${reportAssetImageHtml(item.image, item.label, 'component-explain-img')}
              </figure>
            ` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function compositionVisualBlockHtml(title, subtitle, segments = [], barItems = [], explainItems = [], visual = {}) {
  if (!segments.length) return '';
  return `
    <div class="composition-visual-block">
      ${sectionVisualHeaderHtml({
        kicker: 'Composición corporal',
        title,
        body: subtitle,
        imageFilename: visual?.filename || '',
        imageAlt: visual?.alt || title,
        titleTag: 'h3',
      })}
      <div class="visual-grid composition-main-grid">
        <div>${buildDonutSvg(segments, { title: 'Actual', subtitle: `${segments.length} bloques` })}</div>
        <div>
          <div class="composition-bar">
            ${segments.map((segment) => `<span style="width:${escapeHtml(round(segment.value, 1))}%;background:${escapeHtml(segment.color)}"></span>`).join('')}
          </div>
          <div class="legend-grid">
            ${segments.map((segment) => `
              <div class="legend-item">
                <span style="background:${escapeHtml(segment.color)}"></span>
                <strong>${escapeHtml(segment.label)}</strong>
                <em>${escapeHtml(round(segment.value, 1))}%</em>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
      ${componentExplainGridHtml(explainItems, barItems)}
    </div>
  `;
}

function pendingTraceHtml(report = {}, key = 'body_fractionation', title = 'Fraccionamiento tisular Kerr-Ross', detail = 'Se mostrará como gráfico de cinco componentes cuando el bloque avanzado esté completo.') {
  const trace = (report.calculation_trace || []).find((item) => item.key === key);
  const missing = trace?.missing_input_labels || [];
  return `
    <div class="composition-visual-block muted-card">
      <h3>${escapeHtml(title)}</h3>
      <p class="muted small-note">${escapeHtml(detail)}</p>
      <div class="pending-visual">
        <strong>Pendiente de datos</strong>
        <span>${escapeHtml(missing.length ? missing.slice(0, 8).join(', ') : 'Faltan entradas para este cálculo')}</span>
      </div>
    </div>
  `;
}

function buildCompositionVisualHtml(report) {
  const fractionation = report?.summary?.body_fractionation || null;
  const composition = report?.summary?.body_composition || null;
  const blocks = [];

  if (composition) {
    const fat = finiteNumber(composition.body_fat_percent);
    if (fat !== null) {
      const fatPercent = Math.max(0, Math.min(100, fat));
      const leanPercent = Math.max(0, Math.min(100, 100 - fatPercent));
      blocks.push(compositionVisualBlockHtml(
        'Fraccionamiento molecular',
        'Lectura sencilla: separa el peso en grasa y masa libre de grasa. Sirve para ver si el cambio de peso viene sobre todo de tejido graso o de masa funcional.',
        [
          { label: 'Masa grasa', value: fatPercent, color: '#f97316' },
          { label: 'Masa libre de grasa', value: leanPercent, color: '#14b8a6' },
        ],
        [
          { label: 'Masa grasa', value: composition.fat_mass_kg, unit: 'kg', color: '#f97316' },
          { label: 'Masa libre', value: composition.fat_free_mass_kg, unit: 'kg', color: '#14b8a6' },
        ],
        [
          { label: 'Masa grasa', color: '#f97316', detail: 'Reserva energética del cuerpo. No toda la grasa es mala; importa su evolución y distribución.' },
          { label: 'Masa libre', color: '#14b8a6', detail: 'Todo lo que no es grasa: músculo, hueso, agua, órganos y otros tejidos.' },
        ],
        {
          filename: 'images/nutrition-molecular-two-compartments.webp',
          alt: 'Silueta de dos compartimentos: masa grasa y masa libre de grasa',
        },
      ));
    }
  } else {
    blocks.push(pendingTraceHtml(
      report,
      'body_composition',
      'Fraccionamiento molecular',
      'Modelo de dos compartimentos: masa grasa y masa libre de grasa. Se calcula cuando sexo, edad, peso y pliegues requeridos están completos.',
    ));
  }

  if (fractionation) {
    const segments = [];
    [
      ['adipose_percent_of_body_mass', 'Adiposo', '#f97316'],
      ['muscle_percent_of_body_mass', 'Músculo', '#14b8a6'],
      ['bone_percent_of_body_mass', 'Óseo', '#6366f1'],
      ['skin_percent_of_body_mass', 'Piel', '#f43f5e'],
      ['residual_percent_of_body_mass', 'Residual', '#64748b'],
    ].forEach(([key, label, color]) => {
      const value = finiteNumber(fractionation[key]);
      if (value !== null && value > 0) segments.push({ label, value, color });
    });
    if (segments.length) {
      blocks.push(compositionVisualBlockHtml(
        'Fraccionamiento tisular',
        'Lectura sencilla: reparte el peso estimado en cinco tejidos para entender mejor de qué está compuesto el cuerpo, no solo cuánto pesa.',
        segments,
        [
          { label: 'Adiposo', value: fractionation.adipose_mass_kg, unit: 'kg', color: '#f97316' },
          { label: 'Músculo', value: fractionation.muscle_mass_kg, unit: 'kg', color: '#14b8a6' },
          { label: 'Óseo', value: fractionation.bone_mass_kg, unit: 'kg', color: '#6366f1' },
          { label: 'Piel', value: fractionation.skin_mass_kg, unit: 'kg', color: '#f43f5e' },
          { label: 'Residual', value: fractionation.residual_mass_kg, unit: 'kg', color: '#64748b' },
        ],
        [
          { label: 'Adiposo', color: '#f97316', image: 'images/nutrition-tissue-adipose.webp', detail: 'Tejido graso estimado con pliegues y perímetros.' },
          { label: 'Músculo', color: '#14b8a6', image: 'images/nutrition-tissue-muscle.webp', detail: 'Masa muscular estimada; ayuda a valorar ganancia o pérdida funcional.' },
          { label: 'Óseo', color: '#6366f1', image: 'images/nutrition-tissue-bone.webp', detail: 'Componente óseo estimado desde diámetros corporales.' },
          { label: 'Piel', color: '#f43f5e', image: 'images/nutrition-tissue-skin.webp', detail: 'Estimación del peso de la piel dentro del modelo.' },
          { label: 'Residual', color: '#64748b', image: 'images/nutrition-tissue-residual.webp', detail: 'Órganos, fluidos y otros tejidos no clasificados en los bloques anteriores.' },
        ],
        {
          filename: 'images/nutrition-fractionation-overview.webp',
          alt: 'Silueta con fraccionamiento tisular de cinco componentes',
        },
      ));
    }
  } else {
    blocks.push(pendingTraceHtml(report, 'body_fractionation'));
  }

  if (!blocks.length) return '';

  return `
    <section class="card">
      <h2>Composición y fraccionamiento corporal</h2>
      <p class="muted small-note">Esta parte traduce las medidas a bloques corporales. Es una estimación antropométrica para seguimiento clínico, no una prueba de imagen.</p>
      <div class="composition-block-grid">
        ${blocks.join('')}
      </div>
    </section>
  `;
}

function buildDonutSvg(segments = [], options = {}) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, finiteNumber(segment.value) || 0), 0);
  if (!total) return '';
  const title = options.title || 'Actual';
  const subtitle = options.subtitle !== undefined ? options.subtitle : `${segments.length} bloques`;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return `
    <svg class="donut-chart" viewBox="0 0 150 150" role="img">
      <circle cx="75" cy="75" r="${radius}" fill="none" stroke="#e2e8f0" stroke-width="26"></circle>
      ${segments.map((segment) => {
        const value = Math.max(0, finiteNumber(segment.value) || 0);
        const dash = (value / total) * circumference;
        const circle = `<circle cx="75" cy="75" r="${radius}" fill="none" stroke="${escapeHtml(segment.color)}" stroke-width="26" stroke-dasharray="${round(dash, 2)} ${round(circumference - dash, 2)}" stroke-dashoffset="${round(-offset, 2)}" transform="rotate(-90 75 75)"></circle>`;
        offset += dash;
        return circle;
      }).join('')}
      <text x="75" y="72" text-anchor="middle" class="donut-title">${escapeHtml(title)}</text>
      ${subtitle ? `<text x="75" y="91" text-anchor="middle" class="donut-subtitle">${escapeHtml(subtitle)}</text>` : ''}
    </svg>
  `;
}

function comparisonBarHtml(metric = {}) {
  const current = Math.abs(finiteNumber(metric.value) || 0);
  const previous = Math.abs(finiteNumber(metric.previous_value) || 0);
  const max = Math.max(current, previous, 1);
  const currentWidth = Math.max(4, Math.min(100, (current / max) * 100));
  const previousWidth = Math.max(4, Math.min(100, (previous / max) * 100));
  return `
    <div class="comparison-bars">
      <div><span>Actual</span><i class="${metricTrendClass(metric)}" style="width:${escapeHtml(round(currentWidth, 1))}%"></i><strong>${escapeHtml(formatMetricValue(metric))}</strong></div>
      <div><span>Previo</span><i class="previous" style="width:${escapeHtml(round(previousWidth, 1))}%"></i><strong>${escapeHtml(formatMetricValue({ value: metric.previous_value, unit: metric.unit }))}</strong></div>
    </div>
  `;
}

function comparisonSectionTitle(section) {
  const titles = {
    base: 'Medidas básicas',
    skinfolds: 'Pliegues',
    girths: 'Perímetros',
    breadths: 'Diámetros',
    anthropometry: 'Antropometría calculada',
    body_composition: 'Composición corporal',
    five_component: 'Fraccionamiento tisular',
    somatotype: 'Somatotipo',
  };
  return titles[section] || REPORT_SECTION_DEFINITIONS[section] || 'Otras métricas';
}

function buildComparisonOverviewHtml(comparison = {}) {
  const metrics = (comparison.metrics || []).filter((metric) => metric.delta !== null && metric.delta !== undefined);
  if (!comparison.available || !metrics.length) return '';
  const priority = ['base', 'skinfolds', 'girths', 'breadths', 'body_composition', 'five_component', 'anthropometry', 'somatotype'];
  const groups = new Map();
  metrics.forEach((metric) => {
    const section = metric.section || 'other';
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(metric);
  });
  const orderedSections = [
    ...priority.filter((section) => groups.has(section)),
    ...Array.from(groups.keys()).filter((section) => !priority.includes(section)),
  ];

  return `
    <section class="card comparison-overview">
      <div class="section-heading-row">
        <div>
          <h2>Comparativas principales</h2>
          <p class="muted small-note">Actual frente a la medición previa por bloques clínicos. El color indica mejora o empeoramiento según la métrica.</p>
        </div>
        <span class="pill">${escapeHtml(comparison.days_between != null ? `${comparison.days_between} días` : 'Histórico')}</span>
      </div>
      <div class="comparison-section-grid">
        ${orderedSections.map((section) => `
          <div class="comparison-section-card">
            <h3>${escapeHtml(comparisonSectionTitle(section))}</h3>
            ${(groups.get(section) || []).slice(0, 8).map((metric) => `
              <div class="comparison-metric">
                <div class="comparison-metric-head">
                  <strong>${escapeHtml(metric.label)}</strong>
                  <span class="${metricTrendClass(metric)}">${escapeHtml(formatDeltaWithPercent(metric))}</span>
                </div>
                ${comparisonBarHtml(metric)}
              </div>
            `).join('')}
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function sumFiniteValues(values = []) {
  const usable = values.map((value) => finiteNumber(value)).filter((value) => value !== null);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) : null;
}

function percentSegmentsFromGroups(groups = []) {
  const normalized = groups
    .map((group) => ({ ...group, value: sumFiniteValues(group.values || []) }))
    .filter((group) => group.value !== null && group.value > 0);
  const total = normalized.reduce((sum, group) => sum + group.value, 0);
  if (!total) return [];
  return normalized.map((group) => ({
    ...group,
    percent: round((group.value / total) * 100, 1),
  }));
}

function segmentByLabel(segments = [], label = '') {
  return segments.find((segment) => String(segment.label).toLowerCase() === String(label).toLowerCase()) || null;
}

function segmentDeltaHtml(segment = {}, comparisonSegments = []) {
  const comparison = segmentByLabel(comparisonSegments, segment.label);
  if (!comparison || comparison.percent === null || comparison.percent === undefined) return '';
  const delta = round(Number(segment.percent) - Number(comparison.percent), 1);
  if (!Number.isFinite(delta)) return '';
  const sign = delta > 0 ? '+' : '';
  const className = Math.abs(delta) < 0.1 ? 'delta-stable' : delta > 0 ? 'delta-bad' : 'delta-good';
  return `<em class="${className}">${escapeHtml(sign)}${escapeHtml(delta)} pp vs comparación</em>`;
}

function segmentRowsHtml(title, segments = [], comparisonSegments = []) {
  if (!segments.length) return '';
  return `
    <div class="distribution-panel">
      <h3>${escapeHtml(title)}</h3>
      ${segments.map((segment) => {
        const comparison = segmentByLabel(comparisonSegments, segment.label);
        return `
          <div class="distribution-row">
            <div class="distribution-row-head">
              <span>${escapeHtml(segment.label)}</span>
              <strong>Actual ${escapeHtml(segment.percent)}%</strong>
              ${comparison ? `<small>Comparación ${escapeHtml(comparison.percent)}%</small>` : ''}
              ${segmentDeltaHtml(segment, comparisonSegments)}
            </div>
            <div class="distribution-track">
              <i style="width:${escapeHtml(segment.percent)}%;background:${escapeHtml(segment.color)}"></i>
              ${comparison ? `<b style="left:${escapeHtml(comparison.percent)}%"></b>` : ''}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function bodyDistributionSvg(adiposeSegments = [], muscleSegments = []) {
  const upper = segmentByLabel(adiposeSegments, 'Superior')?.color || '#38bdf8';
  const central = segmentByLabel(adiposeSegments, 'Central')?.color || '#f97316';
  const lower = segmentByLabel(adiposeSegments, 'Inferior')?.color || '#22c55e';
  const arm = segmentByLabel(muscleSegments, 'Brazo')?.color || '#0f766e';
  const thigh = segmentByLabel(muscleSegments, 'Muslo')?.color || '#14b8a6';
  const leg = segmentByLabel(muscleSegments, 'Pierna')?.color || '#5eead4';
  return `
    <svg class="body-map" viewBox="0 0 170 260" role="img" aria-label="Mapa corporal orientativo">
      <circle cx="85" cy="28" r="18" fill="${escapeHtml(upper)}" opacity=".72"></circle>
      <path d="M58 54 H112 L126 132 H44 Z" fill="${escapeHtml(central)}" opacity=".72"></path>
      <path d="M48 61 L25 128" stroke="${escapeHtml(arm)}" stroke-width="15" stroke-linecap="round" opacity=".72"></path>
      <path d="M122 61 L145 128" stroke="${escapeHtml(arm)}" stroke-width="15" stroke-linecap="round" opacity=".72"></path>
      <path d="M61 133 L53 228" stroke="${escapeHtml(thigh)}" stroke-width="18" stroke-linecap="round" opacity=".72"></path>
      <path d="M109 133 L117 228" stroke="${escapeHtml(thigh)}" stroke-width="18" stroke-linecap="round" opacity=".72"></path>
      <path d="M53 204 L48 244" stroke="${escapeHtml(leg)}" stroke-width="12" stroke-linecap="round" opacity=".72"></path>
      <path d="M117 204 L122 244" stroke="${escapeHtml(leg)}" stroke-width="12" stroke-linecap="round" opacity=".72"></path>
      <path d="M58 54 H112 L126 132 H44 Z M61 133 L53 228 M109 133 L117 228" fill="none" stroke="#0f172a" stroke-opacity=".12" stroke-width="2"></path>
    </svg>
  `;
}

function bodyDistributionFigureHtml(adiposeSegments = [], muscleSegments = []) {
  const image = nutritionAssetDataUri('body-distribution-neutral-front.png');
  if (!image) return bodyDistributionSvg(adiposeSegments, muscleSegments);
  const upper = segmentByLabel(adiposeSegments, 'Superior');
  const central = segmentByLabel(adiposeSegments, 'Central');
  const lower = segmentByLabel(adiposeSegments, 'Inferior');
  const arm = segmentByLabel(muscleSegments, 'Brazo');
  const leg = segmentByLabel(muscleSegments, 'Pierna') || segmentByLabel(muscleSegments, 'Muslo');
  return `
    <div class="body-map-figure">
      <img class="body-map-img" src="${image}" alt="Distribución corporal">
      ${upper ? `<span class="body-zone body-zone-upper" style="background:${escapeHtml(upper.color)}" title="Adiposo superior"></span>` : ''}
      ${central ? `<span class="body-zone body-zone-central" style="background:${escapeHtml(central.color)}" title="Adiposo central"></span>` : ''}
      ${lower ? `<span class="body-zone body-zone-lower" style="background:${escapeHtml(lower.color)}" title="Adiposo inferior"></span>` : ''}
      ${arm ? `<span class="body-zone body-zone-arm" style="background:${escapeHtml(arm.color)}" title="Muscular brazo"></span>` : ''}
      ${leg ? `<span class="body-zone body-zone-leg" style="background:${escapeHtml(leg.color)}" title="Muscular pierna"></span>` : ''}
    </div>
  `;
}

function distributionReferenceHtml() {
  const adipose = reportAssetImageHtml('images/nutrition-distribution-adipose-zones.webp', 'Mapa de zonas adiposas', 'distribution-ref-img');
  const muscle = reportAssetImageHtml('images/nutrition-distribution-muscle-zones.webp', 'Mapa de zonas musculares', 'distribution-ref-img');
  if (!adipose && !muscle) return '';
  return `
    <div class="distribution-reference">
      ${adipose ? `
        <figure>
          ${adipose}
          <figcaption><strong>Pliegues</strong><span>Superior, central e inferior.</span></figcaption>
        </figure>
      ` : ''}
      ${muscle ? `
        <figure class="distribution-reference-reverse">
          <figcaption><strong>Perímetros</strong><span>Brazo, muslo y pierna.</span></figcaption>
          ${muscle}
        </figure>
      ` : ''}
    </div>
  `;
}

function buildDistributionVisualHtml(measurement = {}, previousMeasurement = null) {
  const raw = measurement.raw_values || {};
  const calculated = measurement.calculated_values || {};
  const previousRaw = previousMeasurement?.raw_values || {};
  const previousCalculated = previousMeasurement?.calculated_values || {};
  const adiposeSegments = percentSegmentsFromGroups([
    { label: 'Superior', color: '#38bdf8', values: [raw.skinfold_triceps_mm, raw.skinfold_biceps_mm, raw.skinfold_subscapular_mm] },
    { label: 'Central', color: '#f97316', values: [raw.skinfold_iliac_crest_mm, raw.skinfold_supraspinale_mm, raw.skinfold_abdominal_mm] },
    { label: 'Inferior', color: '#22c55e', values: [raw.skinfold_front_thigh_mm, raw.skinfold_medial_calf_mm] },
  ]);
  const previousAdiposeSegments = percentSegmentsFromGroups([
    { label: 'Superior', color: '#38bdf8', values: [previousRaw.skinfold_triceps_mm, previousRaw.skinfold_biceps_mm, previousRaw.skinfold_subscapular_mm] },
    { label: 'Central', color: '#f97316', values: [previousRaw.skinfold_iliac_crest_mm, previousRaw.skinfold_supraspinale_mm, previousRaw.skinfold_abdominal_mm] },
    { label: 'Inferior', color: '#22c55e', values: [previousRaw.skinfold_front_thigh_mm, previousRaw.skinfold_medial_calf_mm] },
  ]);
  const muscleSegments = percentSegmentsFromGroups([
    { label: 'Brazo', color: '#0f766e', values: [calculated.corrected_arm_girth_cm || raw.arm_flexed_tensed_cm || raw.arm_relaxed_cm] },
    { label: 'Muslo', color: '#14b8a6', values: [raw.thigh_cm] },
    { label: 'Pierna', color: '#5eead4', values: [calculated.corrected_calf_girth_cm || raw.calf_cm] },
  ]);
  const previousMuscleSegments = percentSegmentsFromGroups([
    { label: 'Brazo', color: '#0f766e', values: [previousCalculated.corrected_arm_girth_cm || previousRaw.arm_flexed_tensed_cm || previousRaw.arm_relaxed_cm] },
    { label: 'Muslo', color: '#14b8a6', values: [previousRaw.thigh_cm] },
    { label: 'Pierna', color: '#5eead4', values: [previousCalculated.corrected_calf_girth_cm || previousRaw.calf_cm] },
  ]);
  if (!adiposeSegments.length && !muscleSegments.length) return '';

  return `
    <section class="card">
      ${sectionVisualHeaderHtml({
        kicker: 'Distribución corporal',
        title: 'Distribución adiposa y muscular',
        body: 'Lectura sencilla: muestra en qué zonas se concentra más la suma de pliegues o perímetros medidos. No es el porcentaje total de grasa o músculo del cuerpo; sirve para comparar distribución entre visitas.',
        imageFilename: 'body-distribution-neutral-front.png',
        imageAlt: 'Mapa corporal de distribución',
      })}
      <div class="distribution-layout">
        ${segmentRowsHtml('Tejido adiposo', adiposeSegments, previousAdiposeSegments)}
        <div class="body-map-wrap">
          <div class="body-map-title">Mapa corporal</div>
          ${bodyDistributionFigureHtml(adiposeSegments, muscleSegments)}
          <div class="distribution-key">
            <div><i class="key-current"></i><strong>Color</strong><span>Valor actual de cada fila</span></div>
            ${previousMeasurement ? '<div><i class="key-previous"></i><strong>Marca negra</strong><span>Medición elegida para comparar</span></div>' : ''}
            <div><i class="key-body"></i><strong>Puntos del cuerpo</strong><span>Solo ubican las zonas</span></div>
          </div>
        </div>
        ${segmentRowsHtml('Tejido muscular', muscleSegments, previousMuscleSegments)}
      </div>
      ${distributionReferenceHtml()}
    </section>
  `;
}

function buildSomatotypeVisualHtml(report = {}, patient = {}) {
  const somatotype = report?.summary?.somatotype || null;
  if (!somatotype) return '';
  const endomorphy = finiteNumber(somatotype.endomorphy);
  const mesomorphy = finiteNumber(somatotype.mesomorphy);
  const ectomorphy = finiteNumber(somatotype.ectomorphy);
  if (endomorphy === null || mesomorphy === null || ectomorphy === null) return '';
  const x = ectomorphy - endomorphy;
  const y = (2 * mesomorphy) - (endomorphy + ectomorphy);
  const plotX = Math.max(64, Math.min(296, 180 + (x * 18)));
  const plotY = Math.max(48, Math.min(226, 154 - (y * 10)));
  const somatotypeImage = somatotypeImageDataUri(report, patient);
  const somatotypeImageHtml = somatotypeImage ? `
    <div class="somato-image-card">
      <img src="${somatotypeImage}" alt="${escapeHtml(somatotypeDominanceLabel(somatotype))}">
      <strong>${escapeHtml(somatotypeDominanceLabel(somatotype))}</strong>
    </div>
  ` : '';
  return `
    <section class="card">
      ${sectionVisualHeaderHtml({
        kicker: 'Somatotipo',
        title: 'Somatocarta',
        body: 'Lectura sencilla: sitúa el tipo corporal dominante en un triángulo. Arriba predomina la musculatura, a la izquierda la adiposidad relativa y a la derecha la linealidad o complexión más ligera.',
        imageFilename: 'images/nutrition-somatotype-triad.webp',
        imageAlt: 'Tres siluetas de referencia de somatotipo',
      })}
      <div class="somato-layout ${somatotypeImage ? 'somato-layout-with-image' : ''}">
        <svg class="somato-chart" viewBox="0 0 360 320" role="img">
          <path d="M180 38 C250 64 305 138 300 226 L60 226 C55 138 110 64 180 38 Z" fill="none" stroke="#64748b" stroke-width="2" stroke-dasharray="5 5"></path>
          <line x1="180" y1="38" x2="180" y2="226" stroke="#94a3b8" stroke-dasharray="4 4"></line>
          <line x1="60" y1="226" x2="300" y2="226" stroke="#94a3b8" stroke-dasharray="4 4"></line>
          <line x1="60" y1="226" x2="300" y2="92" stroke="#cbd5e1"></line>
          <line x1="300" y1="226" x2="60" y2="92" stroke="#cbd5e1"></line>
          <text x="180" y="25" text-anchor="middle" class="somato-label">Mesomorfia</text>
          <text x="78" y="286" text-anchor="middle" class="somato-label">Endomorfia</text>
          <text x="282" y="286" text-anchor="middle" class="somato-label">Ectomorfia</text>
          <circle cx="${round(plotX, 1)}" cy="${round(plotY, 1)}" r="6" fill="#0f766e"></circle>
          <text x="${round(plotX, 1)}" y="${round(plotY - 12, 1)}" text-anchor="middle" class="somato-point-label">Paciente</text>
        </svg>
        <div class="somato-values">
          ${[
            { key: 'endo', label: 'Endomorfia', value: endomorphy },
            { key: 'meso', label: 'Mesomorfia', value: mesomorphy },
            { key: 'ecto', label: 'Ectomorfia', value: ectomorphy },
          ].map((item) => {
            const image = somatotypeImageDataUriForKey(item.key, report, patient);
            return `
              <div class="somato-value-card">
                ${image ? `<img src="${image}" alt="${escapeHtml(item.label)}">` : ''}
                <span>${escapeHtml(item.label)}</span>
                <strong>${escapeHtml(item.value)}</strong>
              </div>
            `;
          }).join('')}
        </div>
        ${somatotypeImageHtml}
      </div>
    </section>
  `;
}

function mimeTypeForAsset(filename) {
  const extension = path.extname(filename || '').toLowerCase();
  if (extension === '.webp') return 'image/webp';
  if (extension === '.svg') return 'image/svg+xml';
  return 'image/png';
}

function assetDataUri(filePath) {
  if (!filePath) return '';
  if (nutritionReportImageCache.has(filePath)) {
    return nutritionReportImageCache.get(filePath);
  }
  try {
    const buffer = fsSync.readFileSync(filePath);
    const mimeType = mimeTypeForAsset(filePath);
    const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;
    nutritionReportImageCache.set(filePath, dataUri);
    return dataUri;
  } catch (error) {
    nutritionReportImageCache.set(filePath, '');
    return '';
  }
}

function nutritionAssetDataUri(filename) {
  return filename ? assetDataUri(path.join(NUTRITION_ASSET_DIR, filename)) : '';
}

function nutritionImageDataUri(filename) {
  return filename ? assetDataUri(path.join(NUTRITION_SOMATOTYPE_ASSET_DIR, filename)) : '';
}

function clinicaclickLogoDataUri() {
  return assetDataUri(path.join(NUTRITION_BRAND_ASSET_DIR, 'clinicaclick-logo-text.svg'));
}

function somatotypeDominanceLabel(somatotype = {}) {
  const values = [
    { key: 'endo', label: 'Endomorfia dominante', value: finiteNumber(somatotype.endomorphy) },
    { key: 'meso', label: 'Mesomorfia dominante', value: finiteNumber(somatotype.mesomorphy) },
    { key: 'ecto', label: 'Ectomorfia dominante', value: finiteNumber(somatotype.ectomorphy) },
  ].filter((item) => item.value !== null);
  if (!values.length) return 'Somatotipo de referencia';
  return values.sort((a, b) => b.value - a.value)[0].label;
}

function somatotypeImageDataUri(report = {}, patient = {}) {
  const somatotype = report?.summary?.somatotype || null;
  if (!somatotype) return nutritionImageDataUri('somatotype-overview.png');
  const values = [
    { key: 'endo', value: finiteNumber(somatotype.endomorphy) },
    { key: 'meso', value: finiteNumber(somatotype.mesomorphy) },
    { key: 'ecto', value: finiteNumber(somatotype.ectomorphy) },
  ].filter((item) => item.value !== null);
  if (!values.length) return nutritionImageDataUri('somatotype-overview.png');
  const dominant = values.sort((a, b) => b.value - a.value)[0]?.key || 'meso';
  return somatotypeImageDataUriForKey(dominant, report, patient);
}

function somatotypeImageDataUriForKey(key, report = {}, patient = {}) {
  const normalized = ['endo', 'meso', 'ecto'].includes(key) ? key : 'meso';
  const patientSex = String(patient?.sex || report?.patient?.sex || report?.summary?.patient_sex || '').toLowerCase();
  const sex = patientSex === 'female' || patientSex === 'mujer' ? 'female' : 'male';
  const extension = sex === 'male' ? 'webp' : 'png';
  return nutritionImageDataUri(`${normalized}-${sex}.${extension}`);
}

function fatDistributionSummary(measurement = {}) {
  const raw = measurement?.raw_values || {};
  const trunk = sumFiniteValues([raw.skinfold_subscapular_mm, raw.skinfold_iliac_crest_mm, raw.skinfold_supraspinale_mm, raw.skinfold_abdominal_mm]);
  const extremities = sumFiniteValues([raw.skinfold_triceps_mm, raw.skinfold_biceps_mm, raw.skinfold_front_thigh_mm, raw.skinfold_medial_calf_mm]);
  if (trunk === null || extremities === null || (trunk + extremities) <= 0) return null;
  const total = trunk + extremities;
  return {
    trunk,
    extremities,
    trunkPercent: round((trunk / total) * 100, 1),
    extremitiesPercent: round((extremities / total) * 100, 1),
    index: round(trunk / total, 2),
  };
}

function buildFatDistributionHtml(current = null, previous = null) {
  if (!current) return '';
  const delta = previous ? round(current.trunkPercent - previous.trunkPercent, 1) : null;
  const deltaLabel = delta === null
    ? ''
    : `<span class="${Math.abs(delta) < 0.1 ? 'delta-stable' : delta > 0 ? 'delta-bad' : 'delta-good'}">${delta > 0 ? '+' : ''}${escapeHtml(delta)} pp tronco vs comparación</span>`;
  return `
    <div class="fat-distribution">
      <div class="fat-distribution-head">
        <strong>Distribución corporal de grasa</strong>
        ${deltaLabel}
      </div>
      <div class="fat-distribution-grid">
        <div>
          ${buildDonutSvg([
            { label: 'Tronco', value: current.trunkPercent, color: '#fb923c' },
            { label: 'Extremidades', value: current.extremitiesPercent, color: '#14b8a6' },
          ], { title: `${current.trunkPercent}%`, subtitle: 'tronco' })}
        </div>
        <div class="fat-distribution-values">
          <div>
            <span style="background:#fb923c"></span>
            <strong>Tronco${previous ? `<small>Comparación ${escapeHtml(previous.trunkPercent)}%</small>` : ''}</strong>
            <em>${escapeHtml(current.trunkPercent)}%</em>
          </div>
          <div>
            <span style="background:#14b8a6"></span>
            <strong>Extremidades${previous ? `<small>Comparación ${escapeHtml(previous.extremitiesPercent)}%</small>` : ''}</strong>
            <em>${escapeHtml(current.extremitiesPercent)}%</em>
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildHealthIndexesHtml(measurement = {}, previousMeasurement = null) {
  const raw = measurement.raw_values || {};
  const calculated = measurement.calculated_values || {};
  const weight = finiteNumber(raw.weight_kg);
  const stature = finiteNumber(raw.stature_cm);
  const waist = finiteNumber(raw.waist_cm);
  const hip = finiteNumber(raw.hip_cm);
  const waistHeight = waist !== null && stature ? round(waist / stature, 2) : null;
  const conicity = waist !== null && weight && stature
    ? round((waist / 100) / (0.109 * Math.sqrt(weight / (stature / 100))), 2)
    : null;
  const fatDistribution = fatDistributionSummary(measurement);
  const previousFatDistribution = previousMeasurement ? fatDistributionSummary(previousMeasurement) : null;
  const rows = [
    {
      label: 'Índice cintura/cadera',
      value: calculated.waist_hip_ratio,
      range: '< 1,00',
      ok: finiteNumber(calculated.waist_hip_ratio) !== null ? Number(calculated.waist_hip_ratio) < 1 : null,
      interpretation: 'Indicador antropométrico de distribución central.',
    },
    {
      label: 'Índice cintura/talla',
      value: waistHeight,
      range: '< 0,50',
      ok: waistHeight !== null ? waistHeight < 0.5 : null,
      interpretation: 'Relación entre cintura y estatura.',
    },
    {
      label: 'Índice de conicidad',
      value: conicity,
      range: '< 1,40',
      ok: conicity !== null ? conicity < 1.4 : null,
      interpretation: 'Estimación de concentración abdominal.',
    },
    {
      label: 'IMC',
      value: calculated.bmi,
      range: '18,5 - 24,9',
      ok: finiteNumber(calculated.bmi) !== null ? Number(calculated.bmi) >= 18.5 && Number(calculated.bmi) <= 24.9 : null,
      interpretation: 'Relación entre peso y estatura.',
    },
    {
      label: 'Índice de distribución grasa',
      value: fatDistribution?.index,
      range: 'seguimiento',
      ok: null,
      interpretation: 'Proporción de grasa medida en tronco respecto al total de pliegues registrados.',
    },
  ].filter((row) => row.value !== null && row.value !== undefined && row.value !== '');
  if (!rows.length) return '';
  return `
    <section class="card">
      ${sectionVisualHeaderHtml({
        kicker: 'Seguimiento',
        title: 'Índices de salud',
        body: 'Lectura sencilla: estos índices cruzan cintura, cadera, estatura y peso para orientar el seguimiento. Un aviso no sustituye la valoración del profesional.',
        imageFilename: 'images/nutrition-health-indices.webp',
        imageAlt: 'Índices antropométricos de salud',
      })}
      <table class="health-table">
          <thead><tr><th>Índice</th><th>Valor</th><th>Rango saludable</th></tr></thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td><strong>${escapeHtml(row.label)}</strong><br><span class="muted">${escapeHtml(row.interpretation)}</span></td>
                <td><span class="health-badge ${row.ok === true ? 'health-ok' : row.ok === false ? 'health-alert' : 'health-neutral'}">${escapeHtml(row.value)}</span></td>
                <td>${escapeHtml(row.range)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ${buildFatDistributionHtml(fatDistribution, previousFatDistribution)}
    </section>
  `;
}

function buildCalculationProfileHtml(profile = CALCULATION_PROFILE) {
  const activeEquation = profile.fat_mass_model || FAT_MASS_EQUATION_OPTIONS.find((item) => item.status === 'active') || null;
  const availableEquations = (profile.fat_mass_equations || FAT_MASS_EQUATION_OPTIONS)
    .filter((item) => item.code !== activeEquation?.code);
  return `
    <section class="card muted-card">
      <h2>Perfil de cálculo aplicado</h2>
      <p><strong>${escapeHtml(profile.label)}</strong>. ${escapeHtml(profile.description)}</p>
      <div class="calculation-profile-grid">
        <div>
          <dt>Ecuación activa de masa grasa</dt>
          <dd>${escapeHtml(activeEquation?.label || '-')}</dd>
        </div>
        ${(profile.automatic_models || []).map((item) => `
          <div>
            <dt>${escapeHtml(item.role || item.code)}</dt>
            <dd>${escapeHtml(item.label)}</dd>
          </div>
        `).join('')}
      </div>
      ${availableEquations.length ? `
        <p class="muted small-note">La ecuación de masa grasa se puede cambiar al generar HTML/PDF del informe: ${escapeHtml(availableEquations.map((item) => item.label).join(', '))}. Kerr-Ross, Heath-Carter y proyección siguen como bloques automáticos.</p>
      ` : ''}
    </section>
  `;
}

function normalizeProfileCode(value) {
  return value === 'express_isak' ? 'express_isak' : 'quick';
}

async function getNutritionContractSafe() {
  try {
    return await medicalAreaContracts.getContractForArea('nutricion');
  } catch (error) {
    return medicalAreaContracts.getBaseContractForArea('nutricion');
  }
}

function profileDefinitionsFromContract(contract = {}) {
  return Array.isArray(contract.nutrition_measurement_profile_schemas) && contract.nutrition_measurement_profile_schemas.length
    ? contract.nutrition_measurement_profile_schemas
    : PROFILE_DEFINITIONS;
}

function fieldDefinitionsFromContract(contract = {}) {
  return contract.nutrition_measurement_fields
    && typeof contract.nutrition_measurement_fields === 'object'
    && Object.keys(contract.nutrition_measurement_fields).length
    ? contract.nutrition_measurement_fields
    : FIELD_DEFINITIONS;
}

function requiredFieldsForProfile(profileCode = 'quick', profileDefinitions = PROFILE_DEFINITIONS) {
  const profile = (profileDefinitions || PROFILE_DEFINITIONS).find((item) => item.code === profileCode)
    || (profileDefinitions || PROFILE_DEFINITIONS)[0]
    || {};
  return Array.from(new Set((profile.groups || [])
    .flatMap((group) => group.required_fields || [])
    .filter(Boolean)));
}

function missingRequiredFieldsForProfile(rawValues = {}, profileCode = 'quick', profileDefinitions = PROFILE_DEFINITIONS, fieldDefinitions = FIELD_DEFINITIONS) {
  return requiredFieldsForProfile(profileCode, profileDefinitions)
    .filter((field) => {
      const value = rawValues[field];
      return value === undefined || value === null || value === '';
    })
    .map((field) => ({
      field,
      label: fieldDefinitions?.[field]?.label || field,
      unit: fieldDefinitions?.[field]?.unit || '',
    }));
}

function calculationInputLabel(field, fieldDefinitions = FIELD_DEFINITIONS) {
  if (field === 'patient_sex') return 'Sexo del paciente';
  if (field === 'patient_age') return 'Edad del paciente';
  return fieldDefinitions?.[field]?.label || field;
}

function missingCalculationInputLabels(rawValues = {}, fields = [], fieldDefinitions = FIELD_DEFINITIONS) {
  return fields
    .filter((field) => {
      const value = rawValues[field];
      return value === undefined || value === null || value === '' || !Number.isFinite(Number(value));
    })
    .map((field) => calculationInputLabel(field, fieldDefinitions));
}

function publicFormulaReferencesForKeys(keys = []) {
  return Array.from(new Set(keys.filter(Boolean)))
    .map((key) => FORMULA_REFERENCES_BY_KEY.get(key))
    .filter(Boolean)
    .map(({ profiles, fat_mass_equation: _fatMassEquation, ...reference }) => reference);
}

function buildCalculationTraceItem({
  key,
  label,
  method,
  source,
  sourceKeys = [],
  applied,
  inputFields = [],
  missingInputs = [],
  outputKeys = [],
}) {
  const uniqueMissingInputs = Array.from(new Set(missingInputs.filter(Boolean)));
  const sourceReferences = publicFormulaReferencesForKeys(sourceKeys);
  return {
    key,
    label,
    method,
    source,
    source_reference_keys: sourceReferences.map((reference) => reference.key),
    source_references: sourceReferences,
    status: applied ? 'applied' : 'pending',
    applied: Boolean(applied),
    input_fields: inputFields,
    missing_input_labels: applied ? [] : uniqueMissingInputs,
    output_keys: outputKeys,
  };
}

function buildCalculationTrace(measurement = {}, fieldDefinitions = FIELD_DEFINITIONS) {
  const profileCode = normalizeProfileCode(measurement.profile_code);
  const rawValues = measurement.raw_values || {};
  const calculatedValues = measurement.calculated_values || {};
  const trace = [];

  const bmiFields = ['weight_kg', 'stature_cm'];
  trace.push(buildCalculationTraceItem({
    key: 'bmi',
    label: 'IMC',
    method: 'peso / estatura²',
    source: 'Cálculo interno ClinicaClick',
    sourceKeys: ['bmi'],
    applied: Number.isFinite(Number(calculatedValues.bmi)),
    inputFields: bmiFields,
    missingInputs: missingCalculationInputLabels(rawValues, bmiFields, fieldDefinitions),
    outputKeys: ['bmi'],
  }));

  const waistHipFields = ['waist_cm', 'hip_cm'];
  trace.push(buildCalculationTraceItem({
    key: 'waist_hip_ratio',
    label: 'Ratio cintura/cadera',
    method: 'cintura / cadera',
    source: 'Cálculo interno ClinicaClick',
    sourceKeys: ['waist_hip_ratio'],
    applied: Number.isFinite(Number(calculatedValues.waist_hip_ratio)),
    inputFields: waistHipFields,
    missingInputs: missingCalculationInputLabels(rawValues, waistHipFields, fieldDefinitions),
    outputKeys: ['waist_hip_ratio'],
  }));

  const skinfoldFields = Object.keys(fieldDefinitions || FIELD_DEFINITIONS)
    .filter((field) => field.startsWith('skinfold_'));
  const skinfoldCount = skinfoldFields.filter((field) => Number.isFinite(Number(rawValues[field]))).length;
  if (profileCode === 'express_isak' || skinfoldCount > 0) {
    trace.push(buildCalculationTraceItem({
      key: 'skinfold_sum_mm',
      label: 'Suma de pliegues',
      method: 'suma de pliegues registrados',
      source: 'Cálculo interno ClinicaClick',
      sourceKeys: ['isak_restricted_profile'],
      applied: Number.isFinite(Number(calculatedValues.skinfold_sum_mm)),
      inputFields: skinfoldFields,
      missingInputs: skinfoldCount > 0 ? [] : ['Al menos un pliegue'],
      outputKeys: ['skinfold_sum_mm'],
    }));
  }

  const correctedArmFields = ['arm_flexed_tensed_cm', 'skinfold_triceps_mm'];
  if (profileCode === 'express_isak' || correctedArmFields.some((field) => rawValues[field] !== undefined)) {
    trace.push(buildCalculationTraceItem({
      key: 'corrected_arm_girth_cm',
      label: 'Brazo corregido',
      method: 'brazo flexionado - pliegue tríceps/10',
      source: 'Cálculo interno ClinicaClick',
      sourceKeys: ['heath_carter_somatotype'],
      applied: Number.isFinite(Number(calculatedValues.corrected_arm_girth_cm)),
      inputFields: correctedArmFields,
      missingInputs: missingCalculationInputLabels(rawValues, correctedArmFields, fieldDefinitions),
      outputKeys: ['corrected_arm_girth_cm'],
    }));
  }

  const correctedCalfFields = ['calf_cm', 'skinfold_medial_calf_mm'];
  if (profileCode === 'express_isak' || correctedCalfFields.some((field) => rawValues[field] !== undefined)) {
    trace.push(buildCalculationTraceItem({
      key: 'corrected_calf_girth_cm',
      label: 'Pantorrilla corregida',
      method: 'pantorrilla - pliegue pantorrilla medial/10',
      source: 'Cálculo interno ClinicaClick',
      sourceKeys: ['heath_carter_somatotype'],
      applied: Number.isFinite(Number(calculatedValues.corrected_calf_girth_cm)),
      inputFields: correctedCalfFields,
      missingInputs: missingCalculationInputLabels(rawValues, correctedCalfFields, fieldDefinitions),
      outputKeys: ['corrected_calf_girth_cm'],
    }));
  }

  if (profileCode === 'express_isak') {
    const somatotypeFields = [
      'stature_cm',
      'weight_kg',
      'skinfold_triceps_mm',
      'skinfold_subscapular_mm',
      'skinfold_supraspinale_mm',
      'skinfold_medial_calf_mm',
      'breadth_humerus_cm',
      'breadth_femur_cm',
      'arm_flexed_tensed_cm',
      'calf_cm',
    ];
    trace.push(buildCalculationTraceItem({
      key: 'heath_carter_somatotype',
      label: 'Somatotipo Heath-Carter',
      method: 'endomorfia, mesomorfia y ectomorfia antropométricas',
      source: 'Heath-Carter anthropometric somatotype',
      sourceKeys: ['heath_carter_somatotype'],
      applied: Boolean(calculatedValues.somatotype),
      inputFields: somatotypeFields,
      missingInputs: missingCalculationInputLabels(rawValues, somatotypeFields, fieldDefinitions),
      outputKeys: ['endomorphy', 'mesomorphy', 'ectomorphy'],
    }));

    const bodyCompositionMeta = calculatedValues.body_composition ||
      calculatedValues.body_composition_meta ||
      bodyCompositionEquationMeta(DEFAULT_FAT_MASS_EQUATION_CODE);
    const bodyCompositionFields = bodyCompositionMeta.input_fields || [
      'weight_kg',
      'skinfold_biceps_mm',
      'skinfold_triceps_mm',
      'skinfold_subscapular_mm',
      'skinfold_iliac_crest_mm',
    ];
    const missingBodyCompositionInputs = missingCalculationInputLabels(rawValues, bodyCompositionFields, fieldDefinitions);
    if (!missingBodyCompositionInputs.length && !calculatedValues.body_composition) {
      if (bodyCompositionMeta.requires_sex !== false) missingBodyCompositionInputs.push('Sexo del paciente');
      if (bodyCompositionMeta.requires_age) missingBodyCompositionInputs.push('Edad del paciente');
      if (!missingBodyCompositionInputs.length) missingBodyCompositionInputs.push('Datos insuficientes para esta ecuación');
    }
    trace.push(buildCalculationTraceItem({
      key: 'body_composition',
      label: 'Composición corporal',
      method: bodyCompositionMeta.method || bodyCompositionMeta.equation_label || 'Ecuación de masa grasa',
      source: bodyCompositionMeta.source || bodyCompositionMeta.equation_label || 'Ecuación de masa grasa',
      sourceKeys: bodyCompositionMeta.source_reference_keys || [],
      applied: Boolean(calculatedValues.body_composition),
      inputFields: [...bodyCompositionFields, 'patient_sex', 'patient_age'],
      missingInputs: missingBodyCompositionInputs,
      outputKeys: ['body_density', 'body_fat_percent', 'fat_mass_kg', 'fat_free_mass_kg'],
    }));

    const bodyFractionationFields = [
      'weight_kg',
      'stature_cm',
      'sitting_height_cm',
      'head_cm',
      'skinfold_triceps_mm',
      'skinfold_subscapular_mm',
      'skinfold_supraspinale_mm',
      'skinfold_abdominal_mm',
      'skinfold_front_thigh_mm',
      'skinfold_medial_calf_mm',
      'arm_relaxed_cm',
      'forearm_cm',
      'thigh_cm',
      'chest_cm',
      'waist_cm',
      'calf_cm',
      'breadth_biacromial_cm',
      'breadth_biiliocristal_cm',
      'breadth_humerus_cm',
      'breadth_femur_cm',
      'depth_chest_ap_cm',
      'breadth_chest_transverse_cm',
    ];
    const missingBodyFractionationInputs = missingCalculationInputLabels(rawValues, bodyFractionationFields, fieldDefinitions);
    if (!missingBodyFractionationInputs.length && !calculatedValues.body_fractionation) {
      missingBodyFractionationInputs.push('Sexo del paciente', 'Edad del paciente');
    }
    trace.push(buildCalculationTraceItem({
      key: 'body_fractionation',
      label: 'Cinco componentes Kerr-Ross',
      method: 'fraccionamiento antropométrico Kerr-Ross con táctica Phantom',
      source: 'Kerr 1988 / Ross-Kerr 5 componentes',
      sourceKeys: ['kerr_ross_five_component_fractionation'],
      applied: Boolean(calculatedValues.body_fractionation),
      inputFields: [...bodyFractionationFields, 'patient_sex', 'patient_age'],
      missingInputs: missingBodyFractionationInputs,
      outputKeys: [
        'skin_mass_kg',
        'adipose_mass_kg',
        'muscle_mass_kg',
        'bone_mass_kg',
        'residual_mass_kg',
        'predicted_body_mass_kg',
      ],
    }));
  }

  return trace;
}

function formulaReferencesForProfile(profileCode = 'quick', calculationProfile = CALCULATION_PROFILE) {
  const selectedSourceKeys = new Set([
    ...((calculationProfile?.fat_mass_model?.source_reference_keys) || []),
    ...((calculationProfile?.automatic_models || []).flatMap((item) => item.source_reference_keys || [])),
  ]);
  return FORMULA_REFERENCES
    .filter((reference) => {
      if (reference.fat_mass_equation) return selectedSourceKeys.has(reference.key);
      return (reference.profiles || []).includes(profileCode) || selectedSourceKeys.has(reference.key);
    })
    .map(({ profiles, ...reference }) => reference);
}

function normalizeRawValues(values = {}, fieldDefinitions = FIELD_DEFINITIONS) {
  const normalized = {};
  Object.keys(fieldDefinitions || FIELD_DEFINITIONS).forEach((field) => {
    const parsed = toNumberOrNull(values[field]);
    if (parsed !== null) normalized[field] = parsed;
  });
  if (values.objective) normalized.objective = String(values.objective).trim().slice(0, 160);
  return normalized;
}

function qualityFlagsForValues(rawValues = {}, fieldDefinitions = FIELD_DEFINITIONS) {
  const flags = [];
  Object.entries(fieldDefinitions || FIELD_DEFINITIONS).forEach(([key, def]) => {
    const value = rawValues[key];
    if (value === undefined || value === null) return;
    if (value < def.min || value > def.max) {
      flags.push({
        field: key,
        code: 'out_of_expected_range',
        message: `${def.label} fuera del rango esperado`,
      });
    }
  });
  return flags;
}

function calculateSomatotype(rawValues = {}) {
  const height = rawValues.stature_cm;
  const weight = rawValues.weight_kg;
  const triceps = rawValues.skinfold_triceps_mm;
  const subscapular = rawValues.skinfold_subscapular_mm;
  const supraspinale = rawValues.skinfold_supraspinale_mm;
  const medialCalf = rawValues.skinfold_medial_calf_mm;
  const humerus = rawValues.breadth_humerus_cm;
  const femur = rawValues.breadth_femur_cm;
  const armFlexed = rawValues.arm_flexed_tensed_cm;
  const calf = rawValues.calf_cm;

  if (![height, weight, triceps, subscapular, supraspinale, medialCalf, humerus, femur, armFlexed, calf]
    .every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }

  const correctedSkinfoldSum = (triceps + subscapular + supraspinale) * (170.18 / height);
  const endomorphy =
    -0.7182 +
    (0.1451 * correctedSkinfoldSum) -
    (0.00068 * correctedSkinfoldSum ** 2) +
    (0.0000014 * correctedSkinfoldSum ** 3);
  const correctedArm = armFlexed - (triceps / 10);
  const correctedCalf = calf - (medialCalf / 10);
  const mesomorphy =
    (0.858 * humerus) +
    (0.601 * femur) +
    (0.188 * correctedArm) +
    (0.161 * correctedCalf) -
    (0.131 * height) +
    4.5;
  const heightWeightRatio = height / Math.cbrt(weight);
  let ectomorphy = 0.1;
  if (heightWeightRatio >= 40.75) {
    ectomorphy = (0.732 * heightWeightRatio) - 28.58;
  } else if (heightWeightRatio > 38.25) {
    ectomorphy = (0.463 * heightWeightRatio) - 17.63;
  }

  return {
    endomorphy: round(Math.max(endomorphy, 0), 1),
    mesomorphy: round(Math.max(mesomorphy, 0), 1),
    ectomorphy: round(Math.max(ectomorphy, 0.1), 1),
    source: 'Heath-Carter anthropometric somatotype',
  };
}

function normalizeSexForBodyComposition(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (!normalized) return null;
  if (['hombre', 'masculino', 'male', 'man', 'varon', 'h'].includes(normalized)) return 'male';
  if (['mujer', 'femenino', 'female', 'woman', 'f'].includes(normalized)) return 'female';
  if (normalized.includes('hombre') || normalized.includes('mascul') || normalized.includes('varon')) return 'male';
  if (normalized.includes('mujer') || normalized.includes('femen')) return 'female';
  return null;
}

function calculateAgeYears(birthValue, referenceDate = new Date()) {
  if (!birthValue) return null;
  const birthDate = new Date(birthValue);
  const refDate = new Date(referenceDate);
  if (!Number.isFinite(birthDate.getTime()) || !Number.isFinite(refDate.getTime())) return null;
  let age = refDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDelta = refDate.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && refDate.getUTCDate() < birthDate.getUTCDate())) {
    age -= 1;
  }
  return age >= 0 && age <= 130 ? age : null;
}

function normalizeAgeYears(value) {
  const parsed = toIntOrNull(value);
  return parsed !== null && parsed >= 0 && parsed <= 130 ? parsed : null;
}

function buildPatientFormulaContext(patient, referenceDate = new Date()) {
  return {
    sex: normalizeSexForBodyComposition(patient?.sexo),
    age_years: calculateAgeYears(patient?.fecha_nacimiento, referenceDate) ?? normalizeAgeYears(patient?.edad),
  };
}

function coefficientForDurninWomersley(sex, ageYears) {
  if (!sex || !Number.isFinite(ageYears)) return null;
  return (DURNIN_WOMERSLEY_COEFFICIENTS[sex] || []).find((item) => ageYears <= item.maxAge) || null;
}

function bodyCompositionEquationMeta(equationCode = DEFAULT_FAT_MASS_EQUATION_CODE, sex = null) {
  const code = normalizeFatMassEquationCode(equationCode);
  const equation = fatMassEquationOption(code);
  const base = {
    equation_code: equation.code,
    equation_label: equation.label,
    source_reference_keys: equation.source_reference_keys || [],
    requires_sex: true,
    requires_age: false,
  };
  if (code === 'durnin_womersley_siri') {
    return {
      ...base,
      method: 'Durnin-Womersley 4 skinfold body density + Siri body fat',
      source: 'Durnin-Womersley 1974 + Siri conversion',
      requires_age: true,
      input_fields: ['weight_kg', 'skinfold_biceps_mm', 'skinfold_triceps_mm', 'skinfold_subscapular_mm', 'skinfold_iliac_crest_mm'],
    };
  }
  if (code === 'faulkner_1966') {
    return {
      ...base,
      method: 'Faulkner 4 skinfold body fat',
      source: 'Faulkner 1966',
      input_fields: ['weight_kg', 'skinfold_triceps_mm', 'skinfold_subscapular_mm', 'skinfold_supraspinale_mm', 'skinfold_abdominal_mm'],
    };
  }
  if (code === 'jackson_pollock_1975') {
    return {
      ...base,
      method: 'Jackson-Pollock 4-site body fat',
      source: 'Jackson-Pollock 4-site equation',
      requires_age: true,
      input_fields: ['weight_kg', 'skinfold_abdominal_mm', 'skinfold_triceps_mm', 'skinfold_front_thigh_mm', 'skinfold_iliac_crest_mm'],
    };
  }
  if (code === 'katch_mcardle_1973') {
    return {
      ...base,
      method: 'Katch-McArdle body density + Siri body fat',
      source: 'Katch-McArdle 1973 + Siri conversion',
      input_fields: sex === 'female'
        ? ['weight_kg', 'skinfold_subscapular_mm', 'skinfold_iliac_crest_mm', 'breadth_humerus_cm', 'thigh_cm']
        : ['weight_kg', 'skinfold_triceps_mm', 'skinfold_subscapular_mm', 'skinfold_abdominal_mm'],
    };
  }
  if (code === 'sloan_1962') {
    return {
      ...base,
      method: 'Sloan body density + Siri body fat',
      source: 'Sloan 1962/1967 + Siri conversion',
      input_fields: sex === 'female'
        ? ['weight_kg', 'skinfold_iliac_crest_mm', 'skinfold_triceps_mm']
        : ['weight_kg', 'skinfold_front_thigh_mm', 'skinfold_subscapular_mm'],
    };
  }
  if (code === 'withers_1987') {
    return {
      ...base,
      method: 'Withers body density + Siri body fat',
      source: 'Withers 1987 + Siri conversion',
      input_fields: sex === 'female'
        ? ['weight_kg', 'skinfold_triceps_mm', 'skinfold_subscapular_mm', 'skinfold_supraspinale_mm', 'skinfold_medial_calf_mm']
        : ['weight_kg', 'skinfold_triceps_mm', 'skinfold_subscapular_mm', 'skinfold_biceps_mm', 'skinfold_supraspinale_mm', 'skinfold_abdominal_mm', 'skinfold_front_thigh_mm', 'skinfold_medial_calf_mm'],
    };
  }
  if (code === 'yuhasz_carter_1982') {
    return {
      ...base,
      method: 'Yuhasz-Carter 6 skinfold body fat',
      source: 'Yuhasz modified by Carter 1982',
      input_fields: ['weight_kg', 'skinfold_triceps_mm', 'skinfold_subscapular_mm', 'skinfold_supraspinale_mm', 'skinfold_abdominal_mm', 'skinfold_front_thigh_mm', 'skinfold_medial_calf_mm'],
    };
  }
  if (code === 'slaughter_1988') {
    return {
      ...base,
      method: 'Slaughter 2 skinfold body fat',
      source: 'Slaughter et al. 1988',
      input_fields: ['weight_kg', 'skinfold_triceps_mm', 'skinfold_subscapular_mm'],
    };
  }
  return bodyCompositionEquationMeta(DEFAULT_FAT_MASS_EQUATION_CODE, sex);
}

function siriBodyFatPercent(bodyDensity) {
  if (!Number.isFinite(bodyDensity) || bodyDensity <= 0) return null;
  const bodyFatPercent = (495 / bodyDensity) - 450;
  return Number.isFinite(bodyFatPercent) ? bodyFatPercent : null;
}

function requiredPositiveValues(rawValues = {}, fields = []) {
  const result = {};
  for (const field of fields) {
    const value = rawValues[field];
    if (!Number.isFinite(value) || value <= 0) return null;
    result[field] = value;
  }
  return result;
}

function bodyCompositionResult(rawValues = {}, context = {}, equationMeta = {}, values = {}) {
  const sex = normalizeSexForBodyComposition(context.sex);
  const ageYears = normalizeAgeYears(context.age_years);
  const weight = rawValues.weight_kg;
  const bodyFatPercent = finiteNumber(values.body_fat_percent);
  if (!Number.isFinite(weight) || weight <= 0 || bodyFatPercent === null || bodyFatPercent <= 0 || bodyFatPercent >= 80) {
    return null;
  }
  const fatMassKg = weight * (bodyFatPercent / 100);
  const bodyDensity = values.body_density !== undefined && values.body_density !== null ? round(values.body_density, 4) : undefined;
  return {
    equation_code: equationMeta.equation_code,
    equation_label: equationMeta.equation_label,
    method: equationMeta.method,
    sex,
    age_years: ageYears,
    ...(bodyDensity !== undefined ? { body_density: bodyDensity } : {}),
    body_fat_percent: round(bodyFatPercent, 1),
    fat_mass_kg: round(fatMassKg, 1),
    fat_free_mass_kg: round(weight - fatMassKg, 1),
    input_fields: equationMeta.input_fields || [],
    source: equationMeta.source,
    source_reference_keys: equationMeta.source_reference_keys || [],
    ...(values.extra || {}),
  };
}

function calculateBodyComposition(rawValues = {}, context = {}, options = {}) {
  const equationCode = selectedFatMassEquationCodeFromOptions(options);
  const sex = normalizeSexForBodyComposition(context.sex);
  const ageYears = normalizeAgeYears(context.age_years);
  const equationMeta = bodyCompositionEquationMeta(equationCode, sex);
  if (!sex || (equationMeta.requires_age && !Number.isFinite(ageYears))) return null;
  if (!requiredPositiveValues(rawValues, equationMeta.input_fields || [])) return null;

  if (equationCode === 'durnin_womersley_siri') {
    const skinfoldSum4 = rawValues.skinfold_biceps_mm + rawValues.skinfold_triceps_mm + rawValues.skinfold_subscapular_mm + rawValues.skinfold_iliac_crest_mm;
    const coefficient = coefficientForDurninWomersley(sex, ageYears);
    if (!coefficient) return null;
    const bodyDensity = coefficient.c - (coefficient.m * Math.log10(skinfoldSum4));
    return bodyCompositionResult(rawValues, context, equationMeta, {
      body_density: bodyDensity,
      body_fat_percent: siriBodyFatPercent(bodyDensity),
      extra: {
        age_band: coefficient.label,
        skinfold_sum_4_mm: round(skinfoldSum4, 1),
      },
    });
  }

  if (equationCode === 'faulkner_1966') {
    const skinfoldSum4 = rawValues.skinfold_triceps_mm + rawValues.skinfold_subscapular_mm + rawValues.skinfold_supraspinale_mm + rawValues.skinfold_abdominal_mm;
    return bodyCompositionResult(rawValues, context, equationMeta, {
      body_fat_percent: 5.783 + (0.153 * skinfoldSum4),
      extra: { skinfold_sum_4_mm: round(skinfoldSum4, 1) },
    });
  }

  if (equationCode === 'jackson_pollock_1975') {
    const skinfoldSum4 = rawValues.skinfold_abdominal_mm + rawValues.skinfold_triceps_mm + rawValues.skinfold_front_thigh_mm + rawValues.skinfold_iliac_crest_mm;
    const bodyFatPercent = sex === 'female'
      ? (0.29669 * skinfoldSum4) - (0.00043 * (skinfoldSum4 ** 2)) + (0.02963 * ageYears) + 1.4072
      : (0.29288 * skinfoldSum4) - (0.0005 * (skinfoldSum4 ** 2)) + (0.15845 * ageYears) - 5.76377;
    return bodyCompositionResult(rawValues, context, equationMeta, {
      body_fat_percent: bodyFatPercent,
      extra: { skinfold_sum_4_mm: round(skinfoldSum4, 1) },
    });
  }

  if (equationCode === 'katch_mcardle_1973') {
    const bodyDensity = sex === 'female'
      ? 1.09246 - (0.00049 * rawValues.skinfold_subscapular_mm) - (0.00075 * rawValues.skinfold_iliac_crest_mm) + (0.00710 * rawValues.breadth_humerus_cm) - (0.00121 * rawValues.thigh_cm)
      : 1.09665 - (0.00103 * rawValues.skinfold_triceps_mm) - (0.00056 * rawValues.skinfold_subscapular_mm) - (0.00054 * rawValues.skinfold_abdominal_mm);
    return bodyCompositionResult(rawValues, context, equationMeta, {
      body_density: bodyDensity,
      body_fat_percent: siriBodyFatPercent(bodyDensity),
    });
  }

  if (equationCode === 'sloan_1962') {
    const bodyDensity = sex === 'female'
      ? 1.0764 - (0.00081 * rawValues.skinfold_iliac_crest_mm) - (0.00088 * rawValues.skinfold_triceps_mm)
      : 1.1043 - (0.001327 * rawValues.skinfold_front_thigh_mm) - (0.00131 * rawValues.skinfold_subscapular_mm);
    return bodyCompositionResult(rawValues, context, equationMeta, {
      body_density: bodyDensity,
      body_fat_percent: siriBodyFatPercent(bodyDensity),
    });
  }

  if (equationCode === 'withers_1987') {
    const bodyDensity = sex === 'female'
      ? 1.17484 - (0.07229 * Math.log10(rawValues.skinfold_triceps_mm + rawValues.skinfold_subscapular_mm + rawValues.skinfold_supraspinale_mm + rawValues.skinfold_medial_calf_mm))
      : 1.0988 - (0.0004 * (rawValues.skinfold_triceps_mm + rawValues.skinfold_subscapular_mm + rawValues.skinfold_biceps_mm + rawValues.skinfold_supraspinale_mm + rawValues.skinfold_abdominal_mm + rawValues.skinfold_front_thigh_mm + rawValues.skinfold_medial_calf_mm));
    return bodyCompositionResult(rawValues, context, equationMeta, {
      body_density: bodyDensity,
      body_fat_percent: siriBodyFatPercent(bodyDensity),
    });
  }

  if (equationCode === 'yuhasz_carter_1982') {
    const skinfoldSum6 = rawValues.skinfold_triceps_mm + rawValues.skinfold_subscapular_mm + rawValues.skinfold_supraspinale_mm + rawValues.skinfold_abdominal_mm + rawValues.skinfold_front_thigh_mm + rawValues.skinfold_medial_calf_mm;
    const bodyFatPercent = sex === 'female'
      ? (0.1548 * skinfoldSum6) + 3.58
      : (0.1051 * skinfoldSum6) + 2.585;
    return bodyCompositionResult(rawValues, context, equationMeta, {
      body_fat_percent: bodyFatPercent,
      extra: { skinfold_sum_6_mm: round(skinfoldSum6, 1) },
    });
  }

  if (equationCode === 'slaughter_1988') {
    const skinfoldSum2 = rawValues.skinfold_triceps_mm + rawValues.skinfold_subscapular_mm;
    const bodyFatPercent = skinfoldSum2 > 35
      ? (sex === 'female' ? (0.546 * skinfoldSum2) + 9.7 : (0.783 * skinfoldSum2) + 1.6)
      : (sex === 'female' ? (1.33 * skinfoldSum2) - (0.013 * (skinfoldSum2 ** 2)) - 2.5 : (1.21 * skinfoldSum2) - (0.008 * (skinfoldSum2 ** 2)) - 1.7);
    return bodyCompositionResult(rawValues, context, equationMeta, {
      body_fat_percent: bodyFatPercent,
      extra: {
        skinfold_sum_2_mm: round(skinfoldSum2, 1),
        applicability_note: 'Ecuación validada originalmente en población juvenil; interpretar en adultos como estimación orientativa.',
      },
    });
  }

  return null;
}

function positiveNumber(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function correctedGirthCm(girthCm, skinfoldMm) {
  if (!Number.isFinite(girthCm) || !Number.isFinite(skinfoldMm)) return null;
  const corrected = girthCm - ((Math.PI * skinfoldMm) / 10);
  return corrected > 0 ? corrected : null;
}

function kerrSkinSurfaceConstant(sex, ageYears) {
  if (!Number.isFinite(ageYears)) return null;
  if (Number.isFinite(ageYears) && ageYears < 12) return 70.691;
  if (sex === 'male') return 68.308;
  if (sex === 'female') return 73.704;
  return null;
}

function kerrSkinThicknessMm(sex) {
  if (sex === 'male') return 2.07;
  if (sex === 'female') return 1.96;
  return null;
}

function percentOfWeight(value, weight) {
  return Number.isFinite(value) && Number.isFinite(weight) && weight > 0
    ? round((value / weight) * 100, 1)
    : null;
}

function calculateKerrRossFiveComponent(rawValues = {}, context = {}) {
  const sex = normalizeSexForBodyComposition(context.sex);
  const ageYears = normalizeAgeYears(context.age_years);
  const weight = positiveNumber(rawValues.weight_kg);
  const height = positiveNumber(rawValues.stature_cm);
  const sittingHeight = positiveNumber(rawValues.sitting_height_cm);
  const head = positiveNumber(rawValues.head_cm);
  const triceps = positiveNumber(rawValues.skinfold_triceps_mm);
  const subscapular = positiveNumber(rawValues.skinfold_subscapular_mm);
  const supraspinale = positiveNumber(rawValues.skinfold_supraspinale_mm);
  const abdominal = positiveNumber(rawValues.skinfold_abdominal_mm);
  const frontThighSkinfold = positiveNumber(rawValues.skinfold_front_thigh_mm);
  const medialCalf = positiveNumber(rawValues.skinfold_medial_calf_mm);
  const armRelaxed = positiveNumber(rawValues.arm_relaxed_cm);
  const forearm = positiveNumber(rawValues.forearm_cm);
  const thigh = positiveNumber(rawValues.thigh_cm);
  const chest = positiveNumber(rawValues.chest_cm);
  const waist = positiveNumber(rawValues.waist_cm);
  const calf = positiveNumber(rawValues.calf_cm);
  const biacromial = positiveNumber(rawValues.breadth_biacromial_cm);
  const biiliocristal = positiveNumber(rawValues.breadth_biiliocristal_cm);
  const humerus = positiveNumber(rawValues.breadth_humerus_cm);
  const femur = positiveNumber(rawValues.breadth_femur_cm);
  const chestAp = positiveNumber(rawValues.depth_chest_ap_cm);
  const chestTransverse = positiveNumber(rawValues.breadth_chest_transverse_cm);
  const skinSurfaceConstant = kerrSkinSurfaceConstant(sex, ageYears);
  const skinThickness = kerrSkinThicknessMm(sex);

  if (![
    weight,
    height,
    sittingHeight,
    head,
    triceps,
    subscapular,
    supraspinale,
    abdominal,
    frontThighSkinfold,
    medialCalf,
    armRelaxed,
    forearm,
    thigh,
    chest,
    waist,
    calf,
    biacromial,
    biiliocristal,
    humerus,
    femur,
    chestAp,
    chestTransverse,
    skinSurfaceConstant,
    skinThickness,
  ].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }

  const heightRatio = 170.18 / height;
  const sittingHeightRatio = 89.92 / sittingHeight;
  const surfaceAreaM2 = (skinSurfaceConstant * (weight ** 0.425) * (height ** 0.725)) / 10000;
  const skinMassKg = surfaceAreaM2 * skinThickness * 1.05;

  const adiposeSkinfoldSum = triceps + subscapular + supraspinale + abdominal + frontThighSkinfold + medialCalf;
  const adiposeZ = ((adiposeSkinfoldSum * heightRatio) - 116.41) / 34.79;
  const adiposeMassKg = ((adiposeZ * 5.85) + 25.6) / (heightRatio ** 3);

  const headBoneZ = (head - 56.0) / 1.44;
  const headBoneMassKg = (headBoneZ * 0.18) + 1.20;
  const bodyBoneSum = biacromial + biiliocristal + (2 * humerus) + (2 * femur);
  const bodyBoneZ = ((bodyBoneSum * heightRatio) - 98.88) / 5.33;
  const bodyBoneMassKg = ((bodyBoneZ * 1.34) + 6.70) / (heightRatio ** 3);
  const boneMassKg = headBoneMassKg + bodyBoneMassKg;

  const correctedArm = correctedGirthCm(armRelaxed, triceps);
  const correctedThigh = correctedGirthCm(thigh, frontThighSkinfold);
  const correctedCalf = correctedGirthCm(calf, medialCalf);
  const correctedChest = correctedGirthCm(chest, subscapular);
  const correctedWaist = correctedGirthCm(waist, abdominal);
  if (![correctedArm, correctedThigh, correctedCalf, correctedChest, correctedWaist]
    .every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }

  const muscleGirthSum = correctedArm + forearm + correctedThigh + correctedCalf + correctedChest;
  const muscleZ = ((muscleGirthSum * heightRatio) - 207.21) / 13.74;
  const muscleMassKg = ((muscleZ * 5.4) + 24.5) / (heightRatio ** 3);

  const residualSum = chestAp + chestTransverse + correctedWaist;
  const residualZ = ((residualSum * sittingHeightRatio) - 109.35) / 7.08;
  const residualMassKg = ((residualZ * 1.24) + 6.10) / (sittingHeightRatio ** 3);
  const predictedBodyMassKg = skinMassKg + adiposeMassKg + boneMassKg + muscleMassKg + residualMassKg;
  const predictionErrorKg = predictedBodyMassKg - weight;

  return {
    method: 'Kerr-Ross five-component body mass fractionation',
    sex,
    age_years: ageYears,
    skin_mass_kg: round(skinMassKg, 1),
    adipose_mass_kg: round(adiposeMassKg, 1),
    muscle_mass_kg: round(muscleMassKg, 1),
    bone_mass_kg: round(boneMassKg, 1),
    residual_mass_kg: round(residualMassKg, 1),
    predicted_body_mass_kg: round(predictedBodyMassKg, 1),
    prediction_error_kg: round(predictionErrorKg, 1),
    prediction_error_percent: round((predictionErrorKg / weight) * 100, 1),
    predicted_to_scale_ratio: round(predictedBodyMassKg / weight, 3),
    skin_percent_of_body_mass: percentOfWeight(skinMassKg, weight),
    adipose_percent_of_body_mass: percentOfWeight(adiposeMassKg, weight),
    muscle_percent_of_body_mass: percentOfWeight(muscleMassKg, weight),
    bone_percent_of_body_mass: percentOfWeight(boneMassKg, weight),
    residual_percent_of_body_mass: percentOfWeight(residualMassKg, weight),
    phantom_z: {
      adipose: round(adiposeZ, 2),
      head_bone: round(headBoneZ, 2),
      body_bone: round(bodyBoneZ, 2),
      muscle: round(muscleZ, 2),
      residual: round(residualZ, 2),
    },
    input_fields: [
      'weight_kg',
      'stature_cm',
      'sitting_height_cm',
      'head_cm',
      'skinfold_triceps_mm',
      'skinfold_subscapular_mm',
      'skinfold_supraspinale_mm',
      'skinfold_abdominal_mm',
      'skinfold_front_thigh_mm',
      'skinfold_medial_calf_mm',
      'arm_relaxed_cm',
      'forearm_cm',
      'thigh_cm',
      'chest_cm',
      'waist_cm',
      'calf_cm',
      'breadth_biacromial_cm',
      'breadth_biiliocristal_cm',
      'breadth_humerus_cm',
      'breadth_femur_cm',
      'depth_chest_ap_cm',
      'breadth_chest_transverse_cm',
    ],
    source: 'Kerr 1988 / Ross-Kerr five-component fractionation',
  };
}

function calculateNutritionValues(rawValues = {}, profileCode = 'quick', context = {}, options = {}) {
  const weight = rawValues.weight_kg;
  const height = rawValues.stature_cm;
  const waist = rawValues.waist_cm;
  const hip = rawValues.hip_cm;
  const triceps = rawValues.skinfold_triceps_mm;
  const medialCalf = rawValues.skinfold_medial_calf_mm;
  const skinfoldFields = Object.keys(FIELD_DEFINITIONS).filter((field) => field.startsWith('skinfold_'));
  const skinfoldValues = skinfoldFields
    .map((field) => rawValues[field])
    .filter((value) => Number.isFinite(value));
  const skinfoldSum = skinfoldValues.length ? skinfoldValues.reduce((sum, value) => sum + value, 0) : null;
  const armFlexed = rawValues.arm_flexed_tensed_cm;
  const calf = rawValues.calf_cm;

  return {
    formula_version: FORMULA_VERSION,
    profile_code: profileCode,
    bmi: Number.isFinite(weight) && Number.isFinite(height) && height > 0
      ? round(weight / ((height / 100) ** 2), 1)
      : null,
    waist_hip_ratio: Number.isFinite(waist) && Number.isFinite(hip) && hip > 0
      ? round(waist / hip, 2)
      : null,
    skinfold_sum_mm: skinfoldSum !== null ? round(skinfoldSum, 1) : null,
    corrected_arm_girth_cm: Number.isFinite(armFlexed) && Number.isFinite(triceps)
      ? round(armFlexed - (triceps / 10), 1)
      : null,
    corrected_calf_girth_cm: Number.isFinite(calf) && Number.isFinite(medialCalf)
      ? round(calf - (medialCalf / 10), 1)
      : null,
    somatotype: profileCode === 'express_isak' ? calculateSomatotype(rawValues) : null,
    body_composition: profileCode === 'express_isak' ? calculateBodyComposition(rawValues, context, options) : null,
    body_composition_meta: profileCode === 'express_isak'
      ? bodyCompositionEquationMeta(selectedFatMassEquationCodeFromOptions(options), normalizeSexForBodyComposition(context.sex))
      : null,
    body_fractionation: profileCode === 'express_isak' ? calculateKerrRossFiveComponent(rawValues, context) : null,
  };
}

function measurementToJson(row, clinicalPhotos = []) {
  if (!row) return null;
  const plain = typeof row.toJSON === 'function' ? row.toJSON() : row;
  const photos = Array.isArray(clinicalPhotos) ? clinicalPhotos : [];
  return {
    id: plain.id,
    patient_id: plain.patient_id,
    clinic_id: plain.clinic_id,
    professional_id: plain.professional_id,
    appointment_id: plain.appointment_id,
    treatment_id: plain.treatment_id,
    profile_code: plain.profile_code,
    measured_at: plain.measured_at,
    raw_values: plain.raw_values_json || plain.raw_values || {},
    calculated_values: plain.calculated_values_json || plain.calculated_values || {},
    formula_version: plain.formula_version || FORMULA_VERSION,
    quality_flags: plain.quality_flags_json || plain.quality_flags || [],
    notes: plain.notes || '',
    clinical_photos: photos,
    clinical_photo_count: photos.length,
    created_at: plain.created_at,
    updated_at: plain.updated_at,
  };
}

function clinicalPhotoAssetToJson(asset) {
  if (!asset) return null;
  const plain = typeof asset.toJSON === 'function' ? asset.toJSON() : asset;
  const metadata = plain.metadata && typeof plain.metadata === 'object' ? plain.metadata : {};
  return {
    id: plain.id,
    public_id: plain.public_id,
    measurement_id: toIntOrNull(plain.owner_id),
    patient_id: plain.patient_id,
    clinic_id: plain.clinic_id,
    purpose: plain.purpose,
    content_type: plain.content_type,
    size_bytes: Number(plain.size_bytes || 0),
    original_filename: plain.original_filename || null,
    caption: metadata.caption || null,
    measured_at: metadata.measured_at || null,
    created_by: plain.created_by || null,
    created_at: plain.created_at,
    private_storage: {
      sensitivity: plain.sensitivity || 'clinical_private',
      provider: plain.provider || 'local_private',
      public_media: false,
    },
  };
}

async function listNutritionPhotoAssetsForMeasurements(patientId, measurementIds = []) {
  if (!db.ClinicalPrivateAsset || !patientId || !measurementIds.length) return [];
  return db.ClinicalPrivateAsset.findAll({
    where: {
      patient_id: Number(patientId),
      owner_type: 'patient_nutrition_measurement',
      owner_id: { [Op.in]: measurementIds.map((id) => String(id)) },
      purpose: 'nutrition_clinical_photo',
      status: 'active',
    },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: Math.max(100, measurementIds.length * 10),
  });
}

function groupClinicalPhotosByMeasurement(assets = []) {
  const grouped = new Map();
  (assets || []).forEach((asset) => {
    const json = clinicalPhotoAssetToJson(asset);
    if (!json?.measurement_id) return;
    const list = grouped.get(json.measurement_id) || [];
    list.push(json);
    grouped.set(json.measurement_id, list);
  });
  return grouped;
}

function buildEvolution(measurements = []) {
  const chronological = [...measurements].reverse().map(measurementToJson);
  return chronological.map((item, index) => {
    const previous = chronological[index - 1] || null;
    const weight = item.raw_values.weight_kg ?? null;
    const waist = item.raw_values.waist_cm ?? null;
    return {
      measurement_id: item.id,
      measured_at: item.measured_at,
      profile_code: item.profile_code,
      weight_kg: weight,
      waist_cm: waist,
      hip_cm: item.raw_values.hip_cm ?? null,
      skinfold_sum_mm: item.calculated_values.skinfold_sum_mm ?? null,
      bmi: item.calculated_values.bmi ?? null,
      body_fat_percent: item.calculated_values.body_composition?.body_fat_percent ?? null,
      delta_weight_kg: previous && Number.isFinite(weight) && Number.isFinite(previous.raw_values.weight_kg)
        ? round(weight - previous.raw_values.weight_kg, 1)
        : null,
      delta_waist_cm: previous && Number.isFinite(waist) && Number.isFinite(previous.raw_values.waist_cm)
        ? round(waist - previous.raw_values.waist_cm, 1)
        : null,
    };
  });
}

function getProjectionMetricValue(measurement, metricDefinition) {
  if (!measurement || !metricDefinition) return null;
  if (metricDefinition.source === 'raw_values') {
    return measurement.raw_values?.[metricDefinition.key] ?? null;
  }
  if (metricDefinition.source === 'calculated_values') {
    return measurement.calculated_values?.[metricDefinition.key] ?? null;
  }
  if (metricDefinition.source === 'body_composition') {
    return measurement.calculated_values?.body_composition?.[metricDefinition.key] ?? null;
  }
  if (metricDefinition.source === 'body_fractionation') {
    return measurement.calculated_values?.body_fractionation?.[metricDefinition.key] ?? null;
  }
  return null;
}

function buildProjectionMetric(chronologicalMeasurements = [], metricDefinition) {
  const usable = chronologicalMeasurements
    .map((measurement) => ({
      measurement,
      value: getProjectionMetricValue(measurement, metricDefinition),
    }))
    .filter((item) => Number.isFinite(item.value));

  if (usable.length < 2) return null;

  const previous = usable[usable.length - 2];
  const current = usable[usable.length - 1];
  const previousDate = new Date(previous.measurement.measured_at).getTime();
  const currentDate = new Date(current.measurement.measured_at).getTime();
  const weeks = (currentDate - previousDate) / (1000 * 60 * 60 * 24 * 7);
  if (!Number.isFinite(weeks) || weeks <= 0) return null;

  const changePerWeek = (current.value - previous.value) / weeks;
  return {
    key: metricDefinition.key,
    label: metricDefinition.label,
    unit: metricDefinition.unit,
    previous_measurement_id: previous.measurement.id,
    current_measurement_id: current.measurement.id,
    previous_measured_at: previous.measurement.measured_at,
    current_measured_at: current.measurement.measured_at,
    observed_weeks: round(weeks, 1),
    previous_value: round(previous.value, metricDefinition.decimals),
    current_value: round(current.value, metricDefinition.decimals),
    change_per_week: round(changePerWeek, 2),
    projected_8_week_value: round(current.value + (changePerWeek * 8), metricDefinition.decimals),
  };
}

function buildProjection(measurements = []) {
  const chronological = [...measurements].reverse().map(measurementToJson);
  const metricProjections = PROJECTION_METRIC_DEFINITIONS
    .map((metricDefinition) => buildProjectionMetric(chronological, metricDefinition))
    .filter(Boolean);

  if (!metricProjections.length) {
    return {
      available: false,
      reason: 'need_two_measurements',
      metric_projections: [],
    };
  }

  const projectionByKey = new Map(metricProjections.map((projection) => [projection.key, projection]));
  const primaryProjection = projectionByKey.get('weight_kg') || metricProjections[0];

  return {
    available: true,
    based_on_measurement_ids: [primaryProjection.previous_measurement_id, primaryProjection.current_measurement_id],
    observed_weeks: primaryProjection.observed_weeks,
    metric_projections: metricProjections,
    weight_change_per_week_kg: projectionByKey.get('weight_kg')?.change_per_week ?? null,
    waist_change_per_week_cm: projectionByKey.get('waist_cm')?.change_per_week ?? null,
    skinfold_sum_change_per_week_mm: projectionByKey.get('skinfold_sum_mm')?.change_per_week ?? null,
    body_fat_change_per_week_percent: projectionByKey.get('body_fat_percent')?.change_per_week ?? null,
    adipose_mass_change_per_week_kg: projectionByKey.get('adipose_mass_kg')?.change_per_week ?? null,
    muscle_mass_change_per_week_kg: projectionByKey.get('muscle_mass_kg')?.change_per_week ?? null,
    projected_8_week_weight_kg: projectionByKey.get('weight_kg')?.projected_8_week_value ?? null,
    projected_8_week_waist_cm: projectionByKey.get('waist_cm')?.projected_8_week_value ?? null,
    projected_8_week_skinfold_sum_mm: projectionByKey.get('skinfold_sum_mm')?.projected_8_week_value ?? null,
    projected_8_week_body_fat_percent: projectionByKey.get('body_fat_percent')?.projected_8_week_value ?? null,
    projected_8_week_adipose_mass_kg: projectionByKey.get('adipose_mass_kg')?.projected_8_week_value ?? null,
    projected_8_week_muscle_mass_kg: projectionByKey.get('muscle_mass_kg')?.projected_8_week_value ?? null,
  };
}

function buildProjectionForMeasurement(measurements = [], measurementId) {
  const chronologicalRows = [...measurements].reverse();
  const targetIndex = chronologicalRows.findIndex((item) => Number(measurementToJson(item)?.id) === Number(measurementId));
  if (targetIndex < 0) {
    return {
      available: false,
      reason: 'measurement_not_found',
    };
  }
  return buildProjection(chronologicalRows.slice(0, targetIndex + 1).reverse());
}

function getReportMetricValue(measurement, metricDefinition) {
  if (!measurement || !metricDefinition) return null;
  const calculatedValues = measurement.calculated_values || {};
  if (metricDefinition.source === 'raw_values') {
    return measurement.raw_values?.[metricDefinition.key] ?? null;
  }
  if (metricDefinition.source === 'calculated_values') {
    return calculatedValues[metricDefinition.key] ?? null;
  }
  if (metricDefinition.source === 'somatotype') {
    return calculatedValues.somatotype?.[metricDefinition.key] ?? null;
  }
  if (metricDefinition.source === 'body_composition') {
    return calculatedValues.body_composition?.[metricDefinition.key] ?? null;
  }
  if (metricDefinition.source === 'body_fractionation') {
    return calculatedValues.body_fractionation?.[metricDefinition.key] ?? null;
  }
  return null;
}

function normalizeMetricValue(value, decimals = 1) {
  if (!Number.isFinite(value)) return value ?? null;
  return round(value, decimals);
}

function buildReportMetric(measurement, previousMeasurement, metricDefinition) {
  const value = getReportMetricValue(measurement, metricDefinition);
  if (value === null || value === undefined || value === '') return null;

  const previousValue = getReportMetricValue(previousMeasurement, metricDefinition);
  const numericValue = Number(value);
  const numericPreviousValue = Number(previousValue);
  const canCompare = Number.isFinite(numericValue) && Number.isFinite(numericPreviousValue);
  const delta = canCompare ? round(numericValue - numericPreviousValue, metricDefinition.decimals) : null;

  return {
    key: metricDefinition.key,
    label: metricDefinition.label,
    unit: metricDefinition.unit,
    section: metricDefinition.section,
    value: normalizeMetricValue(value, metricDefinition.decimals),
    previous_value: canCompare ? normalizeMetricValue(previousValue, metricDefinition.decimals) : null,
    delta,
    trend: delta === null
      ? 'not_comparable'
      : Math.abs(delta) < (metricDefinition.decimals === 2 ? 0.01 : 0.05)
        ? 'stable'
        : delta > 0
          ? 'up'
          : 'down',
  };
}

function buildReportSections(metrics = []) {
  return Object.entries(REPORT_SECTION_DEFINITIONS)
    .map(([key, title]) => ({
      key,
      title,
      metrics: metrics.filter((metric) => metric.section === key),
    }))
    .filter((section) => section.metrics.length);
}

function buildMeasurementComparison(measurement, previousMeasurement, metrics = []) {
  if (!measurement || !previousMeasurement) {
    return {
      available: false,
      reason: 'need_previous_measurement',
    };
  }

  const measuredAt = new Date(measurement.measured_at).getTime();
  const previousMeasuredAt = new Date(previousMeasurement.measured_at).getTime();
  const daysBetween = (measuredAt - previousMeasuredAt) / (1000 * 60 * 60 * 24);
  const comparableMetrics = metrics
    .filter((metric) => metric.delta !== null && metric.delta !== undefined)
    .map((metric) => ({
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      value: metric.value,
      previous_value: metric.previous_value,
      delta: metric.delta,
      trend: metric.trend,
    }));

  if (!comparableMetrics.length) {
    return {
      available: false,
      reason: 'no_comparable_metrics',
      previous_measurement_id: previousMeasurement.id,
      previous_measured_at: previousMeasurement.measured_at,
    };
  }

  return {
    available: true,
    previous_measurement_id: previousMeasurement.id,
    previous_measured_at: previousMeasurement.measured_at,
    days_between: Number.isFinite(daysBetween) ? round(daysBetween, 0) : null,
    metrics: comparableMetrics,
  };
}

function buildReportNarrative(measurement, comparison, metrics = []) {
  const notes = [];
  const rawValues = measurement.raw_values || {};
  const skinfoldCount = Object.keys(rawValues)
    .filter((key) => key.startsWith('skinfold_') && Number.isFinite(rawValues[key]))
    .length;

  if (measurement.profile_code === 'express_isak') {
    notes.push(skinfoldCount >= 8
      ? 'Perfil completo con los 8 pliegues antropométricos registrados.'
      : `Perfil completo parcial con ${skinfoldCount} de 8 pliegues registrados.`);
    if (measurement.calculated_values?.body_composition) {
      const equationLabel = measurement.calculated_values.body_composition.equation_label || 'la ecuación seleccionada';
      notes.push(`Composición corporal estimada con ${equationLabel}; debe interpretarse como estimación antropométrica.`);
    } else {
      const equationLabel = measurement.calculated_values?.body_composition_meta?.equation_label || 'la ecuación seleccionada';
      notes.push(`La composición corporal estimada con ${equationLabel} requiere completar sus datos de entrada y el contexto del paciente.`);
    }
    if (measurement.calculated_values?.body_fractionation) {
      notes.push('Fraccionamiento Kerr-Ross disponible: piel, adiposo, músculo, hueso y residual con táctica Phantom.');
    } else {
      notes.push('El fraccionamiento Kerr-Ross requiere el bloque avanzado completo de perímetros, diámetros, altura sentado y datos personales.');
    }
  } else {
    notes.push('Perfil Express para seguimiento de consulta.');
  }

  if (comparison?.available) {
    const weightMetric = comparison.metrics.find((metric) => metric.key === 'weight_kg');
    const waistMetric = comparison.metrics.find((metric) => metric.key === 'waist_cm');
    const changes = [weightMetric, waistMetric]
      .filter(Boolean)
      .map((metric) => `${metric.label.toLowerCase()} ${metric.delta > 0 ? '+' : ''}${metric.delta}${metric.unit ? ` ${metric.unit}` : ''}`);
    notes.push(changes.length
      ? `Comparado con la medición anterior: ${changes.join(', ')}.`
      : 'Comparativa disponible frente a la medición anterior.');
  } else if (comparison?.reason === 'comparison_disabled') {
    notes.push('Informe generado sin comparación temporal por selección del usuario.');
  } else {
    notes.push('Registra otra medición en una fecha distinta para activar la comparativa temporal.');
  }

  if (measurement.quality_flags?.length) {
    notes.push('Hay medidas fuera del rango esperado; conviene revisarlas antes de entregar el informe.');
  }

  if (!metrics.some((metric) => metric.section === 'somatotype')) {
    notes.push('El somatotipo requiere el perfil completo.');
  }

  return notes;
}

function buildReportForMeasurement(measurement = {}, previousMeasurement = null, fieldDefinitions = FIELD_DEFINITIONS, options = {}) {
  if (!measurement?.id) return null;
  const calculationProfile = options.calculationProfile ||
    calculationProfileForFatMassEquation(measurement.calculated_values?.body_composition_meta?.equation_code);
  const metrics = REPORT_METRIC_DEFINITIONS
    .map((metricDefinition) => buildReportMetric(measurement, previousMeasurement, metricDefinition))
    .filter(Boolean);
  if (!metrics.length) return null;

  const comparison = previousMeasurement
    ? buildMeasurementComparison(measurement, previousMeasurement, metrics)
    : { available: false, reason: options.comparisonReason || 'need_previous_measurement', metrics: [] };
  const calculationTrace = buildCalculationTrace(measurement, fieldDefinitions);
  return {
    id: `nutrition-report-${measurement.id}`,
    measurement_id: measurement.id,
    report_type: measurement.profile_code === 'express_isak' ? 'express_isak' : 'quick_summary',
    title: measurement.profile_code === 'express_isak' ? 'Informe de antropometría completa' : 'Informe express nutricional',
    created_at: measurement.measured_at,
    formula_version: measurement.formula_version,
    calculation_profile: calculationProfile,
    formula_references: formulaReferencesForProfile(measurement.profile_code, calculationProfile),
    profile_code: measurement.profile_code,
    quality_flags: measurement.quality_flags || [],
    storage_strategy: 'calculated_report_not_persisted',
    clinical_storage: buildClinicalStoragePolicy({
      storageStrategy: 'calculated_report_not_persisted',
      snapshotPersisted: false,
      primary: 'calculated_report',
    }),
    summary: {
      bmi: measurement.calculated_values.bmi,
      waist_hip_ratio: measurement.calculated_values.waist_hip_ratio,
      skinfold_sum_mm: measurement.calculated_values.skinfold_sum_mm,
      somatotype: measurement.calculated_values.somatotype,
      body_composition: measurement.calculated_values.body_composition,
      body_fractionation: measurement.calculated_values.body_fractionation,
      metric_count: metrics.length,
    },
    sections: buildReportSections(metrics),
    comparison,
    calculation_trace: calculationTrace,
    narrative: buildReportNarrative(measurement, comparison, metrics),
  };
}

function buildReports(measurements = [], fieldDefinitions = FIELD_DEFINITIONS) {
  const chronological = [...measurements].reverse().map(measurementToJson);
  return chronological
    .map((measurement, index) => {
      const previousMeasurement = chronological[index - 1] || null;
      return buildReportForMeasurement(measurement, previousMeasurement, fieldDefinitions);
    })
    .filter(Boolean)
    .reverse();
}

function nutritionReportSnapshotToJson(row) {
  if (!row) return null;
  const plain = typeof row.toJSON === 'function' ? row.toJSON() : row;
  const storageStrategy = plain.storage_strategy || 'json_snapshot_printable_on_demand';
  const pdfAssetId = toIntOrNull(plain.pdf_asset_id);
  return {
    id: plain.id,
    public_id: plain.public_id,
    measurement_id: plain.measurement_id,
    patient_id: plain.patient_id,
    clinic_id: plain.clinic_id,
    appointment_id: plain.appointment_id,
    treatment_id: plain.treatment_id,
    report_type: plain.report_type,
    title: displayNutritionText(plain.title) || plain.title,
    status: plain.status,
    formula_version: plain.formula_version,
    snapshot_hash: plain.snapshot_hash,
    pdf_asset_id: pdfAssetId,
    storage_strategy: storageStrategy,
    clinical_storage: buildClinicalStoragePolicy({
      storageStrategy,
      status: plain.status,
      snapshotPersisted: true,
      primary: 'database_snapshot',
      pdfPersisted: Boolean(pdfAssetId),
      pdfAssetId,
      privateBinaryStorage: pdfAssetId ? 'clinical_private_asset' : null,
    }),
    generated_by: plain.generated_by,
    generated_at: plain.generated_at,
    finalized_by: plain.finalized_by || null,
    finalized_at: plain.finalized_at || null,
    created_at: plain.created_at,
    updated_at: plain.updated_at,
  };
}

function reportSnapshotStatusRank(snapshot) {
  const status = String(snapshot?.status || '').trim().toLowerCase();
  if (status === 'final') return 0;
  if (status === 'active') return 1;
  return 2;
}

function shouldPreferNutritionReportSnapshot(candidate, current) {
  if (!current) return true;
  const candidateRank = reportSnapshotStatusRank(candidate);
  const currentRank = reportSnapshotStatusRank(current);
  if (candidateRank !== currentRank) return candidateRank < currentRank;
  const candidateTime = new Date(candidate?.generated_at || candidate?.created_at || 0).getTime();
  const currentTime = new Date(current?.generated_at || current?.created_at || 0).getTime();
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return Number(candidate?.id || 0) > Number(current?.id || 0);
}

function parseSnapshotJson(row) {
  if (!row) return null;
  const plain = typeof row.toJSON === 'function' ? row.toJSON() : row;
  const raw = plain.snapshot_json;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' ? raw : null;
}

function isCurrentNutritionReportSnapshot(row) {
  const snapshot = parseSnapshotJson(row);
  const version = Number(snapshot?.snapshot_version);
  return Number.isFinite(version)
    && version >= NUTRITION_REPORT_SNAPSHOT_VERSION
    && snapshot?.report?.calculation_profile?.code === CALCULATION_PROFILE.code
    && Array.isArray(snapshot?.report?.calculation_trace)
    && snapshot.report.calculation_trace.length > 0
    && snapshot.report.calculation_trace.every((item) => Array.isArray(item?.source_references));
}

function attachReportSnapshots(reports = [], snapshotRows = []) {
  const snapshotsByMeasurement = new Map();
  (snapshotRows || []).forEach((row) => {
    const snapshot = nutritionReportSnapshotToJson(row);
    if (!snapshot || !NUTRITION_REPORT_CURRENT_STATUSES.includes(snapshot.status)) return;
    const key = `${snapshot.measurement_id}:${snapshot.report_type}`;
    const current = snapshotsByMeasurement.get(key);
    if (shouldPreferNutritionReportSnapshot(snapshot, current)) {
      snapshotsByMeasurement.set(key, snapshot);
    }
  });

  return (reports || []).map((report) => {
    const snapshot = snapshotsByMeasurement.get(`${report.measurement_id}:${report.report_type}`);
    if (!snapshot) return report;
    return {
      ...report,
      snapshot,
      snapshot_id: snapshot.id,
      snapshot_public_id: snapshot.public_id,
      snapshot_hash: snapshot.snapshot_hash,
      snapshot_created_at: snapshot.generated_at,
      storage_strategy: snapshot.storage_strategy,
      clinical_storage: snapshot.clinical_storage,
    };
  });
}

async function findCurrentNutritionReportSnapshotsForPatient(patientId) {
  if (!db.PatientNutritionReport || !patientId) return [];
  try {
    return await db.PatientNutritionReport.findAll({
      where: {
        patient_id: patientId,
        status: { [Op.in]: NUTRITION_REPORT_CURRENT_STATUSES },
      },
      order: [['generated_at', 'DESC'], ['id', 'DESC']],
      limit: 100,
    });
  } catch (error) {
    if (isMissingReportTableError(error)) return [];
    throw error;
  }
}

async function findNutritionReportSnapshotByStatus(measurementId, reportType, status) {
  if (!db.PatientNutritionReport || !measurementId) return null;
  try {
    return await db.PatientNutritionReport.findOne({
      where: {
        measurement_id: measurementId,
        status,
        ...(reportType ? { report_type: reportType } : {}),
      },
      order: [['generated_at', 'DESC'], ['id', 'DESC']],
    });
  } catch (error) {
    if (isMissingReportTableError(error)) return null;
    throw error;
  }
}

async function findCurrentNutritionReportSnapshot(measurementId, reportType = null) {
  const finalSnapshot = await findNutritionReportSnapshotByStatus(measurementId, reportType, 'final');
  if (finalSnapshot) return finalSnapshot;
  return findNutritionReportSnapshotByStatus(measurementId, reportType, 'active');
}

function buildNutritionReportSnapshotPayload(reportData, renderedHtml, generatedAt = new Date().toISOString()) {
  const storageStrategy = reportData.meta?.storage_strategy
    || reportData.meta?.storage
    || 'json_snapshot_printable_on_demand';
  const meta = {
    ...(reportData.meta || {}),
    generated_at: generatedAt,
    pdf_strategy: 'json_snapshot_printable_on_demand',
    storage: 'patient_nutrition_report_snapshot',
    clinical_storage: buildClinicalStoragePolicy({
      storageStrategy,
      status: reportData.meta?.document_status,
      snapshotPersisted: true,
      primary: 'database_snapshot',
    }),
  };

  const snapshot = {
    kind: 'nutrition_measurement_report',
    snapshot_version: NUTRITION_REPORT_SNAPSHOT_VERSION,
    patient: reportData.patient,
    treatment: reportData.treatment,
    appointment: reportData.appointment,
    measurement: reportData.measurement,
    previous_measurement: reportData.previous_measurement || null,
    report: reportData.report,
    profile_definitions: reportData.profile_definitions,
    field_definitions: reportData.field_definitions,
    projection: reportData.projection,
    meta,
  };

  return {
    snapshot,
    snapshot_hash: hashSnapshot({ ...snapshot, rendered_html: renderedHtml || '' }),
  };
}

async function findPatient(patientIdentifier) {
  const raw = String(patientIdentifier || '').trim();
  if (!raw) return null;
  const where = /^\d+$/.test(raw)
    ? { id_paciente: Number(raw) }
    : { public_id: raw };
  return db.Paciente.findOne({
    where,
    include: db.Clinica
      ? [{ model: db.Clinica, as: 'clinica', required: false }]
      : [],
  });
}

async function getNutritionTreatments({ clinicId, groupId }) {
  if (!db.Tratamiento || !clinicId) return [];
  const scope = [
    { origen: 'sistema' },
    { clinica_id: clinicId },
  ];
  if (groupId) scope.push({ grupo_clinica_id: groupId });
  const rows = await db.Tratamiento.findAll({
    where: {
      disciplina: 'nutricion',
      activo: true,
      [Op.or]: scope,
    },
    attributes: ['id_tratamiento', 'nombre', 'categoria', 'duracion_min', 'precio_base', 'clinical_config'],
    order: [['nombre', 'ASC']],
    limit: 100,
  });
  return rows.map((row) => {
    const plain = row.toJSON();
    return {
      id: plain.id_tratamiento,
      name: displayNutritionText(plain.nombre) || plain.nombre,
      category: displayNutritionText(plain.categoria) || plain.categoria,
      duration_min: plain.duracion_min,
      price_base: plain.precio_base,
      clinical_config: plain.clinical_config || null,
    };
  });
}

async function getPatientNutritionWorkspace(patientIdentifier) {
  const patient = await findPatient(patientIdentifier);
  if (!patient) {
    const error = new Error('patient_not_found');
    error.status = 404;
    throw error;
  }

  const clinicId = Number(patient.clinica_id);
  const groupId = toIntOrNull(patient.clinica?.grupoClinicaId || patient.clinica?.grupo_clinica_id);
  const nutritionContract = await getNutritionContractSafe();
  const profileDefinitions = profileDefinitionsFromContract(nutritionContract);
  const fieldDefinitions = fieldDefinitionsFromContract(nutritionContract);
  const measurements = await db.PatientNutritionMeasurement.findAll({
    where: { patient_id: patient.id_paciente },
    order: [['measured_at', 'DESC'], ['id', 'DESC']],
    limit: 50,
  });
  const measurementIds = measurements.map((measurement) => Number(measurement.id)).filter(Boolean);
  const photosByMeasurement = groupClinicalPhotosByMeasurement(
    await listNutritionPhotoAssetsForMeasurements(patient.id_paciente, measurementIds),
  );
  const reportSnapshots = await findCurrentNutritionReportSnapshotsForPatient(patient.id_paciente);
  const reports = attachReportSnapshots(buildReports(measurements, fieldDefinitions), reportSnapshots);
  const patientFormulaContext = buildPatientFormulaContext(patient);
  const measurementJsonRows = measurements.map((measurement) => (
    measurementToJson(measurement, photosByMeasurement.get(Number(measurement.id)) || [])
  ));

  return {
    patient: {
      id: patient.id_paciente,
      public_id: patient.public_id,
      name: [patient.nombre, patient.apellidos].filter(Boolean).join(' ').trim(),
      clinic_id: clinicId,
      sex: patientFormulaContext.sex,
      age_years: patientFormulaContext.age_years,
    },
    profiles: profileDefinitions,
    fields: fieldDefinitions,
    treatments: await getNutritionTreatments({ clinicId, groupId }),
    latest: measurementJsonRows[0] || null,
    measurements: measurementJsonRows,
    evolution: buildEvolution(measurements),
    projection: buildProjection(measurements),
    reports,
    meta: {
      formula_version: FORMULA_VERSION,
      calculation_profile: CALCULATION_PROFILE,
      formula_references: FORMULA_REFERENCES.map(({ profiles, ...reference }) => reference),
      measurement_contract_source: 'medical-area-contracts-v1',
      generated_at: new Date().toISOString(),
    },
  };
}

async function findNutritionMeasurementForPatient(patientIdentifier, measurementIdentifier) {
  const patient = await findPatient(patientIdentifier);
  if (!patient) {
    const error = new Error('patient_not_found');
    error.status = 404;
    throw error;
  }
  const measurementId = toIntOrNull(measurementIdentifier);
  if (!measurementId) {
    const error = new Error('measurement_not_found');
    error.status = 404;
    throw error;
  }
  const measurement = await db.PatientNutritionMeasurement.findOne({
    where: {
      id: measurementId,
      patient_id: patient.id_paciente,
    },
  });
  if (!measurement) {
    const error = new Error('measurement_not_found');
    error.status = 404;
    throw error;
  }
  return { patient, measurement };
}

function decodeClinicalPhotoPayload(payload = {}) {
  const raw = String(payload.data_url || payload.dataUrl || payload.base64 || payload.file_data || payload.fileData || '').trim();
  if (!raw) {
    const error = new Error('clinical_photo_payload_required');
    error.status = 400;
    throw error;
  }
  const dataUrlMatch = raw.match(/^data:([^;,]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    return {
      contentType: dataUrlMatch[1].toLowerCase(),
      buffer: Buffer.from(dataUrlMatch[2], 'base64'),
    };
  }
  return {
    contentType: String(payload.content_type || payload.contentType || 'application/octet-stream').trim().toLowerCase(),
    buffer: Buffer.from(raw, 'base64'),
  };
}

async function listNutritionMeasurementClinicalPhotos(patientIdentifier, measurementIdentifier) {
  const { patient, measurement } = await findNutritionMeasurementForPatient(patientIdentifier, measurementIdentifier);
  const assets = await listNutritionPhotoAssetsForMeasurements(patient.id_paciente, [measurement.id]);
  return assets.map(clinicalPhotoAssetToJson).filter(Boolean);
}

async function addNutritionMeasurementClinicalPhoto(patientIdentifier, measurementIdentifier, payload = {}, actorUserId = null) {
  const { patient, measurement } = await findNutritionMeasurementForPatient(patientIdentifier, measurementIdentifier);
  const decoded = decodeClinicalPhotoPayload(payload);
  const asset = await clinicalPrivateStorage.storeClinicalPrivateAsset({
    purpose: 'nutrition_clinical_photo',
    clinicId: measurement.clinic_id || patient.clinica_id,
    patientId: patient.id_paciente,
    ownerType: 'patient_nutrition_measurement',
    ownerId: measurement.id,
    contentType: decoded.contentType,
    buffer: decoded.buffer,
    originalFilename: payload.original_filename || payload.filename || payload.name || null,
    createdBy: actorUserId,
    metadata: {
      caption: payload.caption ? String(payload.caption).trim().slice(0, 500) : null,
      measurement_id: measurement.id,
      measured_at: measurement.measured_at,
      profile_code: measurement.profile_code,
      formula_version: measurement.formula_version || FORMULA_VERSION,
    },
  });
  return clinicalPhotoAssetToJson(asset);
}

async function readNutritionMeasurementClinicalPhoto(patientIdentifier, measurementIdentifier, photoIdentifier) {
  const { patient, measurement } = await findNutritionMeasurementForPatient(patientIdentifier, measurementIdentifier);
  const photoId = toIntOrNull(photoIdentifier);
  if (!photoId) {
    const error = new Error('clinical_photo_not_found');
    error.status = 404;
    throw error;
  }
  const asset = await db.ClinicalPrivateAsset.findOne({
    where: {
      id: photoId,
      patient_id: patient.id_paciente,
      owner_type: 'patient_nutrition_measurement',
      owner_id: String(measurement.id),
      purpose: 'nutrition_clinical_photo',
      status: 'active',
    },
  });
  if (!asset) {
    const error = new Error('clinical_photo_not_found');
    error.status = 404;
    throw error;
  }
  return clinicalPrivateStorage.readClinicalPrivateAsset(asset);
}

async function getPatientNutritionAccessContext(patientIdentifier) {
  const patient = await findPatient(patientIdentifier);
  if (!patient) {
    const error = new Error('patient_not_found');
    error.status = 404;
    throw error;
  }

  return {
    patient_id: patient.id_paciente,
    clinic_id: Number(patient.clinica_id),
    group_id: toIntOrNull(patient.clinica?.grupoClinicaId || patient.clinica?.grupo_clinica_id),
  };
}

async function createNutritionMeasurement(patientIdentifier, payload = {}, actorUserId = null) {
  const patient = await findPatient(patientIdentifier);
  if (!patient) {
    const error = new Error('patient_not_found');
    error.status = 404;
    throw error;
  }

  const profileCode = normalizeProfileCode(payload.profile_code);
  const nutritionContract = await getNutritionContractSafe();
  const profileDefinitions = profileDefinitionsFromContract(nutritionContract);
  const fieldDefinitions = fieldDefinitionsFromContract(nutritionContract);
  const rawValues = normalizeRawValues(payload.raw_values || payload.values || {}, fieldDefinitions);
  const missingRequiredFields = missingRequiredFieldsForProfile(rawValues, profileCode, profileDefinitions, fieldDefinitions);
  if (missingRequiredFields.length) {
    const error = new Error('missing_required_measurement_fields');
    error.status = 400;
    error.details = {
      profile_code: profileCode,
      missing_fields: missingRequiredFields,
    };
    throw error;
  }
  const qualityFlags = qualityFlagsForValues(rawValues, fieldDefinitions);
  const clinicId = toIntOrNull(payload.clinic_id) || Number(patient.clinica_id);
  const measuredAt = payload.measured_at ? new Date(payload.measured_at) : new Date();

  if (!Number.isFinite(measuredAt.getTime())) {
    const error = new Error('invalid_measured_at');
    error.status = 400;
    throw error;
  }
  const calculatedValues = calculateNutritionValues(rawValues, profileCode, buildPatientFormulaContext(patient, measuredAt));

  const row = await db.PatientNutritionMeasurement.create({
    patient_id: patient.id_paciente,
    clinic_id: clinicId,
    professional_id: toIntOrNull(payload.professional_id) || toIntOrNull(actorUserId),
    appointment_id: toIntOrNull(payload.appointment_id),
    treatment_id: toIntOrNull(payload.treatment_id),
    profile_code: profileCode,
    measured_at: measuredAt,
    raw_values_json: rawValues,
    calculated_values_json: calculatedValues,
    formula_version: FORMULA_VERSION,
    quality_flags_json: qualityFlags,
    notes: payload.notes ? String(payload.notes).trim().slice(0, 2000) : null,
    created_by: toIntOrNull(actorUserId),
    updated_by: toIntOrNull(actorUserId),
  });

  const measurement = measurementToJson(row);
  try {
    measurement.report_snapshot = await createNutritionMeasurementReportSnapshot(patient.id_paciente, row.id, actorUserId);
  } catch (error) {
    console.warn('[nutritionWorkspace] report snapshot creation failed', {
      measurement_id: row.id,
      message: error.message,
    });
    measurement.report_snapshot_error = 'report_snapshot_creation_failed';
  }

  return measurement;
}

function hasReportComparisonOverride(options = {}) {
  return Object.prototype.hasOwnProperty.call(options || {}, 'compareMeasurementId');
}

function hasReportFatMassEquationOverride(options = {}) {
  return selectedFatMassEquationCodeFromOptions(options) !== DEFAULT_FAT_MASS_EQUATION_CODE;
}

function measurementForReportCalculation(measurement = {}, patient = null, options = {}) {
  const json = measurementToJson(measurement);
  if (!json) return null;
  const equationCode = selectedFatMassEquationCodeFromOptions(options);
  const context = buildPatientFormulaContext(patient, json.measured_at);
  const calculatedValues = {
    ...(json.calculated_values || {}),
    body_composition: json.profile_code === 'express_isak'
      ? calculateBodyComposition(json.raw_values || {}, context, { fatMassEquationCode: equationCode })
      : null,
    body_composition_meta: json.profile_code === 'express_isak'
      ? bodyCompositionEquationMeta(equationCode, normalizeSexForBodyComposition(context.sex))
      : null,
  };
  return {
    ...json,
    calculated_values: calculatedValues,
  };
}

function resolveReportComparisonRow(measurements = [], measurementRow = null, defaultReport = null, options = {}) {
  if (!measurementRow) return null;
  if (hasReportComparisonOverride(options)) {
    if (options.compareMeasurementId === null) return null;
    const requestedId = toIntOrNull(options.compareMeasurementId);
    if (!requestedId || requestedId === Number(measurementRow.id)) return null;
    const requestedRow = measurements.find((item) => Number(item.id) === Number(requestedId));
    if (!requestedRow) {
      const error = new Error('report_comparison_not_found');
      error.status = 404;
      throw error;
    }
    return requestedRow;
  }

  const defaultPreviousId = Number(defaultReport?.comparison?.previous_measurement_id || 0);
  return defaultPreviousId
    ? measurements.find((item) => Number(item.id) === defaultPreviousId) || null
    : null;
}

function canUseStoredReportSnapshot(options = {}) {
  return isDefaultReportBranding(options) && !hasReportComparisonOverride(options) && !hasReportFatMassEquationOverride(options);
}

async function buildNutritionMeasurementReportData(patientIdentifier, measurementIdentifier, options = {}) {
  const patient = await findPatient(patientIdentifier);
  if (!patient) {
    const error = new Error('patient_not_found');
    error.status = 404;
    throw error;
  }

  const measurementId = toIntOrNull(measurementIdentifier);
  if (!measurementId) {
    const error = new Error('measurement_not_found');
    error.status = 404;
    throw error;
  }

  const measurements = await db.PatientNutritionMeasurement.findAll({
    where: { patient_id: patient.id_paciente },
    order: [['measured_at', 'DESC'], ['id', 'DESC']],
    limit: 50,
  });
  const measurementRow = measurements.find((item) => Number(item.id) === Number(measurementId));
  if (!measurementRow) {
    const error = new Error('measurement_not_found');
    error.status = 404;
    throw error;
  }

  const nutritionContract = await getNutritionContractSafe();
  const profileDefinitions = profileDefinitionsFromContract(nutritionContract);
  const fieldDefinitions = fieldDefinitionsFromContract(nutritionContract);
  const equationCode = selectedFatMassEquationCodeFromOptions(options);
  const calculationProfile = calculationProfileForFatMassEquation(equationCode);
  const reportMeasurements = measurements
    .map((item) => measurementForReportCalculation(item, patient, { fatMassEquationCode: equationCode }))
    .filter(Boolean);
  const measurement = reportMeasurements.find((item) => Number(item.id) === Number(measurementRow.id));
  const report = buildReports(reportMeasurements, fieldDefinitions).find((item) => Number(item.measurement_id) === Number(measurement.id));
  if (!report) {
    const error = new Error('report_not_available');
    error.status = 404;
    throw error;
  }
  const previousMeasurementRow = resolveReportComparisonRow(measurements, measurementRow, report, options);
  const previousMeasurement = previousMeasurementRow
    ? reportMeasurements.find((item) => Number(item.id) === Number(previousMeasurementRow.id)) || measurementForReportCalculation(previousMeasurementRow, patient, { fatMassEquationCode: equationCode })
    : null;
  const effectiveReport = hasReportComparisonOverride(options)
    ? buildReportForMeasurement(measurement, previousMeasurement, fieldDefinitions, { comparisonReason: 'comparison_disabled', calculationProfile })
    : report;

  const treatment = measurement.treatment_id && db.Tratamiento
    ? await db.Tratamiento.findByPk(measurement.treatment_id, {
      attributes: ['id_tratamiento', 'nombre', 'disciplina', 'categoria', 'clinical_config'],
    })
    : null;
  const appointment = measurement.appointment_id && db.CitaPaciente
    ? await db.CitaPaciente.findByPk(measurement.appointment_id, {
      attributes: ['id_cita', 'inicio', 'fin', 'estado', 'doctor_id', 'clinica_id'],
      include: db.Usuario
        ? [{ model: db.Usuario, as: 'doctor', attributes: ['id_usuario', 'nombre', 'apellidos'], required: false }]
        : [],
    })
    : null;
  const patientFormulaContext = buildPatientFormulaContext(patient, measurement.measured_at);

  return {
    patient: {
      id: patient.id_paciente,
      public_id: patient.public_id,
      name: [patient.nombre, patient.apellidos].filter(Boolean).join(' ').trim(),
      clinic_id: Number(patient.clinica_id),
      clinic_name: patient.clinica?.nombre_clinica || '',
      clinic_avatar_url: patient.clinica?.url_avatar || '',
      sex: patientFormulaContext.sex,
      age_years: patientFormulaContext.age_years,
    },
    treatment: treatment?.toJSON ? treatment.toJSON() : treatment,
    appointment: appointment?.toJSON ? appointment.toJSON() : appointment,
    measurement,
    previous_measurement: previousMeasurement,
    report: effectiveReport,
    profile_definitions: profileDefinitions,
    field_definitions: fieldDefinitions,
    projection: buildProjectionForMeasurement(reportMeasurements, measurement.id),
    meta: {
      formula_version: FORMULA_VERSION,
      calculation_profile: calculationProfile,
      formula_references: formulaReferencesForProfile(measurement.profile_code, calculationProfile),
      fat_mass_equation_code: equationCode,
      measurement_contract_source: 'medical-area-contracts-v1',
      generated_at: new Date().toISOString(),
      pdf_strategy: 'json_snapshot_printable_on_demand',
      storage: 'not_persisted',
      clinical_storage: buildClinicalStoragePolicy({
        storageStrategy: 'calculated_report_not_persisted',
        snapshotPersisted: false,
        primary: 'calculated_report',
      }),
    },
  };
}

async function getNutritionMeasurementReport(patientIdentifier, measurementIdentifier) {
  const reportData = await buildNutritionMeasurementReportData(patientIdentifier, measurementIdentifier);
  const snapshot = await findCurrentNutritionReportSnapshot(
    reportData.measurement.id,
    reportData.report.report_type,
  );
  const snapshotJson = nutritionReportSnapshotToJson(snapshot);
  if (!snapshotJson) return reportData;
  return {
    ...reportData,
    report: {
      ...reportData.report,
      snapshot: snapshotJson,
      snapshot_id: snapshotJson.id,
      snapshot_public_id: snapshotJson.public_id,
      snapshot_hash: snapshotJson.snapshot_hash,
      snapshot_created_at: snapshotJson.generated_at,
      storage_strategy: snapshotJson.storage_strategy,
      clinical_storage: snapshotJson.clinical_storage,
    },
    meta: {
      ...reportData.meta,
      storage: snapshotJson.storage_strategy,
      snapshot_hash: snapshotJson.snapshot_hash,
      clinical_storage: snapshotJson.clinical_storage,
    },
  };
}

async function createNutritionMeasurementReportSnapshot(patientIdentifier, measurementIdentifier, actorUserId = null) {
  if (!db.PatientNutritionReport) return null;

  const reportData = await buildNutritionMeasurementReportData(patientIdentifier, measurementIdentifier);
  const finalSnapshot = await findNutritionReportSnapshotByStatus(
    reportData.measurement.id,
    reportData.report.report_type,
    'final',
  );
  if (finalSnapshot) {
    return nutritionReportSnapshotToJson(finalSnapshot);
  }

  const existing = await findNutritionReportSnapshotByStatus(
    reportData.measurement.id,
    reportData.report.report_type,
    'active',
  );
  if (existing && isCurrentNutritionReportSnapshot(existing)) {
    return nutritionReportSnapshotToJson(existing);
  }
  if (existing) {
    existing.status = 'superseded';
    await existing.save();
  }

  const generatedAt = new Date().toISOString();
  const clinicalStorage = buildClinicalStoragePolicy({
    storageStrategy: 'json_snapshot_printable_on_demand',
    status: 'active',
    snapshotPersisted: true,
    primary: 'database_snapshot',
  });
  const normalizedReportData = {
    ...reportData,
    meta: {
      ...reportData.meta,
      generated_at: generatedAt,
      storage: 'patient_nutrition_report_snapshot',
      storage_strategy: 'json_snapshot_printable_on_demand',
      clinical_storage: clinicalStorage,
    },
  };
  const renderedHtml = buildNutritionReportHtml(normalizedReportData);
  const { snapshot, snapshot_hash: snapshotHash } = buildNutritionReportSnapshotPayload(
    normalizedReportData,
    renderedHtml,
    generatedAt,
  );

  try {
    const row = await db.PatientNutritionReport.create({
      public_id: await generateUniqueNutritionReportPublicId(),
      measurement_id: reportData.measurement.id,
      patient_id: reportData.patient.id,
      clinic_id: reportData.patient.clinic_id,
      appointment_id: reportData.measurement.appointment_id || null,
      treatment_id: reportData.measurement.treatment_id || null,
      report_type: reportData.report.report_type,
      title: reportData.report.title,
      status: 'active',
      formula_version: reportData.report.formula_version || FORMULA_VERSION,
      snapshot_json: snapshot,
      snapshot_html: renderedHtml,
      snapshot_hash: snapshotHash,
      pdf_asset_id: null,
      storage_strategy: 'json_snapshot_printable_on_demand',
      generated_by: toIntOrNull(actorUserId),
      generated_at: generatedAt,
    });
    return nutritionReportSnapshotToJson(row);
  } catch (error) {
    if (isMissingReportTableError(error)) return null;
    throw error;
  }
}

async function finalizeNutritionMeasurementReportSnapshot(patientIdentifier, measurementIdentifier, actorUserId = null) {
  if (!db.PatientNutritionReport) return null;

  const reportData = await buildNutritionMeasurementReportData(patientIdentifier, measurementIdentifier);
  const existingFinal = await findNutritionReportSnapshotByStatus(
    reportData.measurement.id,
    reportData.report.report_type,
    'final',
  );
  if (existingFinal) {
    return nutritionReportSnapshotToJson(existingFinal);
  }

  const generatedAt = new Date().toISOString();
  const clinicalStorage = buildClinicalStoragePolicy({
    storageStrategy: 'final_json_snapshot_printable_on_demand',
    status: 'final',
    snapshotPersisted: true,
    primary: 'database_snapshot',
  });
  const normalizedReportData = {
    ...reportData,
    meta: {
      ...reportData.meta,
      generated_at: generatedAt,
      storage: 'patient_nutrition_report_snapshot',
      storage_strategy: 'final_json_snapshot_printable_on_demand',
      clinical_storage: clinicalStorage,
      document_status: 'final',
      finalized_at: generatedAt,
      finalized_by: toIntOrNull(actorUserId),
    },
  };
  const renderedHtml = buildNutritionReportHtml(normalizedReportData);
  const { snapshot, snapshot_hash: snapshotHash } = buildNutritionReportSnapshotPayload(
    normalizedReportData,
    renderedHtml,
    generatedAt,
  );

  try {
    await db.PatientNutritionReport.update(
      { status: 'superseded' },
      {
        where: {
          measurement_id: reportData.measurement.id,
          report_type: reportData.report.report_type,
          status: 'active',
        },
      },
    );
    const row = await db.PatientNutritionReport.create({
      public_id: await generateUniqueNutritionReportPublicId(),
      measurement_id: reportData.measurement.id,
      patient_id: reportData.patient.id,
      clinic_id: reportData.patient.clinic_id,
      appointment_id: reportData.measurement.appointment_id || null,
      treatment_id: reportData.measurement.treatment_id || null,
      report_type: reportData.report.report_type,
      title: reportData.report.title,
      status: 'final',
      formula_version: reportData.report.formula_version || FORMULA_VERSION,
      snapshot_json: snapshot,
      snapshot_html: renderedHtml,
      snapshot_hash: snapshotHash,
      pdf_asset_id: null,
      storage_strategy: 'final_json_snapshot_printable_on_demand',
      generated_by: toIntOrNull(actorUserId),
      generated_at: generatedAt,
      finalized_by: toIntOrNull(actorUserId),
      finalized_at: generatedAt,
    });
    return nutritionReportSnapshotToJson(row);
  } catch (error) {
    if (isMissingReportTableError(error)) return null;
    throw error;
  }
}

function rawMeasurementRows(measurement = {}, profileDefinitions = PROFILE_DEFINITIONS, fieldDefinitions = FIELD_DEFINITIONS) {
  const profile = profileDefinitions.find((item) => item.code === measurement.profile_code) || profileDefinitions[0] || PROFILE_DEFINITIONS[0];
  const rawValues = measurement.raw_values || {};
  return profile.groups.map((group) => ({
    title: group.label,
    fields: group.fields
      .filter((field) => rawValues[field] !== undefined && rawValues[field] !== null && rawValues[field] !== '')
      .map((field) => ({
        key: field,
        label: fieldDefinitions[field]?.label || field,
        unit: fieldDefinitions[field]?.unit || '',
        value: rawValues[field],
        min: fieldDefinitions[field]?.min ?? null,
        max: fieldDefinitions[field]?.max ?? null,
      })),
  })).filter((group) => group.fields.length);
}

function rawFieldRangeMarkerHtml(field = {}) {
  const value = finiteNumber(field.value);
  const min = finiteNumber(field.min);
  const max = finiteNumber(field.max);
  if (value === null || min === null || max === null || max <= min) return '<span class="muted">Sin rango definido</span>';
  const percent = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  const inRange = value >= min && value <= max;
  return `
    <div class="range-wrap">
      <div class="range-track">
        <span class="range-mid"></span>
        <i style="left:${escapeHtml(round(percent, 1))}%"></i>
      </div>
      <div class="range-labels"><span>${escapeHtml(min)}</span><span>${escapeHtml(max)}</span></div>
      <div class="range-status ${inRange ? 'range-ok' : 'range-alert'}">${inRange ? 'Dentro del rango orientativo' : 'Revisar medida'}</div>
    </div>
  `;
}

function buildReportBrandHtml(patient = {}, brandingOptions = {}) {
  const branding = normalizeReportBrandingOptions(brandingOptions);
  if (branding.mode === 'clinic') {
    const clinicName = patient.clinic_name || 'Clínica';
    if (patient.clinic_avatar_url) {
      return `
        <div class="brand brand-with-logo">
          <img src="${escapeHtml(patient.clinic_avatar_url)}" alt="${escapeHtml(clinicName)}">
          <span>${escapeHtml(clinicName)}</span>
        </div>
        <div class="powered-by">Con la tecnología de ClinicaClick</div>
      `;
    }
    return `
      <div class="brand brand-with-logo">
        <span class="brand-initials">${escapeHtml(initialsFromName(clinicName))}</span>
        <span>${escapeHtml(clinicName)}</span>
      </div>
      <div class="powered-by">Con la tecnología de ClinicaClick</div>
    `;
  }
  const logo = clinicaclickLogoDataUri();
  if (logo) {
    return `
      <div class="brand brand-default">
        <img src="${logo}" alt="ClinicaClick">
      </div>
    `;
  }
  return '<div class="brand">ClinicaClick</div>';
}

function buildNutritionReportHtml(reportData, options = {}) {
  const { patient, treatment, appointment, measurement, previous_measurement: previousMeasurement, report, projection, meta } = reportData;
  const brandHtml = buildReportBrandHtml(patient, options);
  const profileLabel = nutritionProfileLabel(measurement.profile_code);
  const isFinalDocument = meta?.document_status === 'final';
  const documentStatusLabel = isFinalDocument ? '' : 'Borrador calculado';
  const documentStatusBadgeHtml = documentStatusLabel
    ? `<span class="pill">${escapeHtml(documentStatusLabel)}</span>`
    : '';
  const clinicalStorage = meta?.clinical_storage || buildClinicalStoragePolicy({
    storageStrategy: meta?.storage_strategy || meta?.storage,
    status: meta?.document_status,
    snapshotPersisted: meta?.storage === 'patient_nutrition_report_snapshot' || isFinalDocument,
    primary: meta?.storage === 'patient_nutrition_report_snapshot' || isFinalDocument
      ? 'database_snapshot'
      : 'calculated_report',
  });
  const comparison = report.comparison || { available: false };
  const projectionVisualHtml = buildProjectionVisualHtml(projection);
  const compositionVisualHtml = buildCompositionVisualHtml(report);
  const comparisonOverviewHtml = buildComparisonOverviewHtml(comparison);
  const distributionVisualHtml = buildDistributionVisualHtml(measurement, previousMeasurement);
  const somatotypeVisualHtml = buildSomatotypeVisualHtml(report, patient);
  const healthIndexesHtml = buildHealthIndexesHtml(measurement, previousMeasurement);
  const reportVisualIntroHtml = buildReportVisualIntroHtml(measurement);
  const calculationProfileHtml = buildCalculationProfileHtml(
    report.calculation_profile || meta?.calculation_profile || CALCULATION_PROFILE,
  );
  const heroMetrics = (report.sections || [])
    .flatMap((section) => section.metrics || [])
    .filter((metric) => ['weight_kg', 'bmi', 'skinfold_sum_mm', 'body_fat_percent'].includes(metric.key))
    .slice(0, 4);
  const heroMetricsHtml = heroMetrics.length ? `
    <section class="hero-metrics">
      ${heroMetrics.map((metric) => `
        <div class="hero-metric">
          <dt>${escapeHtml(metric.label)}</dt>
          <dd>${escapeHtml(formatMetricValue(metric))}</dd>
          ${metric.delta !== null && metric.delta !== undefined ? `
            <span class="delta-pill ${metricTrendClass(metric)}">${escapeHtml(formatDeltaWithPercent(metric))}</span>
          ` : '<span class="delta-pill delta-empty">Sin histórico</span>'}
        </div>
      `).join('')}
    </section>
  ` : '';
  const sectionsHtml = (report.sections || []).map((section) => `
    <section class="card">
      <h2>${escapeHtml(section.title)}</h2>
      <div class="metric-grid">
        ${(section.metrics || []).map((metric) => `
          <div class="metric">
            <dt>${escapeHtml(metric.label)}</dt>
            <dd>${escapeHtml(formatMetricValue(metric))}</dd>
            ${metric.delta !== null && metric.delta !== undefined ? `<span class="delta ${metricTrendClass(metric)}">${escapeHtml(formatDeltaWithPercent(metric))} vs anterior</span>` : ''}
          </div>
        `).join('')}
      </div>
    </section>
  `).join('');
  const comparisonHtml = comparison.available ? `
    <section class="card">
      <h2>Comparativa</h2>
      <p class="muted">Comparado con la medición del ${escapeHtml(formatDate(comparison.previous_measured_at))}${comparison.days_between != null ? ` · ${escapeHtml(comparison.days_between)} días entre mediciones` : ''}.</p>
      <table>
        <thead><tr><th>Métrica</th><th>Anterior</th><th>Actual</th><th>Diferencia</th></tr></thead>
        <tbody>
          ${(comparison.metrics || []).map((metric) => `
            <tr>
              <td>${escapeHtml(metric.label)}</td>
              <td>${escapeHtml(metric.previous_value ?? '-')} ${escapeHtml(metric.unit || '')}</td>
              <td>${escapeHtml(metric.value ?? '-')} ${escapeHtml(metric.unit || '')}</td>
              <td><span class="delta ${metricTrendClass(metric)}">${escapeHtml(formatDeltaWithPercent(metric))}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  ` : `
    <section class="card muted-card">
      <h2>Comparativa</h2>
      <p>No hay una medición anterior comparable para este informe.</p>
    </section>
  `;
  const extraProjectionMetricsHtml = (projection?.metric_projections || [])
    .filter((metric) => !['weight_kg', 'waist_cm'].includes(metric.key))
    .map((metric) => `
        <div class="metric">
          <dt>${escapeHtml(formatProjectionMetricLabel(metric))}</dt>
          <dd>${escapeHtml(formatMetricValue({ value: metric.projected_8_week_value, unit: metric.unit }))}</dd>
          <span class="delta">${escapeHtml(formatDelta({ delta: metric.change_per_week, unit: `${metric.unit}/sem` }))}</span>
        </div>
      `)
    .join('');
  const projectionHtml = projection?.available ? `
    <section class="card">
      <h2>Proyección temporal</h2>
      <p class="muted">Estimación lineal simple basada en ${escapeHtml(projection.observed_weeks)} semanas observadas entre las dos últimas mediciones comparables del informe.</p>
      <div class="metric-grid">
        <div class="metric">
          <dt>Cambio semanal peso</dt>
          <dd>${escapeHtml(formatMetricValue({ value: projection.weight_change_per_week_kg, unit: 'kg' }))}</dd>
        </div>
        <div class="metric">
          <dt>Peso estimado 8 semanas</dt>
          <dd>${escapeHtml(formatMetricValue({ value: projection.projected_8_week_weight_kg, unit: 'kg' }))}</dd>
        </div>
        <div class="metric">
          <dt>Cambio semanal cintura</dt>
          <dd>${escapeHtml(formatMetricValue({ value: projection.waist_change_per_week_cm, unit: 'cm' }))}</dd>
        </div>
        <div class="metric">
          <dt>Cintura estimada 8 semanas</dt>
          <dd>${escapeHtml(formatMetricValue({ value: projection.projected_8_week_waist_cm, unit: 'cm' }))}</dd>
        </div>
        ${extraProjectionMetricsHtml}
      </div>
      <p class="muted small-note">Esta proyección es orientativa y debe interpretarse por el profesional junto al contexto clínico.</p>
    </section>
  ` : `
    <section class="card muted-card">
      <h2>Proyección temporal</h2>
      <p>Se necesitan dos mediciones con peso y fechas distintas para estimar tendencia.</p>
    </section>
  `;
  const rawHtml = rawMeasurementRows(measurement, reportData.profile_definitions, reportData.field_definitions).map((group) => `
    <section class="card">
      <h2>${escapeHtml(group.title)}</h2>
      <table>
        <thead><tr><th>Medida</th><th>Resultado</th><th>Rango orientativo</th></tr></thead>
        <tbody>
          ${group.fields.map((field) => `
            <tr>
              <td>${escapeHtml(field.label)}</td>
              <td>${escapeHtml(field.value)} ${escapeHtml(field.unit)}</td>
              <td>${rawFieldRangeMarkerHtml(field)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  `).join('');
  const narrativeHtml = (report.narrative || []).length
    ? `<section class="card"><h2>Resumen clínico</h2><ul>${report.narrative.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></section>`
    : '';
  const qualityHtml = (report.quality_flags || []).length
    ? `<section class="card warning"><h2>Revisión de datos</h2><ul>${report.quality_flags.map((flag) => `<li>${escapeHtml(flag.message || flag.code)}</li>`).join('')}</ul></section>`
    : '';
  const calculationTrace = report.calculation_trace || [];
  const calculationTraceHtml = calculationTrace.length ? `
    <section class="card">
      <h2>Trazabilidad de cálculo</h2>
      <table>
        <thead><tr><th>Cálculo</th><th>Estado</th><th>Método</th><th>Fuente</th><th>Entradas pendientes</th></tr></thead>
        <tbody>
          ${calculationTrace.map((item) => `
            <tr>
              <td>${escapeHtml(item.label)}</td>
              <td><span class="status ${item.applied ? 'status-ok' : 'status-pending'}">${item.applied ? 'Aplicado' : 'Pendiente'}</span></td>
              <td>${escapeHtml(item.method || item.source || '')}</td>
              <td>${(item.source_references || []).length
                ? item.source_references.map((reference) => reference.url
                  ? `<a href="${escapeHtml(reference.url)}">${escapeHtml(reference.label || reference.source || reference.key)}</a>`
                  : `<span>${escapeHtml(reference.label || reference.source || reference.key)}</span>`).join('<br>')
                : escapeHtml(item.source || '-')}</td>
              <td>${escapeHtml(item.applied ? '-' : (item.missing_input_labels || []).join(', ') || 'Datos insuficientes')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  ` : '';
  const formulaReferences = report.formula_references || meta.formula_references || [];
  const formulaReferencesHtml = formulaReferences.length ? `
    <section class="card muted-card">
      <h2>Fuentes de cálculo</h2>
      <ul>
        ${formulaReferences.map((reference) => `
          <li>
            <strong>${escapeHtml(reference.label)}</strong>: ${escapeHtml(reference.description || reference.source || '')}
            ${reference.url ? `<br><a href="${escapeHtml(reference.url)}">${escapeHtml(reference.source || reference.url)}</a>` : `<br><span class="muted">${escapeHtml(reference.source || '')}</span>`}
          </li>
        `).join('')}
      </ul>
    </section>
  ` : '';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(report.title)} · ${escapeHtml(patient.name)}</title>
  <style>
    @page { size: A4; margin: 16mm; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f8fafc; color: #0f172a; font-family: Inter, Arial, sans-serif; font-size: 13px; line-height: 1.45; }
    .page { max-width: 920px; margin: 0 auto; padding: 24px; }
    header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: start; border-bottom: 1px solid #cbd5e1; padding-bottom: 20px; margin-bottom: 20px; }
    .brand { font-weight: 800; letter-spacing: .02em; color: #4f46e5; font-size: 20px; }
    .brand-default img { width: 188px; height: auto; display: block; }
    .brand-with-logo { display: inline-flex; align-items: center; gap: 10px; color: #0f172a; letter-spacing: 0; }
    .brand-with-logo img { width: 42px; height: 42px; border-radius: 10px; object-fit: contain; border: 1px solid #e2e8f0; background: #fff; padding: 4px; }
    .brand-initials { display: inline-flex; width: 42px; height: 42px; align-items: center; justify-content: center; border-radius: 10px; background: #eef2ff; color: #4f46e5; font-size: 13px; font-weight: 850; }
    .powered-by { margin-top: 3px; color: #64748b; font-size: 10px; font-weight: 700; }
    h1 { margin: 8px 0 0; font-size: 28px; line-height: 1.1; }
    h2 { margin: 0 0 12px; font-size: 15px; }
    .muted { color: #64748b; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; background: #ecfdf5; color: #047857; padding: 4px 10px; font-size: 11px; font-weight: 700; }
    .summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; margin-top: 16px; }
    .summary dt { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .summary dd { margin: 2px 0 0; font-weight: 700; }
    .section-kicker { color: #4f46e5; font-size: 10px; font-weight: 850; text-transform: uppercase; letter-spacing: .06em; }
    .report-visual-intro { display: grid; grid-template-columns: minmax(0, 1fr); padding: 0; overflow: hidden; }
    .report-visual-intro-with-image { grid-template-columns: 270px minmax(0, 1fr); }
    .report-visual-intro h2 { margin-bottom: 0; font-size: 16px; }
    .report-intro-main { margin: 0; padding: 14px 10px 14px 16px; background: transparent; display: grid; align-content: center; min-height: 190px; }
    .report-intro-img { width: 100%; height: 170px; object-fit: contain; object-position: center; display: block; mix-blend-mode: multiply; }
    .report-intro-content { padding: 18px 18px 16px; }
    .report-intro-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .report-intro-title span { flex: none; border-radius: 999px; background: #eef2ff; color: #4338ca; padding: 4px 10px; font-size: 10px; font-weight: 850; }
    .report-reading-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; padding-left: 0; list-style: none; }
    .report-reading-list li { border: 1px solid #e2e8f0; border-left: 3px solid #4f46e5; border-radius: 8px; padding: 9px 10px; background: #fff; }
    .report-reading-list strong { display: block; color: #0f172a; font-size: 11px; }
    .report-reading-list span { display: block; color: #64748b; font-size: 10px; margin-top: 2px; line-height: 1.3; }
    .hero-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
    .hero-metric { background: #fff; border: 1px solid #dbe4ef; border-radius: 12px; padding: 14px; box-shadow: 0 12px 28px rgba(15, 23, 42, .07); break-inside: avoid; }
    .hero-metric dt { color: #64748b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    .hero-metric dd { margin: 6px 0 8px; font-size: 26px; line-height: 1; font-weight: 850; color: #0f172a; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin-bottom: 14px; break-inside: avoid; }
    .muted-card { background: #f8fafc; }
    .warning { border-color: #f59e0b; background: #fffbeb; }
    .metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .metric { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; }
    .metric dt { color: #64748b; font-size: 11px; }
    .metric dd { margin: 3px 0; font-size: 22px; font-weight: 800; }
    .delta { color: #64748b; font-size: 11px; font-weight: 700; }
    .delta-pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 8px; font-size: 11px; font-weight: 800; }
    .delta-good { color: #047857; background: #dcfce7; }
    .delta-bad { color: #b91c1c; background: #fee2e2; }
    .delta-stable { color: #475569; background: #f1f5f9; }
    .delta-empty { color: #64748b; background: #f1f5f9; }
    .status { display: inline-flex; border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 800; }
    .status-ok { background: #dcfce7; color: #047857; }
    .status-pending { background: #fef3c7; color: #92400e; }
    .small-note { margin: 10px 0 0; font-size: 11px; }
    .sparkline-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .sparkline-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; background: #fff; }
    .sparkline-title { font-size: 12px; font-weight: 800; margin-bottom: 5px; }
    .sparkline { display: block; width: 100%; height: auto; }
    .section-story-header { display: grid; gap: 14px; align-items: stretch; margin-bottom: 14px; }
    .section-story-header-with-image { grid-template-columns: 270px minmax(0, 1fr); overflow: hidden; border-radius: 10px; background: transparent; }
    .section-story-figure { margin: 0; padding: 10px 8px 10px 0; background: transparent; display: grid; align-content: center; min-height: 184px; }
    .section-story-img { width: 100%; height: 176px; object-fit: contain; object-position: center; display: block; mix-blend-mode: multiply; }
    .section-story-copy { min-width: 0; align-self: center; padding: 2px 0; }
    .section-story-header-with-image .section-story-copy { padding: 16px 18px 14px 0; }
    .section-story-copy h2, .section-story-copy h3 { margin: 2px 0 0; color: #0f172a; }
    .section-story-copy h2 { font-size: 16px; }
    .section-story-copy h3 { font-size: 14px; }
    .chart-axis { stroke: #cbd5e1; stroke-width: 1; }
    .chart-label { fill: #64748b; font-size: 10px; font-weight: 700; }
    .chart-value { fill: #0f172a; font-size: 10px; font-weight: 800; }
    .sparkline-caption { color: #64748b; font-size: 11px; font-weight: 700; margin-top: 4px; }
    .composition-bar { display: flex; width: 100%; height: 18px; overflow: hidden; border-radius: 999px; background: #e2e8f0; margin: 8px 0 12px; }
    .composition-bar span { display: block; min-width: 2px; height: 100%; }
    .visual-grid { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 18px; align-items: center; }
    .donut-chart { width: 180px; height: 180px; display: block; margin: 0 auto; }
    .donut-title { fill: #0f172a; font-size: 14px; font-weight: 850; }
    .donut-subtitle { fill: #64748b; font-size: 10px; font-weight: 700; }
    .section-heading-row { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 12px; }
    .comparison-section-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .comparison-section-card { border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; background: #f8fafc; break-inside: avoid; }
    .comparison-section-card h3 { margin: 0 0 10px; font-size: 13px; color: #0f172a; }
    .comparison-metric { border-top: 1px solid #e2e8f0; padding-top: 8px; margin-top: 8px; }
    .comparison-metric:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
    .comparison-metric-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; font-size: 11px; }
    .comparison-metric-head span { border-radius: 999px; padding: 2px 7px; font-weight: 850; white-space: nowrap; }
    .comparison-bars { display: grid; gap: 4px; margin-top: 6px; }
    .comparison-bars div { display: grid; grid-template-columns: 44px minmax(0, 1fr) 58px; gap: 6px; align-items: center; font-size: 10px; color: #64748b; }
    .comparison-bars i { height: 7px; border-radius: 999px; display: block; min-width: 4px; }
    .comparison-bars i.delta-good { background: #10b981; }
    .comparison-bars i.delta-bad { background: #ef4444; }
    .comparison-bars i.delta-stable { background: #64748b; }
    .comparison-bars i.previous { background: #cbd5e1; }
    .comparison-bars strong { text-align: right; color: #0f172a; font-weight: 800; }
    .composition-block-grid { display: grid; gap: 12px; }
    .composition-visual-block { border-top: 1px solid #e2e8f0; padding-top: 14px; background: transparent; }
    .composition-visual-block:first-child { border-top: 0; padding-top: 0; }
    .composition-visual-block h3 { margin: 0; font-size: 13px; color: #0f172a; }
    .composition-main-grid { margin-top: 4px; }
    .component-explain-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; margin-top: 14px; border-top: 1px solid #e2e8f0; }
    .component-explain-card { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 0 12px; align-items: center; border-bottom: 1px solid #e2e8f0; padding: 13px 0; background: transparent; }
    .component-explain-card-with-image { grid-template-columns: minmax(0, 1fr) 286px; gap: 20px; min-height: 292px; align-items: center; break-inside: avoid; }
    .component-explain-dot { grid-row: 1; width: 10px; height: 10px; border-radius: 999px; margin-top: 4px; display: block; align-self: start; }
    .component-explain-figure { margin: 0; min-height: 278px; display: grid; place-items: center; background: transparent; overflow: hidden; }
    .component-explain-img { width: 274px; height: 278px; object-fit: contain; object-position: center; display: block; mix-blend-mode: multiply; filter: saturate(1.08) contrast(1.05); }
    .component-explain-body { display: grid; gap: 6px; align-content: center; }
    .component-explain-grid strong { font-size: 13px; color: #0f172a; }
    .component-explain-grid small { color: #475569; font-size: 11px; line-height: 1.35; }
    .component-inline-bar { display: grid; grid-template-columns: minmax(0, 1fr) 72px; gap: 10px; align-items: center; margin-top: 12px; }
    .component-inline-bar::before { content: ''; grid-column: 1; grid-row: 1; height: 20px; border-radius: 999px; background: #e2e8f0; }
    .component-inline-bar i { grid-column: 1; grid-row: 1; height: 20px; border-radius: 999px; display: block; min-width: 4px; z-index: 1; }
    .component-inline-bar em { grid-column: 2; grid-row: 1; color: #0f172a; font-style: normal; font-size: 14px; font-weight: 850; text-align: right; }
    .pending-visual { min-height: 132px; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 6px; border: 1px dashed #cbd5e1; border-radius: 10px; text-align: center; padding: 16px; }
    .pending-visual strong { color: #92400e; }
    .pending-visual span { color: #64748b; font-size: 11px; max-width: 520px; }
    .legend-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 14px; }
    .legend-item { display: grid; grid-template-columns: 10px 1fr auto; gap: 7px; align-items: center; font-size: 12px; }
    .legend-item span { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
    .legend-item em { color: #64748b; font-style: normal; font-weight: 800; }
    .distribution-layout { display: grid; grid-template-columns: minmax(0, 1fr) 230px minmax(0, 1fr); gap: 20px; align-items: start; }
    .distribution-panel h3 { margin: 0 0 10px; color: #0369a1; font-size: 15px; }
    .distribution-row { margin: 11px 0; }
    .distribution-row-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: baseline; margin-bottom: 5px; }
    .distribution-row-head strong { font-size: 17px; }
    .distribution-row-head small { grid-column: 1 / -1; color: #64748b; font-size: 10px; font-weight: 750; }
    .distribution-row-head em { grid-column: 1 / -1; width: max-content; border-radius: 999px; padding: 2px 7px; font-style: normal; font-size: 10px; font-weight: 800; }
    .distribution-track { position: relative; height: 11px; border-radius: 999px; background: #e2e8f0; overflow: visible; }
    .distribution-track i { display: block; height: 100%; border-radius: 999px; }
    .distribution-track b { position: absolute; top: -4px; width: 6px; height: 19px; border-radius: 999px; background: #0f172a; transform: translateX(-50%); opacity: .65; }
    .body-map-wrap { border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; padding: 12px; text-align: left; }
    .body-map-title { color: #0f172a; font-size: 11px; font-weight: 850; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .04em; }
    .body-map { width: 132px; height: 202px; display: block; margin: 0 auto; }
    .body-map-figure { position: relative; width: 204px; height: 292px; margin: 0 auto; border-radius: 14px; background: transparent; overflow: hidden; }
    .body-map-img { width: 100%; height: 100%; object-fit: contain; display: block; padding: 12px; mix-blend-mode: multiply; }
    .body-zone { position: absolute; display: block; width: 14px; height: 14px; border: 2px solid #fff; border-radius: 999px; box-shadow: 0 4px 10px rgba(15,23,42,.18); opacity: .92; transform: translate(-50%, -50%); }
    .body-zone-upper { left: 50%; top: 17%; }
    .body-zone-central { left: 50%; top: 45%; }
    .body-zone-lower { left: 50%; top: 74%; }
    .body-zone-arm { left: 22%; top: 49%; }
    .body-zone-leg { left: 74%; top: 76%; }
    .distribution-key { display: grid; gap: 7px; margin-top: 10px; color: #64748b; font-size: 10px; text-align: left; }
    .distribution-key div { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 0 6px; align-items: center; }
    .distribution-key i { width: 11px; height: 11px; border-radius: 999px; display: inline-block; grid-row: 1 / span 2; }
    .distribution-key strong { color: #0f172a; font-size: 10px; }
    .distribution-key span { grid-column: 2; line-height: 1.25; }
    .key-current { background: linear-gradient(135deg, #38bdf8, #14b8a6, #f97316); }
    .key-previous { background: #0f172a; opacity: .7; }
    .key-body { background: #fff; border: 2px solid #14b8a6; }
    .distribution-reference { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
    .distribution-reference figure { margin: 0; display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 16px; align-items: center; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; background: #fff; overflow: hidden; }
    .distribution-reference-reverse { grid-template-columns: minmax(0, 1fr) 150px; }
    .distribution-reference-reverse figcaption { text-align: right; }
    .distribution-reference-reverse .distribution-ref-img { justify-self: end; }
    .distribution-ref-img { width: 150px; height: 168px; object-fit: contain; object-position: center; display: block; mix-blend-mode: multiply; }
    .distribution-reference figcaption { color: #475569; font-size: 11px; line-height: 1.35; }
    .distribution-reference figcaption strong { display: block; color: #0f172a; font-size: 12px; margin-bottom: 3px; }
    .distribution-reference figcaption span { display: block; }
    .somato-layout { display: grid; grid-template-columns: minmax(0, 1fr) 210px; gap: 18px; align-items: center; }
    .somato-layout-with-image { grid-template-columns: minmax(0, 1fr) 210px 170px; }
    .somato-chart { width: 100%; max-height: 330px; }
    .somato-label { fill: #0f172a; font-size: 13px; font-weight: 850; }
    .somato-point-label { fill: #0f766e; font-size: 10px; font-weight: 850; }
    .somato-values { display: grid; gap: 10px; }
    .somato-value-card { display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 2px 11px; align-items: center; border: 0; border-bottom: 1px solid #e2e8f0; border-radius: 0; padding: 8px 0; background: transparent; }
    .somato-value-card:last-child { border-bottom: 0; }
    .somato-value-card img { grid-row: 1 / span 2; width: 68px; height: 74px; object-fit: contain; border-radius: 0; background: transparent; mix-blend-mode: multiply; }
    .somato-value-card span { display: block; color: #64748b; font-size: 11px; font-weight: 700; }
    .somato-value-card strong { display: block; font-size: 24px; line-height: 1; color: #0f172a; }
    .somato-image-card { border: 0; border-radius: 10px; padding: 0; text-align: center; background: transparent; }
    .somato-image-card img { width: 100%; height: 208px; object-fit: contain; display: block; background: transparent; mix-blend-mode: multiply; }
    .somato-image-card strong { display: block; margin-top: 6px; font-size: 12px; color: #0f172a; }
    .health-table td:nth-child(2), .health-table td:nth-child(3) { text-align: right; white-space: nowrap; }
    .health-badge { display: inline-flex; min-width: 44px; justify-content: center; border-radius: 4px; padding: 3px 6px; font-weight: 850; }
    .health-ok { background: #16a34a; color: #fff; }
    .health-alert { background: #e11d48; color: #fff; }
    .health-neutral { background: #e2e8f0; color: #0f172a; }
    .fat-distribution { margin-top: 14px; border-top: 1px solid #e2e8f0; padding-top: 14px; }
    .fat-distribution-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .fat-distribution-head span { border-radius: 999px; padding: 2px 7px; font-size: 10px; font-weight: 800; }
    .fat-distribution-grid { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 18px; align-items: center; }
    .fat-distribution .donut-chart { width: 150px; height: 150px; }
    .fat-distribution-values { display: grid; gap: 8px; }
    .fat-distribution-values div { display: grid; grid-template-columns: 10px 1fr auto; gap: 8px; align-items: center; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; }
    .fat-distribution-values span { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
    .fat-distribution-values strong { display: grid; gap: 2px; }
    .fat-distribution-values small { color: #64748b; font-size: 10px; font-weight: 700; }
    .fat-distribution-values em { color: #0f172a; font-style: normal; font-weight: 850; }
    .range-wrap { width: 170px; }
    .range-track { position: relative; width: 170px; height: 14px; border-radius: 999px; background: linear-gradient(90deg, #fee2e2, #ecfdf5 42%, #ecfdf5 58%, #fee2e2); border: 1px solid #cbd5e1; }
    .range-track i { position: absolute; top: -4px; width: 7px; height: 20px; border-radius: 999px; background: #0284c7; transform: translateX(-50%); }
    .range-mid { position: absolute; left: 50%; top: 0; bottom: 0; border-left: 1px solid rgba(15, 23, 42, .22); }
    .range-labels { display: flex; justify-content: space-between; color: #64748b; font-size: 9px; margin-top: 2px; }
    .range-status { margin-top: 2px; font-size: 10px; font-weight: 800; }
    .range-ok { color: #047857; }
    .range-alert { color: #b91c1c; }
    .calculation-profile-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
    .calculation-profile-grid div { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; background: #fff; }
    .calculation-profile-grid dt { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .calculation-profile-grid dd { margin: 3px 0 0; font-weight: 800; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #e2e8f0; padding: 7px 6px; }
    th { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    ul { margin: 0; padding-left: 18px; }
    footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid #cbd5e1; color: #64748b; font-size: 11px; }
    @media print { body { background: #fff; } .page { padding: 0; } }
  </style>
</head>
<body>
  <main class="page">
    <header>
      <div>
        ${brandHtml}
        <h1>${escapeHtml(report.title)}</h1>
        <p class="muted">${escapeHtml(patient.clinic_name || 'Clínica')} · Generado el ${escapeHtml(formatDate(meta.generated_at))}</p>
      </div>
      ${documentStatusBadgeHtml}
    </header>
    <section class="card">
      <dl class="summary">
        <div><dt>Paciente</dt><dd>${escapeHtml(patient.name || 'Paciente')}</dd></div>
        <div><dt>Perfil</dt><dd>${escapeHtml(profileLabel)}</dd></div>
        <div><dt>Medición</dt><dd>${escapeHtml(formatDate(measurement.measured_at))}</dd></div>
        <div><dt>Tratamiento</dt><dd>${escapeHtml(displayNutritionText(treatment?.nombre) || 'No asociado')}</dd></div>
        <div><dt>Cita</dt><dd>${escapeHtml(appointment?.inicio ? formatDate(appointment.inicio) : 'No asociada')}</dd></div>
      </dl>
    </section>
    ${reportVisualIntroHtml}
    ${heroMetricsHtml}
    ${comparisonOverviewHtml}
    ${projectionVisualHtml}
    ${compositionVisualHtml}
    ${distributionVisualHtml}
    ${somatotypeVisualHtml}
    ${healthIndexesHtml}
    ${sectionsHtml}
    ${comparisonHtml}
    ${projectionHtml}
    ${narrativeHtml}
    ${qualityHtml}
    ${calculationProfileHtml}
    ${calculationTraceHtml}
    ${formulaReferencesHtml}
    ${rawHtml}
    <footer>
      Documento clínico privado. Calculado por ClinicaClick y generado bajo demanda para uso profesional.
    </footer>
  </main>
</body>
</html>`;
}

async function htmlToPdfBuffer(html, filenameSeed = 'nutrition-report') {
  const chromiumPath = process.env.CHROME_PATH
    || process.env.CHROMIUM_PATH
    || DEFAULT_CHROMIUM_PATH;
  const safeSeed = String(filenameSeed || 'nutrition-report').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clinicaclick-nutrition-'));
  const htmlPath = path.join(workDir, `${safeSeed}.html`);
  const pdfPath = path.join(workDir, `${safeSeed}.pdf`);

  try {
    await fs.writeFile(htmlPath, html, 'utf8');
    await execFileAsync(chromiumPath, [
      '--headless',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ], { timeout: 25000, maxBuffer: 1024 * 1024 });
    return await fs.readFile(pdfPath);
  } catch (error) {
    const err = new Error(`pdf_generation_failed:${error.message || 'unknown'}`);
    err.status = 500;
    throw err;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function renderNutritionMeasurementReport(patientIdentifier, measurementIdentifier, options = {}) {
  const reportData = await buildNutritionMeasurementReportData(patientIdentifier, measurementIdentifier, options);
  const snapshot = canUseStoredReportSnapshot(options)
    ? await findCurrentNutritionReportSnapshot(
      reportData.measurement.id,
      reportData.report.report_type,
    )
    : null;
  if (snapshot?.snapshot_html && isCurrentNutritionReportSnapshot(snapshot)) {
    return snapshot.snapshot_html;
  }
  return buildNutritionReportHtml(reportData, options);
}

async function persistFinalNutritionReportPdf(snapshot, reportData, buffer, filename, actorUserId = null) {
  if (!snapshot || String(snapshot.status || '').trim().toLowerCase() !== 'final') return null;
  if (!db.ClinicalPrivateAsset || !db.PatientNutritionReport) return null;

  try {
    const asset = await clinicalPrivateStorage.storeClinicalPrivateAsset({
      purpose: 'nutrition_report_pdf',
      clinicId: reportData.patient.clinic_id,
      patientId: reportData.patient.id,
      ownerType: 'patient_nutrition_report',
      ownerId: snapshot.id,
      contentType: 'application/pdf',
      buffer,
      originalFilename: filename,
      createdBy: actorUserId,
      metadata: {
        measurement_id: reportData.measurement.id,
        report_public_id: snapshot.public_id || null,
        report_type: reportData.report.report_type,
        formula_version: reportData.report.formula_version || FORMULA_VERSION,
        snapshot_hash: snapshot.snapshot_hash || null,
      },
    });
    snapshot.pdf_asset_id = asset.id;
    await snapshot.save();
    return asset;
  } catch (error) {
    console.warn('[nutritionWorkspace] private PDF cache skipped', {
      measurement_id: reportData.measurement.id,
      snapshot_id: snapshot.id,
      error: error?.message || error,
    });
    return null;
  }
}

async function generateNutritionMeasurementReportPdf(patientIdentifier, measurementIdentifier, actorUserId = null, options = {}) {
  const reportData = await buildNutritionMeasurementReportData(patientIdentifier, measurementIdentifier, options);
  const snapshot = canUseStoredReportSnapshot(options)
    ? await findCurrentNutritionReportSnapshot(
      reportData.measurement.id,
      reportData.report.report_type,
    )
    : null;
  if (snapshot?.pdf_asset_id && isCurrentNutritionReportSnapshot(snapshot)) {
    try {
      const cached = await clinicalPrivateStorage.readClinicalPrivateAsset(snapshot.pdf_asset_id);
      return {
        filename: cached.filename || `informe-nutricion-${reportData.measurement.id}.pdf`,
        buffer: cached.buffer,
        cached: true,
        pdf_asset_id: snapshot.pdf_asset_id,
      };
    } catch (error) {
      console.warn('[nutritionWorkspace] private PDF cache read failed', {
        measurement_id: reportData.measurement.id,
        snapshot_id: snapshot.id,
        pdf_asset_id: snapshot.pdf_asset_id,
        error: error?.message || error,
      });
    }
  }

  const html = snapshot?.snapshot_html && isCurrentNutritionReportSnapshot(snapshot)
    ? snapshot.snapshot_html
    : buildNutritionReportHtml(reportData, options);
  const filename = `informe-nutricion-${reportData.measurement.id}.pdf`;
  const buffer = await htmlToPdfBuffer(html, `nutrition-${reportData.measurement.id}`);
  const asset = canUseStoredReportSnapshot(options)
    ? await persistFinalNutritionReportPdf(snapshot, reportData, buffer, filename, actorUserId)
    : null;
  return {
    filename,
    buffer,
    cached: false,
    pdf_asset_id: asset?.id || snapshot?.pdf_asset_id || null,
  };
}

module.exports = {
  FORMULA_VERSION,
  FORMULA_REFERENCES,
  CALCULATION_PROFILE,
  PROFILE_DEFINITIONS,
  FIELD_DEFINITIONS,
  calculateNutritionValues,
  getPatientNutritionAccessContext,
  getPatientNutritionWorkspace,
  createNutritionMeasurement,
  getNutritionMeasurementReport,
  listNutritionMeasurementClinicalPhotos,
  addNutritionMeasurementClinicalPhoto,
  readNutritionMeasurementClinicalPhoto,
  createNutritionMeasurementReportSnapshot,
  finalizeNutritionMeasurementReportSnapshot,
  renderNutritionMeasurementReport,
  generateNutritionMeasurementReportPdf,
  __testing: {
    buildReportForMeasurement,
    buildReports,
    buildProjection,
    buildProjectionForMeasurement,
    buildCalculationTrace,
    buildNutritionReportHtml,
    buildNutritionReportSnapshotPayload,
    buildClinicalStoragePolicy,
    hashSnapshot,
    requiredFieldsForProfile,
    missingRequiredFieldsForProfile,
    normalizeSexForBodyComposition,
    calculateAgeYears,
    buildPatientFormulaContext,
    calculateBodyComposition,
    calculateKerrRossFiveComponent,
    displayNutritionText,
    nutritionReportSnapshotToJson,
  },
};
