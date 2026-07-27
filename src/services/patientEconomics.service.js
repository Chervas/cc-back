'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');

const {
  sequelize,
  EconomicBudget,
  EconomicBudgetVersion,
  EconomicBudgetEvent,
  ClinicEconomicTemplate,
  EconomicPayment,
  PatientWalletEntry,
  PatientVoucher,
  PatientVoucherMovement,
  PatientFiscalDocument,
  CitaPaciente,
  Paciente,
  PacienteClinica,
  Clinica,
  Tratamiento,
} = db;

const BUDGET_STATUSES = new Set([
  'draft',
  'presented',
  'accepted',
  'partially_accepted',
  'rejected',
  'expired',
  'superseded',
]);
const PAYMENT_MODES = new Set(['none', 'single', 'clinic_installments', 'external_financing', 'patient_balance']);
const PAYMENT_OPTION_MODES = new Set(['single', 'clinic_installments', 'external_financing', 'patient_balance']);
const PAYMENT_METHODS = new Set(['cash', 'card', 'transfer', 'direct_debit', 'bizum', 'financing', 'insurance', 'other']);
const ACCEPTANCE_COLLECTION_METHODS = new Set([
  'pending',
  'cash',
  'card',
  'transfer',
  'direct_debit',
  'bizum',
  'financing',
  'patient_balance',
  'insurance',
  'other',
]);
const ACCEPTANCE_SEND_CHANNELS = new Set(['whatsapp', 'email', 'printed', 'none']);
const ACCEPTANCE_SIGNATURE_CHANNELS = new Set(['tablet', 'mobile', 'printed', 'not_required']);
const ACCEPTANCE_BANK_DATA_STATUSES = new Set(['not_required', 'pending', 'complete']);
const ACCEPTANCE_FINANCING_STATUSES = new Set(['pending_approval', 'approved', 'rejected', 'paid_by_finance']);
const TEMPLATE_TYPES = new Set(['budget', 'invoice']);
const PRODUCT_TYPES = new Set(['treatment', 'voucher', 'pack']);
const FISCAL_DOCUMENT_TYPES = new Set(['receipt', 'invoice', 'credit_note']);
const AREA_ALIASES = {
  dental: ['dental', 'odontologia', 'odontología', 'odontologico', 'odontológico'],
  capilar: ['capilar', 'tricologia', 'tricología'],
  estetica: ['estetica', 'estética', 'medicina_estetica', 'medicina estética'],
  nutricion: ['nutricion', 'nutrición', 'dietetica', 'dietética'],
  psicologia: ['psicologia', 'psicología'],
  fisioterapia: ['fisioterapia', 'fisio'],
};

const BUILTIN_BUDGET_TEMPLATES = [
  {
    public_id: 'builtin-family',
    template_type: 'budget',
    name: 'Familiar',
    area_code: null,
    is_default: true,
    source: 'builtin',
    config: {
      header_variant: 'family',
      accent: 'primary',
      highlighted_block: 'clinic_installments',
      blocks: ['header', 'patient', 'services', 'single_payment', 'clinic_installments', 'financing', 'patient_balance', 'conditions'],
      block_visibility: {
        header: true,
        patient: true,
        services: true,
        single_payment: true,
        clinic_installments: true,
        financing: true,
        patient_balance: true,
        conditions: true,
      },
    },
  },
  {
    public_id: 'builtin-young',
    template_type: 'budget',
    name: 'Paciente joven',
    area_code: null,
    is_default: false,
    source: 'builtin',
    config: {
      header_variant: 'young',
      accent: 'primary',
      highlighted_block: 'financing',
      blocks: ['header', 'patient', 'services', 'financing', 'single_payment', 'conditions'],
      block_visibility: {
        header: true,
        patient: true,
        services: true,
        financing: true,
        single_payment: true,
        conditions: true,
      },
    },
  },
  {
    public_id: 'builtin-senior',
    template_type: 'budget',
    name: 'Paciente senior',
    area_code: null,
    is_default: false,
    source: 'builtin',
    config: {
      header_variant: 'senior',
      accent: 'neutral',
      highlighted_block: 'clinic_installments',
      blocks: ['header', 'patient', 'services', 'clinic_installments', 'single_payment', 'conditions'],
      block_visibility: {
        header: true,
        patient: true,
        services: true,
        clinic_installments: true,
        single_payment: true,
        conditions: true,
      },
    },
  },
  {
    public_id: 'builtin-clinical',
    template_type: 'budget',
    name: 'Clínico',
    area_code: null,
    is_default: false,
    source: 'builtin',
    config: {
      header_variant: 'clinical',
      accent: 'neutral',
      highlighted_block: 'services',
      blocks: ['header', 'patient', 'services', 'single_payment', 'clinic_installments', 'conditions'],
      block_visibility: {
        header: true,
        patient: true,
        services: true,
        single_payment: true,
        clinic_installments: true,
        conditions: true,
      },
    },
  },
];

const BUILTIN_INVOICE_TEMPLATE = {
  public_id: 'builtin-invoice-standard',
  template_type: 'invoice',
  name: 'Moderna',
  area_code: null,
  is_default: true,
  source: 'builtin',
  config: {
    renderer: 'modern',
    header_variant: 'modern',
    show_logo: true,
    show_payment_details: true,
    show_legal_footer: true,
    accent: 'neutral',
  },
};

const BUILTIN_COMPACT_INVOICE_TEMPLATE = {
  public_id: 'builtin-invoice-compact',
  template_type: 'invoice',
  name: 'Compacta',
  area_code: null,
  is_default: false,
  source: 'builtin',
  config: {
    renderer: 'compact',
    header_variant: 'compact',
    show_logo: true,
    show_payment_details: true,
    show_legal_footer: true,
    accent: 'neutral',
  },
};

function domainError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function positiveInteger(value, field) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw domainError(400, 'invalid_positive_integer', `${field} no es válido.`, { field });
  }
  return parsed;
}

function optionalPositiveInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanString(value, maxLength = 255) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : '';
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function numberValue(value) {
  return Number(value) || 0;
}

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeAreaCode(value) {
  const raw = cleanString(value, 50).toLowerCase();
  if (!raw) return '';
  const entry = Object.entries(AREA_ALIASES)
    .find(([, aliases]) => aliases.includes(raw));
  return entry?.[0] || raw;
}

function expandAreaCodes(values) {
  const expanded = new Set();
  for (const value of values) {
    const canonical = normalizeAreaCode(value);
    if (!canonical) continue;
    expanded.add(canonical);
    for (const alias of AREA_ALIASES[canonical] || []) expanded.add(alias);
  }
  return [...expanded];
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapPatientSnapshot(patient) {
  return {
    id: Number(patient.id_paciente),
    public_id: patient.public_id || null,
    name: [patient.nombre, patient.apellidos].filter(Boolean).join(' ').trim(),
    tax_id: patient.dni || null,
    email: patient.email || null,
    phone: patient.telefono_movil || null,
    address: null,
    postal_code: null,
    city: null,
    province: null,
    country: 'España',
  };
}

function mapClinicSnapshot(clinic) {
  const fiscal = parseJson(clinic.datos_fiscales_clinica, {});
  return {
    id: Number(clinic.id_clinica),
    name: clinic.nombre_clinica || '',
    legal_name: fiscal.denominacion_social || fiscal.razon_social || clinic.nombre_clinica || '',
    tax_id: fiscal.nif || fiscal.cif || fiscal.identificacion_fiscal || null,
    address: fiscal.direccion || clinic.direccion || null,
    postal_code: fiscal.codigo_postal || clinic.codigo_postal || null,
    city: fiscal.ciudad || clinic.ciudad || null,
    province: fiscal.provincia || clinic.provincia || null,
    country: fiscal.pais || clinic.pais || 'España',
    email: fiscal.email || clinic.email || null,
    phone: clinic.telefono || clinic.telefono_fijo || clinic.telefono_movil || null,
    logo_url: clinic.url_avatar || null,
    bank_account: fiscal.iban || fiscal.numero_cuenta || null,
  };
}

async function resolvePatient(identifier) {
  const numericId = optionalPositiveInteger(identifier);
  const patient = numericId
    ? await Paciente.findByPk(numericId)
    : await Paciente.findOne({ where: { public_id: cleanString(identifier, 64) } });
  if (!patient) {
    throw domainError(404, 'patient_not_found', 'Paciente no encontrado.');
  }
  return patient;
}

async function loadContext(patientIdentifier, clinicId) {
  const resolvedClinicId = positiveInteger(clinicId, 'clinic_id');
  const [patient, clinic] = await Promise.all([
    resolvePatient(patientIdentifier),
    Clinica.findByPk(resolvedClinicId),
  ]);
  if (!clinic) throw domainError(404, 'clinic_not_found', 'Clínica no encontrada.');
  const isPrimaryClinic = Number(patient.clinica_id) === resolvedClinicId;
  const link = isPrimaryClinic
    ? true
    : await PacienteClinica.findOne({
      where: { paciente_id: patient.id_paciente, clinica_id: resolvedClinicId },
      attributes: ['id'],
    });
  if (!isPrimaryClinic && !link) {
    throw domainError(404, 'patient_not_in_clinic', 'El paciente no pertenece a esta clínica.');
  }
  return { clinicId: resolvedClinicId, patient, clinic };
}

function normalizeProductType(treatment) {
  const config = parseJson(treatment.clinical_config, {});
  const explicit = cleanString(
    config.product_type
    || config.commercial?.product_type
    || config.budget?.product_type,
    20
  ).toLowerCase();
  if (PRODUCT_TYPES.has(explicit)) return explicit;
  const normalizedName = cleanString(treatment.nombre, 255).toLowerCase();
  if (/\bbono\b/.test(normalizedName)) return 'voucher';
  if (/\bpack\b|\bpaquete\b/.test(normalizedName)) return 'pack';
  return 'treatment';
}

function normalizeTreatmentArea(treatment) {
  const config = parseJson(treatment.clinical_config, {});
  const raw = cleanString(config.medical_area_code || treatment.disciplina || 'general', 50)
    .toLowerCase()
    .replace(/\s+/g, '_');
  return normalizeAreaCode(raw) || raw;
}

function mapCatalogItem(treatment) {
  const config = parseJson(treatment.clinical_config, {});
  return {
    id: String(treatment.id_tratamiento),
    treatment_id: Number(treatment.id_tratamiento),
    code: treatment.codigo || `TR-${treatment.id_tratamiento}`,
    name: treatment.nombre,
    description: treatment.descripcion || '',
    area_code: normalizeTreatmentArea(treatment),
    specialty: treatment.especialidad || null,
    category: treatment.categoria || null,
    product_type: normalizeProductType(treatment),
    base_price: roundMoney(treatment.precio_base),
    default_units: Math.max(1, Number(treatment.sesiones_defecto) || 1),
    unit_label: cleanString(config.commercial?.unit_label || config.unit_label, 40)
      || (Number(treatment.sesiones_defecto) > 1 ? 'sesiones' : 'unidad'),
    duration_minutes: Number(treatment.duracion_min) || 0,
    requires_tooth: !!treatment.requiere_pieza,
    requires_zone: !!treatment.requiere_zona,
    active: !!treatment.activo,
    origin: treatment.origen,
    recommended: !!config.commercial?.recommended,
    activation_rule: cleanString(config.voucher?.activation_rule, 30) || 'on_first_payment',
  };
}

function treatmentIsAvailableForClinic(treatment, context) {
  if (!treatment?.activo) return false;
  const hiddenFor = parseJson(treatment.eliminado_por_clinica, []).map(Number);
  if (hiddenFor.includes(Number(context.clinicId))) return false;
  const origin = cleanString(treatment.origen, 30).toLowerCase();
  return origin === 'sistema'
    || (origin === 'clinica' && Number(treatment.clinica_id) === Number(context.clinicId))
    || (
      origin === 'grupo'
      && Number(treatment.grupo_clinica_id) === Number(context.clinic.grupoClinicaId)
    );
}

async function resolveCatalogItemForClinic(treatmentId, context) {
  if (!treatmentId) return null;
  const treatment = await Tratamiento.findByPk(treatmentId);
  if (!treatmentIsAvailableForClinic(treatment, context)) {
    throw domainError(
      400,
      'voucher_treatment_invalid',
      'El servicio seleccionado no está disponible en el catálogo de esta clínica.',
    );
  }
  return mapCatalogItem(treatment);
}

async function listCatalog({ clinicId, patientIdentifier, query = {} }) {
  const { clinic, patient } = await loadContext(patientIdentifier, clinicId);
  const clinicConfig = parseJson(clinic.configuracion, {});
  const groupId = optionalPositiveInteger(clinic.grupoClinicaId);
  const requestedArea = normalizeAreaCode(query.area_code || query.area);
  const configuredAreas = (Array.isArray(clinicConfig.disciplinas) ? clinicConfig.disciplinas : [])
    .map((item) => normalizeAreaCode(typeof item === 'object' ? item.code || item.codigo : item))
    .filter(Boolean);
  const scope = [
    { origen: 'clinica', clinica_id: clinic.id_clinica },
    { origen: 'sistema' },
  ];
  if (groupId) scope.push({ origen: 'grupo', grupo_clinica_id: groupId });
  const where = { activo: true, [Op.or]: scope };
  const search = cleanString(query.q, 120);
  if (search) {
    where[Op.and] = [{
      [Op.or]: [
        { nombre: { [Op.like]: `%${search}%` } },
        { codigo: { [Op.like]: `%${search}%` } },
        { descripcion: { [Op.like]: `%${search}%` } },
        { categoria: { [Op.like]: `%${search}%` } },
        { especialidad: { [Op.like]: `%${search}%` } },
      ],
    }];
  }
  if (requestedArea) {
    where.disciplina = { [Op.in]: expandAreaCodes([requestedArea]) };
  } else if (configuredAreas.length) {
    where.disciplina = { [Op.in]: expandAreaCodes(configuredAreas) };
  }
  if (query.category) where.categoria = cleanString(query.category, 100);
  if (query.specialty) where.especialidad = cleanString(query.specialty, 100);

  const treatments = await Tratamiento.findAll({
    where,
    order: [['nombre', 'ASC'], ['id_tratamiento', 'ASC']],
  });
  const clinicIdNumber = Number(clinic.id_clinica);
  let items = treatments
    .filter((treatment) => {
      const hiddenFor = parseJson(treatment.eliminado_por_clinica, []);
      return !Array.isArray(hiddenFor) || !hiddenFor.map(Number).includes(clinicIdNumber);
    })
    .map(mapCatalogItem);
  const productTypes = cleanString(query.product_type || query.type, 80)
    .toLowerCase()
    .split(',')
    .map((value) => value.trim())
    .filter((value) => PRODUCT_TYPES.has(value));
  if (productTypes.length) {
    items = items.filter((item) => productTypes.includes(item.product_type));
  }

  const page = Math.max(1, optionalPositiveInteger(query.page) || 1);
  const pageSize = Math.min(100, Math.max(10, optionalPositiveInteger(query.page_size) || 30));
  const start = (page - 1) * pageSize;
  const categories = Array.from(new Set(items.map((item) => item.category).filter(Boolean))).sort();
  const specialties = Array.from(new Set(items.map((item) => item.specialty).filter(Boolean))).sort();
  return {
    patient: mapPatientSnapshot(patient),
    clinic: mapClinicSnapshot(clinic),
    items: items.slice(start, start + pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total: items.length,
      pages: Math.max(1, Math.ceil(items.length / pageSize)),
    },
    filters: { categories, specialties },
  };
}

function normalizeLine(raw, index) {
  const quantity = Number(raw.quantity ?? raw.cantidad);
  const unitPrice = Number(raw.unit_price ?? raw.precio_unitario ?? raw.precioUnitario);
  const discountPercent = Number(raw.discount_percent ?? raw.descuento ?? 0);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw domainError(400, 'budget_line_quantity_invalid', `La cantidad de la línea ${index + 1} no es válida.`);
  }
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw domainError(400, 'budget_line_price_invalid', `El precio de la línea ${index + 1} no es válido.`);
  }
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw domainError(400, 'budget_line_discount_invalid', `El descuento de la línea ${index + 1} no es válido.`);
  }
  const productType = cleanString(raw.product_type || raw.type || 'treatment', 20).toLowerCase();
  if (!PRODUCT_TYPES.has(productType)) {
    throw domainError(400, 'budget_line_product_type_invalid', `El tipo de la línea ${index + 1} no es válido.`);
  }
  const base = roundMoney(quantity * unitPrice);
  const total = roundMoney(base * (1 - discountPercent / 100));
  return {
    key: cleanString(raw.key || raw.id, 80) || `line-${index + 1}-${crypto.randomUUID().slice(0, 8)}`,
    treatment_id: optionalPositiveInteger(raw.treatment_id ?? raw.catalogoId),
    code: cleanString(raw.code || raw.codigo, 50) || `LINE-${index + 1}`,
    name: cleanString(raw.name || raw.nombre, 180),
    description: cleanString(raw.description || raw.descripcion, 500),
    product_type: productType,
    area_code: cleanString(raw.area_code || raw.area || 'general', 50),
    specialty: cleanString(raw.specialty || raw.especialidad, 100) || null,
    category: cleanString(raw.category || raw.categoria, 100) || null,
    tooth: optionalPositiveInteger(raw.tooth ?? raw.pieza),
    zone: cleanString(raw.zone || raw.zona, 100) || null,
    quantity: roundMoney(quantity),
    unit_label: cleanString(raw.unit_label || raw.unidad, 40) || 'unidad',
    unit_price: roundMoney(unitPrice),
    discount_percent: roundMoney(discountPercent),
    base,
    total,
    accepted: raw.accepted ?? raw.aceptada ?? true,
    activation_rule: cleanString(raw.activation_rule, 30) || 'on_first_payment',
    expires_in_months: optionalPositiveInteger(raw.expires_in_months),
    notes: cleanString(raw.notes || raw.notas, 500) || null,
  };
}

function calculateBudgetPayload(payload) {
  const rawLines = Array.isArray(payload.lines || payload.lineas) ? payload.lines || payload.lineas : [];
  if (!rawLines.length) {
    throw domainError(400, 'budget_lines_required', 'Selecciona al menos un tratamiento, bono o pack.');
  }
  const lines = rawLines.map(normalizeLine);
  if (lines.some((line) => !line.name)) {
    throw domainError(400, 'budget_line_name_required', 'Todas las líneas necesitan un nombre.');
  }
  const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.total, 0));
  const discountPercent = Number(payload.global_discount_percent ?? payload.descuentoGlobal ?? 0);
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw domainError(400, 'budget_global_discount_invalid', 'El descuento global no es válido.');
  }
  const discountAmount = roundMoney(subtotal * discountPercent / 100);
  const total = roundMoney(Math.max(0, subtotal - discountAmount));
  return {
    lines,
    totals: {
      currency: 'EUR',
      subtotal,
      global_discount_percent: roundMoney(discountPercent),
      global_discount_amount: discountAmount,
      tax_base: total,
      taxes: 0,
      total,
    },
  };
}

function normalizePaymentProposal(raw, total) {
  const proposal = raw && typeof raw === 'object' ? cloneJson(raw) : {};
  const legacyMode = cleanString(proposal.mode || 'none', 30).toLowerCase();
  if (!PAYMENT_MODES.has(legacyMode)) {
    throw domainError(400, 'payment_mode_invalid', 'La forma de pago no es válida.');
  }
  const requestedModes = Array.isArray(proposal.included_modes)
    ? proposal.included_modes.map((value) => cleanString(value, 30).toLowerCase())
    : legacyMode === 'none' ? [] : [legacyMode];
  const includedModes = [...new Set(requestedModes)];
  if (includedModes.some((mode) => !PAYMENT_OPTION_MODES.has(mode))) {
    throw domainError(400, 'payment_options_invalid', 'Una de las alternativas de pago no es válida.');
  }
  const normalized = {
    mode: includedModes[0] || 'none',
    included_modes: includedModes,
    single_payment: null,
    selected_financing_months: null,
    schedule: [],
    financing_options: [],
    balance_application: null,
    option_discounts: {},
  };
  const rawDiscounts = proposal.option_discounts && typeof proposal.option_discounts === 'object'
    ? proposal.option_discounts
    : {};
  for (const mode of PAYMENT_OPTION_MODES) {
    const percentage = roundMoney(rawDiscounts[mode] || 0);
    if (percentage < 0 || percentage > 100) {
      throw domainError(400, 'payment_option_discount_invalid', 'El descuento de una forma de pago no es válido.');
    }
    normalized.option_discounts[mode] = percentage;
  }
  const optionTotal = (mode) => roundMoney(total * (1 - normalized.option_discounts[mode] / 100));
  if (includedModes.includes('single')) {
    normalized.single_payment = {
      base_amount: total,
      amount: optionTotal('single'),
      discount_percent: normalized.option_discounts.single,
      savings: roundMoney(total - optionTotal('single')),
    };
  }
  if (includedModes.includes('clinic_installments')) {
    const clinicInstallmentsTotal = optionTotal('clinic_installments');
    const schedule = Array.isArray(proposal.schedule) ? proposal.schedule : [];
    if (!schedule.length) {
      throw domainError(400, 'payment_schedule_required', 'Define al menos una fase de pago.');
    }
    normalized.schedule = schedule.map((step, index) => ({
      key: cleanString(step.key, 60) || `phase-${index + 1}`,
      label: cleanString(step.label, 100) || `Pago ${index + 1}`,
      amount: roundMoney(step.amount),
      due_date: dateOrNull(step.due_date)?.toISOString() || null,
      milestone: cleanString(step.milestone, 80) || null,
    }));
    if (normalized.schedule.some((step) => step.amount <= 0)) {
      throw domainError(400, 'payment_schedule_amount_invalid', 'Todas las fases deben tener un importe mayor que cero.');
    }
    const scheduleTotal = roundMoney(normalized.schedule.reduce((sum, step) => sum + step.amount, 0));
    if (Math.abs(scheduleTotal - clinicInstallmentsTotal) > 0.01) {
      throw domainError(400, 'payment_schedule_total_mismatch', 'Las fases deben sumar el total del presupuesto.', {
        expected: clinicInstallmentsTotal,
        actual: scheduleTotal,
      });
    }
    normalized.clinic_installments = {
      base_amount: total,
      amount: clinicInstallmentsTotal,
      discount_percent: normalized.option_discounts.clinic_installments,
      savings: roundMoney(total - clinicInstallmentsTotal),
    };
  }
  if (includedModes.includes('external_financing')) {
    const externalFinancingTotal = optionTotal('external_financing');
    const options = Array.isArray(proposal.financing_options) ? proposal.financing_options : [];
    if (!options.length) {
      throw domainError(400, 'financing_options_required', 'Añade al menos una opción de financiación.');
    }
    normalized.financing_options = options.map((option) => {
      const months = positiveInteger(option.months, 'months');
      const entry = roundMoney(option.entry || 0);
      const openingFeePercent = roundMoney(option.opening_fee_percent || 0);
      const interestPercent = roundMoney(option.interest_percent || option.nominal_interest_percent || 0);
      if (entry < 0 || entry > externalFinancingTotal) {
        throw domainError(400, 'financing_entry_invalid', 'La entrada de financiación no es válida.');
      }
      if (openingFeePercent < 0 || openingFeePercent > 100) {
        throw domainError(400, 'financing_opening_fee_invalid', 'Los gastos de apertura no son válidos.');
      }
      if (interestPercent < 0 || interestPercent > 100) {
        throw domainError(400, 'financing_interest_invalid', 'El interés de financiación no es válido.');
      }
      const financedPrincipal = roundMoney(Math.max(0, externalFinancingTotal - entry));
      const totalFinanced = roundMoney(financedPrincipal * (1 + interestPercent / 100));
      return {
        months,
        provider: cleanString(option.provider, 120) || 'Financiación externa',
        entry,
        opening_fee_percent: openingFeePercent,
        opening_fee_amount: roundMoney(financedPrincipal * openingFeePercent / 100),
        interest_percent: interestPercent,
        monthly_amount: roundMoney(totalFinanced / months),
        total_financed: totalFinanced,
        conditions: cleanString(option.conditions, 1000) || null,
        required_documents: Array.isArray(option.required_documents)
          ? option.required_documents.map((item) => cleanString(item, 120)).filter(Boolean)
          : [],
        highlighted: !!option.highlighted,
        base_amount: total,
        option_amount: externalFinancingTotal,
        discount_percent: normalized.option_discounts.external_financing,
        savings: roundMoney(total - externalFinancingTotal),
      };
    });
    const selectedMonths = optionalPositiveInteger(proposal.selected_financing_months)
      || normalized.financing_options.find((option) => option.highlighted)?.months
      || null;
    if (!selectedMonths || !normalized.financing_options.some((option) => option.months === selectedMonths)) {
      throw domainError(400, 'financing_selection_required', 'Selecciona el plazo que se mostrará como principal.');
    }
    normalized.selected_financing_months = selectedMonths;
  }
  if (includedModes.includes('patient_balance')) {
    const amount = roundMoney(proposal.balance_application?.amount || 0);
    if (amount <= 0 || amount > optionTotal('patient_balance')) {
      throw domainError(400, 'balance_application_invalid', 'El saldo aplicado no es válido.');
    }
    normalized.balance_application = {
      amount,
      option_amount: optionTotal('patient_balance'),
      discount_percent: normalized.option_discounts.patient_balance,
    };
  }
  return normalized;
}

function serializePaymentProposal(value) {
  const proposal = parseJson(value, {});
  const mode = PAYMENT_MODES.has(proposal.mode) ? proposal.mode : 'none';
  const includedModes = Array.isArray(proposal.included_modes)
    ? [...new Set(proposal.included_modes.filter((item) => PAYMENT_OPTION_MODES.has(item)))]
    : mode === 'none' ? [] : [mode];
  return {
    ...proposal,
    mode: includedModes[0] || 'none',
    included_modes: includedModes,
    single_payment: includedModes.includes('single')
      ? proposal.single_payment || {
        amount: numberValue(proposal.schedule?.find((step) => step.key === 'single')?.amount),
        savings: 0,
      }
      : null,
    schedule: Array.isArray(proposal.schedule) ? proposal.schedule : [],
    financing_options: Array.isArray(proposal.financing_options) ? proposal.financing_options : [],
    balance_application: proposal.balance_application || null,
    option_discounts: proposal.option_discounts || {},
    clinic_installments: proposal.clinic_installments || null,
  };
}

function normalizeDesignConfig(payload, template) {
  const requested = payload && typeof payload === 'object' ? cloneJson(payload) : {};
  const base = cloneJson(template?.config || BUILTIN_BUDGET_TEMPLATES[0].config);
  const blocks = Array.isArray(requested.blocks) ? requested.blocks.map((item) => cleanString(item, 50)).filter(Boolean) : base.blocks;
  return {
    template_id: template?.public_id || 'builtin-family',
    template_name: template?.name || 'Familiar',
    header_variant: cleanString(requested.header_variant || base.header_variant, 50) || 'family',
    header_asset_url: cleanString(requested.header_asset_url, 1000) || null,
    logo_mode: ['clinic', 'custom', 'none'].includes(requested.logo_mode) ? requested.logo_mode : 'clinic',
    logo_url: cleanString(requested.logo_url, 1000) || null,
    accent: cleanString(requested.accent || base.accent, 30) || 'primary',
    highlighted_block: cleanString(requested.highlighted_block || base.highlighted_block, 50) || 'services',
    blocks,
    block_visibility: { ...(base.block_visibility || {}), ...(requested.block_visibility || {}) },
    conditions: cleanString(requested.conditions, 4000) || null,
    clinic_message: cleanString(requested.clinic_message, 4000) || null,
    custom_title: cleanString(requested.custom_title, 180) || null,
  };
}

async function listTemplates({ clinicId, templateType = null, areaCode = null }) {
  const type = templateType && TEMPLATE_TYPES.has(templateType) ? templateType : null;
  const where = { clinic_id: clinicId, active: true };
  if (type) where.template_type = type;
  if (areaCode) {
    where[Op.or] = [{ area_code: null }, { area_code: cleanString(areaCode, 50) }];
  }
  const custom = await ClinicEconomicTemplate.findAll({ where, order: [['is_default', 'DESC'], ['name', 'ASC']] });
  const builtins = [
    ...(type === 'invoice' ? [] : BUILTIN_BUDGET_TEMPLATES),
    ...(type === 'budget' ? [] : [BUILTIN_INVOICE_TEMPLATE, BUILTIN_COMPACT_INVOICE_TEMPLATE]),
  ];
  return [
    ...custom.map((row) => ({ ...row.toJSON(), source: 'clinic' })),
    ...builtins,
  ];
}

async function resolveTemplate({ clinicId, templateId, templateType = 'budget' }) {
  const templates = await listTemplates({ clinicId, templateType });
  return templates.find((template) => String(template.public_id) === String(templateId))
    || templates.find((template) => template.is_default)
    || templates[0];
}

async function nextBudgetNumber(clinicId, transaction) {
  const year = new Date().getFullYear();
  const prefix = `PRES-${year}-`;
  const budgets = await EconomicBudget.findAll({
    where: {
      clinic_id: clinicId,
      number: { [Op.like]: `${prefix}%` },
    },
    attributes: ['number'],
    transaction,
  });
  const lastSequence = budgets.reduce((max, budget) => {
    const sequence = Number.parseInt(String(budget.number).slice(prefix.length), 10);
    return Number.isInteger(sequence) ? Math.max(max, sequence) : max;
  }, 0);
  return `${prefix}${String(lastSequence + 1).padStart(4, '0')}`;
}

async function createVersion({ budget, payload, patient, clinic, actorId, versionNumber, transaction, changeSummary }) {
  const calculated = calculateBudgetPayload(payload);
  const template = await resolveTemplate({
    clinicId: clinic.id_clinica,
    templateId: payload.design_config?.template_id || payload.template_id,
    templateType: 'budget',
  });
  const paymentProposal = normalizePaymentProposal(payload.payment_proposal, calculated.totals.total);
  const designConfig = normalizeDesignConfig(payload.design_config, template);
  return EconomicBudgetVersion.create({
    budget_id: budget.id,
    version_number: versionNumber,
    lines: calculated.lines,
    totals: calculated.totals,
    payment_proposal: paymentProposal,
    design_config: designConfig,
    clinic_snapshot: mapClinicSnapshot(clinic),
    patient_snapshot: mapPatientSnapshot(patient),
    notes: cleanString(payload.notes || payload.notas, 10000) || null,
    internal_notes: cleanString(payload.internal_notes || payload.notasInternas, 10000) || null,
    change_summary: cleanString(changeSummary, 255) || null,
    created_by: actorId,
    created_at: new Date(),
  }, { transaction });
}

async function syncVoucherDefinitions({ budget, version, actorId, transaction }) {
  const lines = parseJson(version.lines, []);
  for (const line of lines.filter((item) => ['voucher', 'pack'].includes(item.product_type))) {
    const existing = await PatientVoucher.findOne({
      where: { budget_id: budget.id, budget_line_key: line.key },
      transaction,
    });
    const expiry = line.expires_in_months
      ? new Date(new Date().setMonth(new Date().getMonth() + line.expires_in_months))
      : null;
    const payload = {
      clinic_id: budget.clinic_id,
      patient_id: budget.patient_id,
      budget_id: budget.id,
      budget_line_key: line.key,
      treatment_id: line.treatment_id,
      name: line.name,
      unit_label: line.unit_label,
      total_units: line.quantity,
      available_units: existing ? existing.available_units : line.quantity,
      sold_amount: line.total,
      activation_rule: line.activation_rule,
      status: existing?.status || 'pending',
      expires_at: expiry,
      created_by: actorId,
    };
    if (existing) {
      if (existing.status === 'pending') await existing.update(payload, { transaction });
    } else {
      await PatientVoucher.create({ public_id: crypto.randomUUID(), ...payload }, { transaction });
    }
  }
}

async function createBudget({ patientIdentifier, clinicId, actorId, payload }) {
  const { patient, clinic } = await loadContext(patientIdentifier, clinicId);
  const requestedStatus = cleanString(payload.status || 'draft', 30).toLowerCase();
  const sourceSystem = cleanString(payload.source_system, 40) || 'clinicaclick';
  const sourceReference = cleanString(payload.source_reference, 120) || null;
  if (!['draft', 'presented'].includes(requestedStatus)) {
    throw domainError(400, 'budget_initial_status_invalid', 'Un presupuesto nuevo debe guardarse como borrador o presentado.');
  }
  return sequelize.transaction(async (transaction) => {
    await Clinica.findByPk(clinic.id_clinica, {
      attributes: ['id_clinica'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (sourceReference) {
      const existing = await EconomicBudget.findOne({
        where: {
          clinic_id: clinic.id_clinica,
          source_system: sourceSystem,
          source_reference: sourceReference,
        },
        transaction,
      });
      if (existing) {
        const version = await EconomicBudgetVersion.findOne({
          where: { budget_id: existing.id, version_number: existing.current_version },
          transaction,
        });
        return serializeBudget(existing, version, [], []);
      }
    }
    const budget = await EconomicBudget.create({
      public_id: crypto.randomUUID(),
      clinic_id: clinic.id_clinica,
      patient_id: patient.id_paciente,
      number: await nextBudgetNumber(clinic.id_clinica, transaction),
      status: requestedStatus,
      current_version: 1,
      valid_until: dateOrNull(payload.valid_until) || new Date(Date.now() + 30 * 86400000),
      presented_at: requestedStatus === 'presented' ? new Date() : null,
      accepted_amount: 0,
      source_system: sourceSystem,
      source_reference: sourceReference,
      created_by: actorId,
      updated_by: actorId,
    }, { transaction });
    const version = await createVersion({
      budget,
      payload,
      patient,
      clinic,
      actorId,
      versionNumber: 1,
      transaction,
      changeSummary: 'Versión inicial',
    });
    await EconomicBudgetEvent.create({
      budget_id: budget.id,
      version_number: 1,
      event_type: requestedStatus === 'presented' ? 'presented' : 'created',
      from_status: null,
      to_status: requestedStatus,
      metadata: { created_as: requestedStatus },
      actor_id: actorId,
      created_at: new Date(),
    }, { transaction });
    await syncVoucherDefinitions({ budget, version, actorId, transaction });
    return serializeBudget(budget, version, [], []);
  });
}

async function loadBudgetByPublicId(publicId, transaction = null) {
  const budget = await EconomicBudget.findOne({
    where: { public_id: cleanString(publicId, 36) },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!budget) throw domainError(404, 'budget_not_found', 'Presupuesto no encontrado.');
  return budget;
}

async function updateDraftBudget({ publicId, actorId, payload }) {
  return sequelize.transaction(async (transaction) => {
    const budget = await loadBudgetByPublicId(publicId, transaction);
    if (budget.status !== 'draft') {
      throw domainError(409, 'budget_revision_required', 'Solo se editan directamente los borradores. Crea una revisión nueva.');
    }
    const [patient, clinic] = await Promise.all([
      Paciente.findByPk(budget.patient_id, { transaction }),
      Clinica.findByPk(budget.clinic_id, { transaction }),
    ]);
    const versionNumber = Number(budget.current_version) + 1;
    const version = await createVersion({
      budget,
      payload,
      patient,
      clinic,
      actorId,
      versionNumber,
      transaction,
      changeSummary: payload.change_summary || 'Borrador actualizado',
    });
    await budget.update({
      current_version: versionNumber,
      valid_until: dateOrNull(payload.valid_until) || budget.valid_until,
      updated_by: actorId,
    }, { transaction });
    await EconomicBudgetEvent.create({
      budget_id: budget.id,
      version_number: versionNumber,
      event_type: 'edited',
      from_status: 'draft',
      to_status: 'draft',
      metadata: { change_summary: version.change_summary },
      actor_id: actorId,
      created_at: new Date(),
    }, { transaction });
    await syncVoucherDefinitions({ budget, version, actorId, transaction });
    return serializeBudget(budget, version, [], []);
  });
}

async function reviseBudget({ publicId, actorId }) {
  return sequelize.transaction(async (transaction) => {
    const original = await loadBudgetByPublicId(publicId, transaction);
    if (!['presented', 'accepted', 'partially_accepted', 'rejected', 'expired'].includes(original.status)) {
      throw domainError(409, 'budget_revision_not_allowed', 'Este presupuesto no necesita una revisión nueva.');
    }
    const sourceVersion = await EconomicBudgetVersion.findOne({
      where: { budget_id: original.id, version_number: original.current_version },
      transaction,
    });
    const [patient, clinic] = await Promise.all([
      Paciente.findByPk(original.patient_id, { transaction }),
      Clinica.findByPk(original.clinic_id, { transaction }),
    ]);
    await Clinica.findByPk(original.clinic_id, {
      attributes: ['id_clinica'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const revision = await EconomicBudget.create({
      public_id: crypto.randomUUID(),
      clinic_id: original.clinic_id,
      patient_id: original.patient_id,
      number: await nextBudgetNumber(original.clinic_id, transaction),
      status: 'draft',
      current_version: 1,
      valid_until: new Date(Date.now() + 30 * 86400000),
      accepted_amount: 0,
      source_system: 'clinicaclick_revision',
      source_reference: original.public_id,
      created_by: actorId,
      updated_by: actorId,
    }, { transaction });
    const version = await EconomicBudgetVersion.create({
      budget_id: revision.id,
      version_number: 1,
      lines: cloneJson(sourceVersion.lines),
      totals: cloneJson(sourceVersion.totals),
      payment_proposal: cloneJson(sourceVersion.payment_proposal),
      design_config: cloneJson(sourceVersion.design_config),
      clinic_snapshot: mapClinicSnapshot(clinic),
      patient_snapshot: mapPatientSnapshot(patient),
      notes: sourceVersion.notes,
      internal_notes: sourceVersion.internal_notes,
      change_summary: `Revisión de ${original.number}`,
      created_by: actorId,
      created_at: new Date(),
    }, { transaction });
    await EconomicBudgetEvent.bulkCreate([
      {
        budget_id: original.id,
        version_number: original.current_version,
        event_type: 'duplicated',
        from_status: original.status,
        to_status: original.status,
        metadata: { revision_budget_id: revision.public_id },
        actor_id: actorId,
        created_at: new Date(),
      },
      {
        budget_id: revision.id,
        version_number: 1,
        event_type: 'duplicated',
        from_status: null,
        to_status: 'draft',
        metadata: { source_budget_id: original.public_id },
        actor_id: actorId,
        created_at: new Date(),
      },
    ], { transaction });
    await syncVoucherDefinitions({ budget: revision, version, actorId, transaction });
    return serializeBudget(revision, version, [], []);
  });
}

async function activateVouchers({ budget, rule, actorId, transaction }) {
  const vouchers = await PatientVoucher.findAll({
    where: { budget_id: budget.id, activation_rule: rule, status: 'pending' },
    transaction,
  });
  for (const voucher of vouchers) {
    await voucher.update({ status: 'active' }, { transaction });
    await PatientVoucherMovement.create({
      voucher_id: voucher.id,
      movement_type: 'activation',
      units: voucher.total_units,
      notes: rule === 'on_acceptance'
        ? 'Activado al aceptar el presupuesto.'
        : (rule === 'on_full_payment'
          ? 'Activado al completar el pago del presupuesto.'
          : 'Activado al registrar el primer cobro.'),
      occurred_at: new Date(),
      created_by: actorId,
      created_at: new Date(),
    }, { transaction });
  }
}

async function transitionBudget({ publicId, actorId, action, payload = {} }) {
  const transitions = {
    present: { from: ['draft'], to: 'presented', event: 'presented' },
    accept: { from: ['presented'], to: 'accepted', event: 'accepted' },
    accept_partial: { from: ['presented'], to: 'partially_accepted', event: 'partially_accepted' },
    reject: { from: ['presented'], to: 'rejected', event: 'rejected' },
    expire: { from: ['draft', 'presented'], to: 'expired', event: 'expired' },
  };
  const transition = transitions[action];
  if (!transition) throw domainError(400, 'budget_transition_invalid', 'La transición solicitada no es válida.');
  return sequelize.transaction(async (transaction) => {
    const budget = await loadBudgetByPublicId(publicId, transaction);
    const previousStatus = budget.status;
    if (!transition.from.includes(budget.status)) {
      throw domainError(409, 'budget_transition_not_allowed', `No se puede aplicar esta acción desde ${budget.status}.`);
    }
    const version = await EconomicBudgetVersion.findOne({
      where: { budget_id: budget.id, version_number: budget.current_version },
      transaction,
    });
    const totals = parseJson(version.totals, {});
    const proposal = parseJson(version.payment_proposal, {});
    let acceptedAmount = 0;
    let acceptedLineKeys = [];
    let acceptance = {};
    if (transition.to === 'accepted') {
      acceptedAmount = numberValue(totals.total);
      acceptedLineKeys = parseJson(version.lines, []).map((line) => line.key);
    } else if (transition.to === 'partially_accepted') {
      acceptedLineKeys = Array.isArray(payload.accepted_line_keys)
        ? payload.accepted_line_keys.map((item) => cleanString(item, 80)).filter(Boolean)
        : [];
      const acceptedSet = new Set(acceptedLineKeys);
      acceptedAmount = roundMoney(parseJson(version.lines, [])
        .filter((line) => acceptedSet.has(line.key))
        .reduce((sum, line) => sum + numberValue(line.total), 0));
      if (!acceptedLineKeys.length || acceptedAmount <= 0) {
        throw domainError(400, 'accepted_lines_required', 'Selecciona las líneas que el paciente ha aceptado.');
      }
    }
    if (['accepted', 'partially_accepted'].includes(transition.to)) {
      const includedModes = Array.isArray(proposal.included_modes)
        ? proposal.included_modes.filter((mode) => PAYMENT_OPTION_MODES.has(mode))
        : PAYMENT_OPTION_MODES.has(proposal.mode) ? [proposal.mode] : [];
      const selectedPaymentMode = cleanString(
        payload.selected_payment_mode || (includedModes.length === 1 ? includedModes[0] : ''),
        30,
      ).toLowerCase();
      if (includedModes.length > 1 && !selectedPaymentMode) {
        throw domainError(
          400,
          'accepted_payment_mode_required',
          'Indica qué forma de pago ha elegido el paciente.',
        );
      }
      if (selectedPaymentMode && !includedModes.includes(selectedPaymentMode)) {
        throw domainError(
          400,
          'accepted_payment_mode_invalid',
          'La forma de pago elegida no forma parte de este presupuesto.',
        );
      }
      let selectedFinancingMonths = null;
      let financingProvider = null;
      let financingStatus = null;
      let financingFallbackMode = null;
      if (selectedPaymentMode === 'external_financing') {
        selectedFinancingMonths = optionalPositiveInteger(
          payload.selected_financing_months || proposal.selected_financing_months,
        );
        const financingOptions = Array.isArray(proposal.financing_options)
          ? proposal.financing_options
          : [];
        financingProvider = cleanString(payload.financing_provider, 120) || null;
        if (!selectedFinancingMonths
          || !financingOptions.some((option) => Number(option.months) === selectedFinancingMonths)) {
          throw domainError(
            400,
            'accepted_financing_term_invalid',
            'Selecciona uno de los plazos de financiación ofrecidos.',
          );
        }
        if (financingProvider
          && !financingOptions.some((option) =>
            Number(option.months) === selectedFinancingMonths
            && cleanString(option.provider, 120) === financingProvider
          )) {
          throw domainError(
            400,
            'accepted_financing_provider_invalid',
            'La financiera elegida no forma parte de este presupuesto.',
          );
        }
        financingStatus = cleanString(payload.financing_status || 'pending_approval', 40).toLowerCase();
        if (!ACCEPTANCE_FINANCING_STATUSES.has(financingStatus)) {
          throw domainError(
            400,
            'accepted_financing_status_invalid',
            'El estado de la financiación no es válido.',
          );
        }
        financingFallbackMode = cleanString(payload.financing_fallback_mode, 40).toLowerCase() || null;
        if (financingFallbackMode === 'none') financingFallbackMode = null;
        if (financingFallbackMode
          && (!includedModes.includes(financingFallbackMode) || financingFallbackMode === 'external_financing')) {
          throw domainError(
            400,
            'accepted_financing_fallback_invalid',
            'La alternativa de financiación no es válida.',
          );
        }
      }
      const defaultCollectionMethod = selectedPaymentMode === 'external_financing'
        ? 'financing'
        : selectedPaymentMode === 'patient_balance' ? 'patient_balance' : 'pending';
      const collectionMethod = cleanString(
        payload.collection_method || defaultCollectionMethod,
        30,
      ).toLowerCase();
      if (!ACCEPTANCE_COLLECTION_METHODS.has(collectionMethod)) {
        throw domainError(
          400,
          'accepted_collection_method_invalid',
          'El método de cobro previsto no es válido.',
        );
      }
      const sendChannel = cleanString(payload.send_channel || 'whatsapp', 30).toLowerCase();
      if (!ACCEPTANCE_SEND_CHANNELS.has(sendChannel)) {
        throw domainError(400, 'accepted_send_channel_invalid', 'El canal de entrega no es válido.');
      }
      const signatureChannel = cleanString(payload.signature_channel || 'tablet', 30).toLowerCase();
      if (!ACCEPTANCE_SIGNATURE_CHANNELS.has(signatureChannel)) {
        throw domainError(400, 'accepted_signature_channel_invalid', 'El canal de firma no es válido.');
      }
      const bankDataStatus = cleanString(payload.bank_data_status || 'not_required', 30).toLowerCase();
      if (!ACCEPTANCE_BANK_DATA_STATUSES.has(bankDataStatus)) {
        throw domainError(400, 'accepted_bank_data_status_invalid', 'El estado de datos bancarios no es válido.');
      }
      acceptance = {
        selected_payment_mode: selectedPaymentMode || null,
        selected_financing_months: selectedFinancingMonths,
        financing_provider: financingProvider,
        financing_status: financingStatus,
        financing_fallback_mode: financingFallbackMode,
        collection_method: collectionMethod,
        send_channel: sendChannel,
        signature_channel: signatureChannel,
        bank_data_status: bankDataStatus,
      };
    }
    const now = new Date();
    await budget.update({
      status: transition.to,
      presented_at: transition.to === 'presented' ? now : budget.presented_at,
      responded_at: ['accepted', 'partially_accepted', 'rejected'].includes(transition.to) ? now : budget.responded_at,
      accepted_amount: acceptedAmount,
      updated_by: actorId,
    }, { transaction });
    await EconomicBudgetEvent.create({
      budget_id: budget.id,
      version_number: budget.current_version,
      event_type: transition.event,
      from_status: previousStatus,
      to_status: transition.to,
      metadata: {
        reason: cleanString(payload.reason, 500) || null,
        accepted_line_keys: acceptedLineKeys,
        accepted_amount: acceptedAmount,
        ...acceptance,
      },
      actor_id: actorId,
      created_at: now,
    }, { transaction });
    if (['accepted', 'partially_accepted'].includes(transition.to)) {
      await activateVouchers({ budget, rule: 'on_acceptance', actorId, transaction });
    }
    return serializeBudget(budget, version, [], []);
  });
}

function paymentAppliedToBudget(payment) {
  const application = parseJson(payment.application, {});
  return roundMoney((Array.isArray(application.allocations) ? application.allocations : [])
    .filter((item) => ['budget', 'budget_line'].includes(item.target_type))
    .reduce((sum, item) => sum + numberValue(item.amount), 0));
}

async function createPayment({ publicId, actorId, payload }) {
  return sequelize.transaction(async (transaction) => {
    const budget = await loadBudgetByPublicId(publicId, transaction);
    await Paciente.findByPk(budget.patient_id, {
      attributes: ['id_paciente'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!['accepted', 'partially_accepted', 'presented'].includes(budget.status)) {
      throw domainError(409, 'budget_not_payable', 'El presupuesto todavía no admite cobros.');
    }
    const amount = roundMoney(payload.amount);
    const method = cleanString(payload.method, 20).toLowerCase();
    if (amount <= 0) throw domainError(400, 'payment_amount_invalid', 'El importe debe ser mayor que cero.');
    if (!PAYMENT_METHODS.has(method)) throw domainError(400, 'payment_method_invalid', 'El método de cobro no es válido.');
    const allocations = Array.isArray(payload.allocations) ? payload.allocations.map((item) => ({
      target_type: cleanString(item.target_type, 30),
      line_key: cleanString(item.line_key, 80) || null,
      amount: roundMoney(item.amount),
      label: cleanString(item.label, 180) || null,
    })) : [];
    if (!allocations.length || allocations.some((item) => item.amount <= 0)) {
      throw domainError(400, 'payment_allocations_required', 'Indica a qué se aplica el cobro.');
    }
    const allocationTotal = roundMoney(allocations.reduce((sum, item) => sum + item.amount, 0));
    if (Math.abs(allocationTotal - amount) > 0.01) {
      throw domainError(400, 'payment_allocation_total_mismatch', 'La aplicación del cobro debe sumar el importe recibido.');
    }
    if (allocations.some((item) => !['budget', 'budget_line', 'wallet'].includes(item.target_type))) {
      throw domainError(400, 'payment_allocation_target_invalid', 'Uno de los destinos del cobro no es válido.');
    }
    const budgetApplication = roundMoney(allocations
      .filter((item) => ['budget', 'budget_line'].includes(item.target_type))
      .reduce((sum, item) => sum + item.amount, 0));
    const [version, previousPayments, appliedWalletEntries] = await Promise.all([
      EconomicBudgetVersion.findOne({
        where: { budget_id: budget.id, version_number: budget.current_version },
        transaction,
      }),
      EconomicPayment.findAll({
        where: { budget_id: budget.id, status: 'confirmed' },
        transaction,
      }),
      PatientWalletEntry.findAll({
        where: { budget_id: budget.id, status: 'confirmed', entry_type: 'allocation' },
        transaction,
      }),
    ]);
    const versionLines = parseJson(version?.lines, []);
    const linesByKey = new Map(versionLines.map((line) => [String(line.key), line]));
    const requestedByLine = new Map();
    for (const allocation of allocations.filter((item) => item.target_type === 'budget_line')) {
      if (!allocation.line_key || !linesByKey.has(String(allocation.line_key))) {
        throw domainError(400, 'payment_budget_line_invalid', 'Una aplicación apunta a un concepto que no existe.');
      }
      const key = String(allocation.line_key);
      requestedByLine.set(key, roundMoney((requestedByLine.get(key) || 0) + allocation.amount));
    }
    const previouslyAppliedByLine = new Map();
    for (const previousPayment of previousPayments) {
      const previousApplication = parseJson(previousPayment.application, {});
      for (const allocation of Array.isArray(previousApplication.allocations)
        ? previousApplication.allocations
        : []) {
        if (allocation.target_type !== 'budget_line' || !allocation.line_key) continue;
        const key = String(allocation.line_key);
        previouslyAppliedByLine.set(
          key,
          roundMoney((previouslyAppliedByLine.get(key) || 0) + numberValue(allocation.amount))
        );
      }
    }
    for (const [lineKey, requested] of requestedByLine) {
      const lineTotal = numberValue(linesByKey.get(lineKey)?.total);
      const previous = previouslyAppliedByLine.get(lineKey) || 0;
      if (roundMoney(previous + requested) > lineTotal + 0.01) {
        throw domainError(
          400,
          'payment_exceeds_budget_line_pending',
          'El importe aplicado supera lo pendiente del concepto.',
          { line_key: lineKey, pending: roundMoney(Math.max(0, lineTotal - previous)) }
        );
      }
    }
    const payable = numberValue(budget.accepted_amount) > 0
      ? numberValue(budget.accepted_amount)
      : numberValue(parseJson(version?.totals, {}).total);
    const previouslyApplied = roundMoney(
      previousPayments.reduce((sum, item) => sum + paymentAppliedToBudget(item), 0)
      + appliedWalletEntries.reduce((sum, item) => sum + Math.abs(numberValue(item.amount)), 0)
    );
    const pending = roundMoney(Math.max(0, payable - previouslyApplied));
    if (budgetApplication > pending + 0.01) {
      throw domainError(
        400,
        'payment_exceeds_budget_pending',
        'El importe aplicado supera lo pendiente del presupuesto.',
        { pending, requested: budgetApplication }
      );
    }
    const payment = await EconomicPayment.create({
      public_id: crypto.randomUUID(),
      clinic_id: budget.clinic_id,
      patient_id: budget.patient_id,
      budget_id: budget.id,
      budget_version: budget.current_version,
      amount,
      method,
      reference: cleanString(payload.reference, 120) || null,
      application: { allocations },
      notes: cleanString(payload.notes, 2000) || null,
      paid_at: dateOrNull(payload.paid_at) || new Date(),
      created_by: actorId,
    }, { transaction });
    for (const allocation of allocations.filter((item) => item.target_type === 'wallet')) {
      await PatientWalletEntry.create({
        public_id: crypto.randomUUID(),
        clinic_id: budget.clinic_id,
        patient_id: budget.patient_id,
        payment_id: payment.id,
        budget_id: null,
        entry_type: 'deposit',
        amount: allocation.amount,
        reference: payment.reference,
        notes: allocation.label || 'Anticipo del paciente',
        occurred_at: payment.paid_at,
        created_by: actorId,
        created_at: new Date(),
      }, { transaction });
    }
    await activateVouchers({ budget, rule: 'on_first_payment', actorId, transaction });
    if (roundMoney(previouslyApplied + budgetApplication) >= payable) {
      await activateVouchers({ budget, rule: 'on_full_payment', actorId, transaction });
    }
    return serializePayment(payment, budget.public_id);
  });
}

async function createWalletDeposit({ patientIdentifier, clinicId, actorId, payload }) {
  const { patient } = await loadContext(patientIdentifier, clinicId);
  const amount = roundMoney(payload.amount);
  const method = cleanString(payload.method, 20).toLowerCase();
  if (amount <= 0) throw domainError(400, 'payment_amount_invalid', 'El importe debe ser mayor que cero.');
  if (!PAYMENT_METHODS.has(method)) throw domainError(400, 'payment_method_invalid', 'El método de cobro no es válido.');
  return sequelize.transaction(async (transaction) => {
    await Paciente.findByPk(patient.id_paciente, {
      attributes: ['id_paciente'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const payment = await EconomicPayment.create({
      public_id: crypto.randomUUID(),
      clinic_id: clinicId,
      patient_id: patient.id_paciente,
      budget_id: null,
      budget_version: null,
      amount,
      method,
      reference: cleanString(payload.reference, 120) || null,
      application: {
        allocations: [{
          target_type: 'wallet',
          line_key: null,
          amount,
          label: cleanString(payload.label, 180) || 'Anticipo del paciente',
        }],
      },
      notes: cleanString(payload.notes, 2000) || null,
      paid_at: dateOrNull(payload.paid_at) || new Date(),
      created_by: actorId,
    }, { transaction });
    const entry = await PatientWalletEntry.create({
      public_id: crypto.randomUUID(),
      clinic_id: clinicId,
      patient_id: patient.id_paciente,
      payment_id: payment.id,
      budget_id: null,
      entry_type: 'deposit',
      amount,
      reference: payment.reference,
      notes: cleanString(payload.label, 180) || 'Anticipo del paciente',
      occurred_at: payment.paid_at,
      created_by: actorId,
      created_at: new Date(),
    }, { transaction });
    return {
      payment: serializePayment(payment),
      wallet_entry: serializeWalletEntry(entry),
      balance: await walletBalance({ clinicId, patientId: patient.id_paciente, transaction }),
    };
  });
}

async function voidPayment({ publicId, actorId, payload }) {
  return sequelize.transaction(async (transaction) => {
    const payment = await EconomicPayment.findOne({
      where: { public_id: cleanString(publicId, 36) },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!payment) throw domainError(404, 'payment_not_found', 'Cobro no encontrado.');
    await Paciente.findByPk(payment.patient_id, {
      attributes: ['id_paciente'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (payment.status !== 'confirmed') {
      throw domainError(409, 'payment_not_voidable', 'El cobro ya no está confirmado.');
    }
    const reason = cleanString(payload.reason, 500);
    if (!reason) throw domainError(400, 'payment_void_reason_required', 'Indica el motivo de la anulación.');
    await payment.update({
      status: 'voided',
      notes: [payment.notes, `Anulado: ${reason}`].filter(Boolean).join('\n'),
    }, { transaction });
    const walletEntries = await PatientWalletEntry.findAll({
      where: { payment_id: payment.id, status: 'confirmed' },
      transaction,
    });
    for (const entry of walletEntries) {
      await entry.update({
        status: 'voided',
        notes: [entry.notes, `Anulado: ${reason}`].filter(Boolean).join('\n'),
      }, { transaction });
    }
    return serializePayment(payment);
  });
}

async function walletBalance({ clinicId, patientId, transaction = null }) {
  const entries = await PatientWalletEntry.findAll({
    where: { clinic_id: clinicId, patient_id: patientId, status: 'confirmed' },
    transaction,
  });
  return roundMoney(entries.reduce((sum, entry) => sum + numberValue(entry.amount), 0));
}

async function applyWallet({ publicId, actorId, payload }) {
  return sequelize.transaction(async (transaction) => {
    const budget = await loadBudgetByPublicId(publicId, transaction);
    if (!['accepted', 'partially_accepted', 'presented'].includes(budget.status)) {
      throw domainError(409, 'budget_not_payable', 'El presupuesto todavía no admite saldo.');
    }
    await Paciente.findByPk(budget.patient_id, {
      attributes: ['id_paciente'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const amount = roundMoney(payload.amount);
    const available = await walletBalance({
      clinicId: budget.clinic_id,
      patientId: budget.patient_id,
      transaction,
    });
    if (amount <= 0 || amount > available) {
      throw domainError(400, 'wallet_balance_insufficient', 'El saldo disponible no cubre el importe solicitado.', {
        available,
      });
    }
    const [version, confirmedPayments, previousAllocations] = await Promise.all([
      EconomicBudgetVersion.findOne({
        where: { budget_id: budget.id, version_number: budget.current_version },
        transaction,
      }),
      EconomicPayment.findAll({
        where: { budget_id: budget.id, status: 'confirmed' },
        transaction,
      }),
      PatientWalletEntry.findAll({
        where: { budget_id: budget.id, status: 'confirmed', entry_type: 'allocation' },
        transaction,
      }),
    ]);
    const payable = numberValue(budget.accepted_amount) > 0
      ? numberValue(budget.accepted_amount)
      : numberValue(parseJson(version?.totals, {}).total);
    const alreadyApplied = roundMoney(
      confirmedPayments.reduce((sum, item) => sum + paymentAppliedToBudget(item), 0)
      + previousAllocations.reduce((sum, item) => sum + Math.abs(numberValue(item.amount)), 0)
    );
    const pending = roundMoney(Math.max(0, payable - alreadyApplied));
    if (amount > pending + 0.01) {
      throw domainError(400, 'wallet_allocation_exceeds_pending', 'El saldo aplicado supera lo pendiente.', {
        pending,
      });
    }
    const entry = await PatientWalletEntry.create({
      public_id: crypto.randomUUID(),
      clinic_id: budget.clinic_id,
      patient_id: budget.patient_id,
      budget_id: budget.id,
      entry_type: 'allocation',
      amount: -amount,
      reference: cleanString(payload.reference, 120) || budget.number,
      notes: cleanString(payload.notes, 2000) || `Aplicado a ${budget.number}`,
      occurred_at: new Date(),
      created_by: actorId,
      created_at: new Date(),
    }, { transaction });
    if (roundMoney(alreadyApplied + amount) >= payable) {
      await activateVouchers({ budget, rule: 'on_full_payment', actorId, transaction });
    }
    return {
      entry: serializeWalletEntry(entry, budget.public_id),
      balance: roundMoney(available - amount),
    };
  });
}

async function consumeVoucher({ publicId, actorId, payload }) {
  return sequelize.transaction(async (transaction) => {
    const voucher = await PatientVoucher.findOne({
      where: { public_id: cleanString(publicId, 36) },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!voucher) throw domainError(404, 'voucher_not_found', 'Bono no encontrado.');
    const appointmentId = optionalPositiveInteger(payload.appointment_id);
    if (appointmentId) {
      const existingMovement = await PatientVoucherMovement.findOne({
        where: {
          voucher_id: voucher.id,
          movement_type: 'consumption',
          appointment_id: appointmentId,
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (existingMovement) {
        return {
          voucher: serializeVoucher(voucher, [existingMovement]),
          movement: existingMovement.toJSON(),
          already_consumed: true,
        };
      }
    }
    if (voucher.status !== 'active') throw domainError(409, 'voucher_not_active', 'El bono no está activo.');
    const units = roundMoney(payload.units);
    const available = numberValue(voucher.available_units);
    if (units <= 0 || units > available) {
      throw domainError(400, 'voucher_units_invalid', 'Las unidades consumidas no son válidas.', { available });
    }
    const remaining = roundMoney(available - units);
    await voucher.update({ available_units: remaining, status: remaining <= 0 ? 'consumed' : 'active' }, { transaction });
    const movement = await PatientVoucherMovement.create({
      voucher_id: voucher.id,
      movement_type: 'consumption',
      units: -units,
      appointment_id: appointmentId,
      notes: cleanString(payload.notes, 2000) || null,
      occurred_at: dateOrNull(payload.occurred_at) || new Date(),
      created_by: actorId,
      created_at: new Date(),
    }, { transaction });
    return { voucher: serializeVoucher(voucher, []), movement: movement.toJSON() };
  });
}

async function consumeVoucherForCompletedAppointment({ appointmentId, actorId }) {
  const normalizedAppointmentId = optionalPositiveInteger(appointmentId);
  if (!normalizedAppointmentId) {
    return { consumed: false, reason: 'appointment_id_invalid' };
  }

  return sequelize.transaction(async (transaction) => {
    const appointment = await CitaPaciente.findByPk(normalizedAppointmentId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!appointment) return { consumed: false, reason: 'appointment_not_found' };
    if (String(appointment.estado || '') !== 'completada') {
      return { consumed: false, reason: 'appointment_not_completed' };
    }

    const voucherId = optionalPositiveInteger(appointment.voucher_id);
    if (!voucherId) return { consumed: false, reason: 'appointment_without_voucher' };

    const voucher = await PatientVoucher.findOne({
      where: {
        id: voucherId,
        clinic_id: appointment.clinica_id,
        patient_id: appointment.paciente_id,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!voucher) return { consumed: false, reason: 'voucher_not_found' };

    const existingMovement = await PatientVoucherMovement.findOne({
      where: {
        voucher_id: voucher.id,
        movement_type: 'consumption',
        appointment_id: appointment.id_cita,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existingMovement) {
      return {
        consumed: false,
        already_consumed: true,
        reason: 'already_consumed_for_appointment',
        voucher_id: voucher.public_id,
        movement_id: String(existingMovement.id),
        available_units: numberValue(voucher.available_units),
      };
    }

    if (voucher.status !== 'active') {
      return {
        consumed: false,
        reason: 'voucher_not_active',
        voucher_id: voucher.public_id,
        available_units: numberValue(voucher.available_units),
      };
    }

    const available = numberValue(voucher.available_units);
    if (available <= 0) {
      return {
        consumed: false,
        reason: 'voucher_without_available_units',
        voucher_id: voucher.public_id,
        available_units: available,
      };
    }

    const remaining = roundMoney(available - 1);
    await voucher.update({
      available_units: Math.max(0, remaining),
      status: remaining <= 0 ? 'consumed' : 'active',
    }, { transaction });
    const movement = await PatientVoucherMovement.create({
      voucher_id: voucher.id,
      movement_type: 'consumption',
      units: -1,
      appointment_id: appointment.id_cita,
      notes: `Consumo automático al confirmar asistencia de la cita ${appointment.id_cita}.`,
      occurred_at: new Date(),
      created_by: actorId,
      created_at: new Date(),
    }, { transaction });

    return {
      consumed: true,
      reason: 'consumed_on_attendance',
      voucher_id: voucher.public_id,
      movement_id: String(movement.id),
      consumed_units: 1,
      available_units: Math.max(0, remaining),
    };
  });
}

async function createVoucher({ patientIdentifier, clinicId, actorId, payload }) {
  const context = await loadContext(patientIdentifier, clinicId);
  const { patient } = context;
  const treatmentId = optionalPositiveInteger(payload.treatment_id);
  await resolveCatalogItemForClinic(treatmentId, context);
  const totalUnits = roundMoney(payload.total_units);
  const availableUnits = payload.available_units == null
    ? totalUnits
    : roundMoney(payload.available_units);
  if (totalUnits <= 0 || availableUnits < 0 || availableUnits > totalUnits) {
    throw domainError(400, 'voucher_units_invalid', 'Las unidades del bono no son válidas.');
  }
  const name = cleanString(payload.name, 180);
  if (!name) throw domainError(400, 'voucher_name_required', 'El bono necesita un nombre.');
  let status = cleanString(payload.status, 20) || 'active';
  if (!['pending', 'active', 'consumed', 'expired', 'cancelled'].includes(status)) {
    throw domainError(400, 'voucher_status_invalid', 'El estado del bono no es válido.');
  }
  if (status === 'active' && availableUnits === 0) status = 'consumed';
  if (status === 'consumed' && availableUnits > 0) {
    throw domainError(400, 'voucher_status_units_mismatch', 'Un bono consumido no puede conservar unidades disponibles.');
  }
  const sourceSystem = cleanString(payload.source_system, 40) || 'clinicaclick';
  const sourceReference = cleanString(payload.source_reference, 120) || null;
  return sequelize.transaction(async (transaction) => {
    await Paciente.findByPk(patient.id_paciente, {
      attributes: ['id_paciente'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (sourceReference) {
      const existing = await PatientVoucher.findOne({
        where: {
          clinic_id: clinicId,
          source_system: sourceSystem,
          source_reference: sourceReference,
        },
        transaction,
      });
      if (existing) {
        const movements = await PatientVoucherMovement.findAll({
          where: { voucher_id: existing.id },
          order: [['occurred_at', 'ASC']],
          transaction,
        });
        return serializeVoucher(existing, movements);
      }
    }
    const voucher = await PatientVoucher.create({
      public_id: crypto.randomUUID(),
      clinic_id: clinicId,
      patient_id: patient.id_paciente,
      budget_id: null,
      budget_line_key: null,
      treatment_id: treatmentId,
      name,
      unit_label: cleanString(payload.unit_label, 40) || 'sesiones',
      total_units: totalUnits,
      available_units: availableUnits,
      sold_amount: roundMoney(payload.sold_amount || 0),
      activation_rule: 'manual',
      status,
      expires_at: dateOrNull(payload.expires_at),
      source_system: sourceSystem,
      source_reference: sourceReference,
      created_by: actorId,
    }, { transaction });
    if (status === 'active') {
      await PatientVoucherMovement.create({
        voucher_id: voucher.id,
        movement_type: 'activation',
        units: availableUnits,
        notes: cleanString(payload.notes, 2000) || 'Bono incorporado manualmente.',
        occurred_at: dateOrNull(payload.occurred_at) || new Date(),
        created_by: actorId,
        created_at: new Date(),
      }, { transaction });
    }
    return serializeVoucher(voucher, []);
  });
}

async function sellVoucher({ patientIdentifier, clinicId, actorId, payload }) {
  const context = await loadContext(patientIdentifier, clinicId);
  const treatmentId = optionalPositiveInteger(payload.treatment_id);
  const catalogItem = await resolveCatalogItemForClinic(treatmentId, context);
  const name = cleanString(payload.name || catalogItem?.name, 180);
  const totalUnits = roundMoney(payload.total_units ?? catalogItem?.default_units);
  const unitLabel = cleanString(payload.unit_label || catalogItem?.unit_label, 40) || 'sesiones';
  const requestedTotal = roundMoney(payload.sold_amount ?? catalogItem?.base_price);
  if (!name) throw domainError(400, 'voucher_name_required', 'El bono necesita un nombre.');
  if (totalUnits <= 0 || requestedTotal < 0) {
    throw domainError(400, 'voucher_sale_invalid', 'Revisa las sesiones y el precio del bono.');
  }
  const saleToken = cleanString(payload.sale_reference, 80) || crypto.randomUUID();
  const sourceReference = `voucher-sale:${saleToken}`;
  const lineKey = `voucher-${saleToken}`.slice(0, 80);
  const productType = ['voucher', 'pack'].includes(catalogItem?.product_type)
    ? catalogItem.product_type
    : 'voucher';
  let budget = await createBudget({
    patientIdentifier,
    clinicId,
    actorId,
    payload: {
      status: 'presented',
      source_system: 'clinicaclick',
      source_reference: sourceReference,
      valid_until: payload.valid_until,
      lines: [{
        key: lineKey,
        treatment_id: treatmentId,
        code: catalogItem?.code || `BONO-${saleToken.slice(0, 8)}`,
        name,
        description: cleanString(payload.description || catalogItem?.description, 500),
        product_type: productType,
        area_code: catalogItem?.area_code || 'general',
        specialty: catalogItem?.specialty || null,
        category: catalogItem?.category || 'Bonos',
        quantity: totalUnits,
        unit_label: unitLabel,
        unit_price: totalUnits ? roundMoney(requestedTotal / totalUnits) : 0,
        discount_percent: 0,
        activation_rule: 'on_acceptance',
        notes: cleanString(payload.notes, 500) || null,
      }],
      global_discount_percent: 0,
      payment_proposal: {
        mode: 'single',
        included_modes: ['single'],
        single_payment: { amount: requestedTotal, savings: 0 },
        schedule: [],
        financing_options: [],
      },
      notes: cleanString(payload.patient_notes, 10000) || null,
      internal_notes: cleanString(payload.notes, 10000) || null,
    },
  });
  if (budget.status === 'draft') {
    budget = await transitionBudget({
      publicId: budget.id,
      actorId,
      action: 'present',
    });
  }
  if (budget.status === 'presented') {
    budget = await transitionBudget({
      publicId: budget.id,
      actorId,
      action: 'accept',
    });
  }
  if (!['accepted', 'partially_accepted'].includes(budget.status)) {
    throw domainError(409, 'voucher_sale_budget_invalid', 'La venta no ha podido quedar aceptada.');
  }

  const storedBudget = await EconomicBudget.findOne({
    where: { public_id: budget.id, clinic_id: context.clinicId },
  });
  const voucher = await PatientVoucher.findOne({
    where: {
      budget_id: storedBudget.id,
      budget_line_key: lineKey,
    },
  });
  if (!voucher) throw domainError(500, 'voucher_sale_not_created', 'No se pudo activar el bono vendido.');
  if (payload.expires_at) {
    await voucher.update({ expires_at: dateOrNull(payload.expires_at) });
  }

  let payment = null;
  if (payload.collect_now && numberValue(budget.accepted_amount) > 0) {
    const paymentReference = `voucher-payment:${saleToken}`;
    const existingPayment = await EconomicPayment.findOne({
      where: {
        budget_id: storedBudget.id,
        reference: paymentReference,
        status: 'confirmed',
      },
    });
    if (existingPayment) {
      payment = serializePayment(existingPayment, budget.id);
    } else {
      const pending = numberValue(budget.accepted_amount);
      const requestedPayment = payload.payment_amount == null
        ? pending
        : roundMoney(payload.payment_amount);
      if (requestedPayment <= 0 || requestedPayment > pending + 0.01) {
        throw domainError(
          400,
          'voucher_payment_amount_invalid',
          'El cobro debe ser mayor que cero y no superar el precio del bono.',
          { pending },
        );
      }
      payment = await createPayment({
        publicId: budget.id,
        actorId,
        payload: {
          amount: requestedPayment,
          method: payload.payment_method,
          reference: paymentReference,
          notes: cleanString(payload.payment_notes, 2000) || `Venta de ${name}`,
          paid_at: payload.paid_at,
          allocations: [{
            target_type: 'budget',
            amount: requestedPayment,
            label: name,
          }],
        },
      });
    }
  }
  voucher.setDataValue('budget_public_id', budget.id);
  const movements = await PatientVoucherMovement.findAll({
    where: { voucher_id: voucher.id },
    order: [['occurred_at', 'ASC']],
  });
  return {
    budget,
    voucher: serializeVoucher(voucher, movements),
    payment,
  };
}

function normalizeFiscalParty(raw, fallback = {}) {
  const party = { ...fallback, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    name: cleanString(party.name || party.legal_name, 180),
    legal_name: cleanString(party.legal_name || party.name, 180),
    tax_id: cleanString(party.tax_id, 40),
    address: cleanString(party.address, 255),
    postal_code: cleanString(party.postal_code, 20),
    city: cleanString(party.city, 100),
    province: cleanString(party.province, 100),
    country: cleanString(party.country, 80) || 'España',
    email: cleanString(party.email, 180) || null,
    phone: cleanString(party.phone, 50) || null,
  };
}

function normalizeFiscalLines(rawLines, budgetVersion) {
  const source = Array.isArray(rawLines) && rawLines.length ? rawLines : parseJson(budgetVersion?.lines, []);
  if (!source.length) throw domainError(400, 'fiscal_lines_required', 'El documento necesita al menos un concepto.');
  return source.map((line, index) => {
    const quantity = Number(line.quantity ?? line.cantidad ?? 1);
    const unitPrice = Number(line.unit_price ?? line.precio_unitario ?? line.unitPrice ?? line.total);
    const discountPercent = Number(line.discount_percent ?? line.discount ?? 0);
    const taxPercent = Number(line.tax_percent ?? line.vat_percent ?? 0);
    if (![quantity, unitPrice, discountPercent, taxPercent].every(Number.isFinite) || quantity <= 0 || unitPrice < 0) {
      throw domainError(400, 'fiscal_line_invalid', `La línea fiscal ${index + 1} no es válida.`);
    }
    if (discountPercent < 0 || discountPercent > 100) {
      throw domainError(400, 'fiscal_line_discount_invalid', `El descuento de la línea fiscal ${index + 1} no es válido.`);
    }
    if (taxPercent < 0 || taxPercent > 100) {
      throw domainError(400, 'fiscal_line_tax_invalid', `El impuesto de la línea fiscal ${index + 1} no es válido.`);
    }
    const description = cleanString(line.description || line.name || line.nombre, 500);
    if (!description) {
      throw domainError(400, 'fiscal_line_description_required', `La línea fiscal ${index + 1} necesita un concepto.`);
    }
    const baseBeforeDiscount = roundMoney(quantity * unitPrice);
    const taxableBase = roundMoney(baseBeforeDiscount * (1 - discountPercent / 100));
    const taxAmount = roundMoney(taxableBase * taxPercent / 100);
    return {
      key: cleanString(line.key, 80) || `fiscal-line-${index + 1}`,
      description,
      quantity: roundMoney(quantity),
      unit_price: roundMoney(unitPrice),
      discount_percent: roundMoney(discountPercent),
      tax_percent: roundMoney(taxPercent),
      exemption_reason: cleanString(line.exemption_reason, 500) || null,
      taxable_base: taxableBase,
      tax_amount: taxAmount,
      total: roundMoney(taxableBase + taxAmount),
    };
  });
}

async function nextFiscalNumber({ clinicId, documentType, series, transaction }) {
  await Clinica.findByPk(clinicId, {
    attributes: ['id_clinica'],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const year = new Date().getFullYear();
  const numberPrefix = `${series}-${year}-`;
  const existingDocuments = await PatientFiscalDocument.findAll({
    where: {
      clinic_id: clinicId,
      document_type: documentType,
      series,
      number: { [Op.like]: `${numberPrefix}%` },
    },
    attributes: ['number'],
    transaction,
  });
  const lastSequence = existingDocuments.reduce((max, existingDocument) => {
    const sequence = Number.parseInt(String(existingDocument.number).slice(numberPrefix.length), 10);
    return Number.isInteger(sequence) ? Math.max(max, sequence) : max;
  }, 0);
  return `${numberPrefix}${String(lastSequence + 1).padStart(4, '0')}`;
}

function assertFiscalParties({ documentType, status, issuer, recipient }) {
  if (documentType === 'receipt' || status !== 'issued') return;
  const required = ['legal_name', 'tax_id', 'address', 'postal_code', 'city', 'country'];
  const recipientMissing = required.filter((field) => !recipient[field]);
  const issuerMissing = required.filter((field) => !issuer[field]);
  if (recipientMissing.length) {
    throw domainError(400, 'invoice_recipient_incomplete', 'Completa los datos fiscales del destinatario.', {
      missing: recipientMissing,
    });
  }
  if (issuerMissing.length) {
    throw domainError(400, 'invoice_issuer_incomplete', 'Completa los datos fiscales de la clínica.', {
      missing: issuerMissing,
    });
  }
}

async function createPatientFiscalDocument({
  patientIdentifier,
  clinicId,
  actorId,
  payload,
}) {
  return sequelize.transaction(async (transaction) => {
    const { patient, clinic } = await loadContext(patientIdentifier, clinicId);
    const sourceType = cleanString(payload.source_type || payload.source?.type || 'manual', 20).toLowerCase();
    if (!['manual', 'budget', 'payment'].includes(sourceType)) {
      throw domainError(400, 'fiscal_source_invalid', 'El origen del documento no es válido.');
    }
    let budget = null;
    let payment = null;
    let version = null;
    if (sourceType === 'budget') {
      const budgetId = cleanString(payload.source_id || payload.source?.id, 36);
      budget = await EconomicBudget.findOne({
        where: {
          public_id: budgetId,
          clinic_id: clinicId,
          patient_id: patient.id_paciente,
        },
        transaction,
      });
      if (!budget) throw domainError(404, 'budget_not_found', 'Presupuesto no encontrado.');
      version = await EconomicBudgetVersion.findOne({
        where: { budget_id: budget.id, version_number: budget.current_version },
        transaction,
      });
    } else if (sourceType === 'payment') {
      const paymentId = cleanString(payload.source_id || payload.source?.id, 36);
      payment = await EconomicPayment.findOne({
        where: {
          public_id: paymentId,
          clinic_id: clinicId,
          patient_id: patient.id_paciente,
          status: 'confirmed',
        },
        transaction,
      });
      if (!payment) throw domainError(404, 'payment_not_found', 'Cobro no encontrado.');
      if (payment.budget_id) {
        budget = await EconomicBudget.findByPk(payment.budget_id, { transaction });
        version = budget
          ? await EconomicBudgetVersion.findOne({
            where: { budget_id: budget.id, version_number: payment.budget_version || budget.current_version },
            transaction,
          })
          : null;
      }
    }
    const documentType = cleanString(payload.document_type, 20).toLowerCase();
    if (!FISCAL_DOCUMENT_TYPES.has(documentType)) {
      throw domainError(400, 'fiscal_document_type_invalid', 'El tipo de documento no es válido.');
    }
    const status = cleanString(payload.status || 'draft', 20);
    if (!['draft', 'issued'].includes(status)) {
      throw domainError(400, 'fiscal_document_status_invalid', 'Estado fiscal no válido.');
    }
    const issuer = normalizeFiscalParty(payload.issuer, mapClinicSnapshot(clinic));
    const recipient = normalizeFiscalParty(payload.recipient, mapPatientSnapshot(patient));
    assertFiscalParties({ documentType, status, issuer, recipient });
    const lines = normalizeFiscalLines(payload.lines, version);
    const totals = {
      currency: 'EUR',
      taxable_base: roundMoney(lines.reduce((sum, line) => sum + line.taxable_base, 0)),
      taxes: roundMoney(lines.reduce((sum, line) => sum + line.tax_amount, 0)),
      total: roundMoney(lines.reduce((sum, line) => sum + line.total, 0)),
    };
    if (documentType !== 'credit_note' && sourceType !== 'manual') {
      const sourceWhere = sourceType === 'budget'
        ? { budget_id: budget.id }
        : { payment_id: payment.id };
      const previousDocuments = await PatientFiscalDocument.findAll({
        where: {
          clinic_id: clinicId,
          patient_id: patient.id_paciente,
          status: { [Op.ne]: 'voided' },
          document_type: { [Op.in]: ['invoice', 'receipt'] },
          ...sourceWhere,
        },
        attributes: ['totals'],
        transaction,
      });
      const alreadyDocumented = roundMoney(previousDocuments.reduce(
        (sum, document) => sum + numberValue(parseJson(document.totals, {}).total),
        0,
      ));
      const sourceAmount = sourceType === 'payment'
        ? roundMoney(payment.amount)
        : numberValue(parseJson(version?.totals, {}).total);
      if (totals.total - roundMoney(sourceAmount - alreadyDocumented) > 0.01) {
        throw domainError(
          409,
          'fiscal_source_amount_exceeded',
          'El importe supera la parte pendiente de documentar.',
          {
            source_amount: sourceAmount,
            already_documented: alreadyDocumented,
            available: roundMoney(Math.max(0, sourceAmount - alreadyDocumented)),
          },
        );
      }
    }
    const template = await resolveTemplate({
      clinicId,
      templateId: payload.template_id,
      templateType: 'invoice',
    });
    const series = cleanString(payload.series, 30) || (documentType === 'receipt' ? 'REC' : 'FAC');
    const number = cleanString(payload.number, 60)
      || await nextFiscalNumber({ clinicId, documentType, series, transaction });
    const sourceData = {
      ...(payload.payment_data && typeof payload.payment_data === 'object' ? payload.payment_data : {}),
      source: {
        type: sourceType,
        id: sourceType === 'budget'
          ? budget?.public_id
          : sourceType === 'payment'
            ? payment?.public_id
            : null,
        applied_amount: totals.total,
      },
    };
    const document = await PatientFiscalDocument.create({
      public_id: crypto.randomUUID(),
      clinic_id: clinicId,
      patient_id: patient.id_paciente,
      budget_id: budget?.id || null,
      payment_id: payment?.id || null,
      document_type: documentType,
      series,
      number,
      status,
      issue_date: dateOrNull(payload.issue_date) || new Date(),
      due_date: dateOrNull(payload.due_date),
      issuer_snapshot: issuer,
      recipient_snapshot: recipient,
      lines,
      totals,
      payment_data: sourceData,
      template_snapshot: {
        id: template.public_id,
        name: template.name,
        config: {
          ...cloneJson(template.config),
          logo_mode: payload.logo_mode || template.config?.logo_mode || 'clinic',
          logo_url: cleanString(payload.logo_url, 1000) || template.config?.logo_url || null,
        },
      },
      verifactu_status: documentType === 'receipt'
        ? 'not_applicable'
        : (status === 'issued' ? 'ready' : 'mock_pending'),
      notes: cleanString(payload.notes, 5000) || null,
      created_by: actorId,
      updated_by: actorId,
    }, { transaction });
    return serializeFiscalDocument(document, budget?.public_id || null);
  });
}

async function createFiscalDocument({ publicId, actorId, payload }) {
  return sequelize.transaction(async (transaction) => {
    const budget = await loadBudgetByPublicId(publicId, transaction);
    const [clinic, patient, version] = await Promise.all([
      Clinica.findByPk(budget.clinic_id, { transaction }),
      Paciente.findByPk(budget.patient_id, { transaction }),
      EconomicBudgetVersion.findOne({
        where: { budget_id: budget.id, version_number: budget.current_version },
        transaction,
      }),
    ]);
    const documentType = cleanString(payload.document_type, 20).toLowerCase();
    if (!FISCAL_DOCUMENT_TYPES.has(documentType)) {
      throw domainError(400, 'fiscal_document_type_invalid', 'El tipo de documento no es válido.');
    }
    const issuer = normalizeFiscalParty(payload.issuer, mapClinicSnapshot(clinic));
    const recipient = normalizeFiscalParty(payload.recipient, mapPatientSnapshot(patient));
    if (documentType !== 'receipt') {
      const required = ['legal_name', 'tax_id', 'address', 'postal_code', 'city', 'country'];
      const missing = required.filter((field) => !recipient[field]);
      if (missing.length) {
        throw domainError(400, 'invoice_recipient_incomplete', 'Completa los datos fiscales del destinatario.', { missing });
      }
      const issuerMissing = required.filter((field) => !issuer[field]);
      if (issuerMissing.length) {
        throw domainError(400, 'invoice_issuer_incomplete', 'Completa los datos fiscales de la clínica.', { missing: issuerMissing });
      }
    }
    const lines = normalizeFiscalLines(payload.lines, version);
    const totals = {
      currency: 'EUR',
      taxable_base: roundMoney(lines.reduce((sum, line) => sum + line.taxable_base, 0)),
      taxes: roundMoney(lines.reduce((sum, line) => sum + line.tax_amount, 0)),
      total: roundMoney(lines.reduce((sum, line) => sum + line.total, 0)),
    };
    const template = await resolveTemplate({
      clinicId: budget.clinic_id,
      templateId: payload.template_id,
      templateType: 'invoice',
    });
    const series = cleanString(payload.series, 30) || (documentType === 'receipt' ? 'REC' : 'FAC');
    await Clinica.findByPk(budget.clinic_id, {
      attributes: ['id_clinica'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const year = new Date().getFullYear();
    const numberPrefix = `${series}-${year}-`;
    const existingDocuments = await PatientFiscalDocument.findAll({
      where: {
        clinic_id: budget.clinic_id,
        document_type: documentType,
        series,
        number: { [Op.like]: `${numberPrefix}%` },
      },
      attributes: ['number'],
      transaction,
    });
    const lastSequence = existingDocuments.reduce((max, existingDocument) => {
      const sequence = Number.parseInt(String(existingDocument.number).slice(numberPrefix.length), 10);
      return Number.isInteger(sequence) ? Math.max(max, sequence) : max;
    }, 0);
    const number = cleanString(payload.number, 60)
      || `${numberPrefix}${String(lastSequence + 1).padStart(4, '0')}`;
    const status = cleanString(payload.status || 'draft', 20);
    if (!['draft', 'issued'].includes(status)) throw domainError(400, 'fiscal_document_status_invalid', 'Estado fiscal no válido.');
    const document = await PatientFiscalDocument.create({
      public_id: crypto.randomUUID(),
      clinic_id: budget.clinic_id,
      patient_id: budget.patient_id,
      budget_id: budget.id,
      payment_id: null,
      document_type: documentType,
      series,
      number,
      status,
      issue_date: dateOrNull(payload.issue_date) || new Date(),
      due_date: dateOrNull(payload.due_date),
      issuer_snapshot: issuer,
      recipient_snapshot: recipient,
      lines,
      totals,
      payment_data: payload.payment_data || null,
      template_snapshot: { id: template.public_id, name: template.name, config: cloneJson(template.config) },
      verifactu_status: documentType === 'receipt'
        ? 'not_applicable'
        : (status === 'issued' ? 'ready' : 'mock_pending'),
      notes: cleanString(payload.notes, 5000) || null,
      created_by: actorId,
      updated_by: actorId,
    }, { transaction });
    return serializeFiscalDocument(document, budget.public_id);
  });
}

async function updateFiscalDocument({ publicId, actorId, payload }) {
  return sequelize.transaction(async (transaction) => {
    const document = await PatientFiscalDocument.findOne({
      where: { public_id: cleanString(publicId, 36) },
      transaction,
    });
    if (!document) throw domainError(404, 'fiscal_document_not_found', 'Documento fiscal no encontrado.');
    if (document.status !== 'draft') {
      throw domainError(409, 'fiscal_document_not_editable', 'Solo se pueden editar documentos en borrador.');
    }
    const [budget, clinic, patient] = await Promise.all([
      document.budget_id ? EconomicBudget.findByPk(document.budget_id, { transaction }) : null,
      Clinica.findByPk(document.clinic_id, { transaction }),
      Paciente.findByPk(document.patient_id, { transaction }),
    ]);
    const version = budget
      ? await EconomicBudgetVersion.findOne({
        where: { budget_id: budget.id, version_number: budget.current_version },
        transaction,
      })
      : null;
    const issuer = normalizeFiscalParty(
      payload.issuer,
      parseJson(document.issuer_snapshot, mapClinicSnapshot(clinic))
    );
    const recipient = normalizeFiscalParty(
      payload.recipient,
      parseJson(document.recipient_snapshot, mapPatientSnapshot(patient))
    );
    const lines = normalizeFiscalLines(payload.lines || parseJson(document.lines, []), version);
    const requestedStatus = cleanString(payload.status || 'draft', 20);
    if (!['draft', 'issued'].includes(requestedStatus)) {
      throw domainError(400, 'fiscal_document_status_invalid', 'Estado fiscal no válido.');
    }
    if (document.document_type !== 'receipt' && requestedStatus === 'issued') {
      const required = ['legal_name', 'tax_id', 'address', 'postal_code', 'city', 'country'];
      const recipientMissing = required.filter((field) => !recipient[field]);
      const issuerMissing = required.filter((field) => !issuer[field]);
      if (recipientMissing.length) {
        throw domainError(400, 'invoice_recipient_incomplete', 'Completa los datos fiscales del destinatario.', {
          missing: recipientMissing,
        });
      }
      if (issuerMissing.length) {
        throw domainError(400, 'invoice_issuer_incomplete', 'Completa los datos fiscales de la clínica.', {
          missing: issuerMissing,
        });
      }
    }
    const totals = {
      currency: 'EUR',
      taxable_base: roundMoney(lines.reduce((sum, line) => sum + line.taxable_base, 0)),
      taxes: roundMoney(lines.reduce((sum, line) => sum + line.tax_amount, 0)),
      total: roundMoney(lines.reduce((sum, line) => sum + line.total, 0)),
    };
    const template = await resolveTemplate({
      clinicId: document.clinic_id,
      templateId: payload.template_id || parseJson(document.template_snapshot, {}).id,
      templateType: 'invoice',
    });
    await document.update({
      status: requestedStatus,
      issue_date: dateOrNull(payload.issue_date) || document.issue_date,
      due_date: payload.due_date === null ? null : (dateOrNull(payload.due_date) || document.due_date),
      issuer_snapshot: issuer,
      recipient_snapshot: recipient,
      lines,
      totals,
      payment_data: payload.payment_data ?? document.payment_data,
      template_snapshot: { id: template.public_id, name: template.name, config: cloneJson(template.config) },
      verifactu_status: document.document_type === 'receipt'
        ? 'not_applicable'
        : (requestedStatus === 'issued' ? 'ready' : 'mock_pending'),
      notes: payload.notes === undefined ? document.notes : (cleanString(payload.notes, 5000) || null),
      updated_by: actorId,
    }, { transaction });
    return serializeFiscalDocument(document, budget?.public_id || null);
  });
}

async function saveTemplate({ clinicId, actorId, payload, publicId = null }) {
  const templateType = cleanString(payload.template_type, 20);
  if (!TEMPLATE_TYPES.has(templateType)) throw domainError(400, 'template_type_invalid', 'Tipo de plantilla no válido.');
  const name = cleanString(payload.name, 120);
  if (!name) throw domainError(400, 'template_name_required', 'La plantilla necesita un nombre.');
  const config = payload.config && typeof payload.config === 'object' ? cloneJson(payload.config) : null;
  if (!config) throw domainError(400, 'template_config_required', 'La plantilla necesita configuración.');
  return sequelize.transaction(async (transaction) => {
    let template = null;
    if (publicId) {
      template = await ClinicEconomicTemplate.findOne({
        where: { public_id: cleanString(publicId, 36), clinic_id: clinicId },
        transaction,
      });
      if (!template) throw domainError(404, 'template_not_found', 'Plantilla no encontrada.');
    }
    if (payload.is_default) {
      await ClinicEconomicTemplate.update(
        { is_default: false, updated_by: actorId },
        { where: { clinic_id: clinicId, template_type: templateType }, transaction }
      );
    }
    const values = {
      clinic_id: clinicId,
      template_type: templateType,
      name,
      area_code: cleanString(payload.area_code, 50) || null,
      config,
      is_default: !!payload.is_default,
      active: payload.active !== false,
      updated_by: actorId,
    };
    if (template) {
      await template.update(values, { transaction });
    } else {
      template = await ClinicEconomicTemplate.create({
        public_id: crypto.randomUUID(),
        ...values,
        created_by: actorId,
      }, { transaction });
    }
    return { ...template.toJSON(), source: 'clinic' };
  });
}

function serializeVersion(version) {
  return {
    version: Number(version.version_number),
    lines: parseJson(version.lines, []),
    totals: parseJson(version.totals, {}),
    payment_proposal: serializePaymentProposal(version.payment_proposal),
    design_config: parseJson(version.design_config, {}),
    clinic_snapshot: parseJson(version.clinic_snapshot, {}),
    patient_snapshot: parseJson(version.patient_snapshot, {}),
    notes: version.notes || null,
    internal_notes: version.internal_notes || null,
    change_summary: version.change_summary || null,
    created_by: version.created_by || null,
    created_at: version.created_at,
  };
}

function serializeEvent(event) {
  return {
    id: String(event.id),
    version: Number(event.version_number),
    event_type: event.event_type,
    from_status: event.from_status,
    to_status: event.to_status,
    metadata: parseJson(event.metadata, {}),
    actor_id: event.actor_id || null,
    created_at: event.created_at,
  };
}

function serializeBudget(budget, version, events, payments, walletApplied = 0) {
  const paid = roundMoney(payments
    .filter((payment) => payment.status === 'confirmed')
    .reduce((sum, payment) => sum + paymentAppliedToBudget(payment), 0) + walletApplied);
  const serializedVersion = serializeVersion(version);
  const payable = numberValue(budget.accepted_amount) > 0
    ? numberValue(budget.accepted_amount)
    : numberValue(serializedVersion.totals.total);
  return {
    id: budget.public_id,
    number: budget.number,
    clinic_id: Number(budget.clinic_id),
    patient_id: Number(budget.patient_id),
    status: budget.status,
    current_version: Number(budget.current_version),
    valid_until: budget.valid_until,
    presented_at: budget.presented_at,
    responded_at: budget.responded_at,
    accepted_amount: numberValue(budget.accepted_amount),
    source_system: budget.source_system,
    source_reference: budget.source_reference,
    created_at: budget.created_at,
    updated_at: budget.updated_at,
    current: serializedVersion,
    events: events.map(serializeEvent),
    financial_summary: {
      payable: roundMoney(payable),
      paid,
      pending: roundMoney(Math.max(0, payable - paid)),
    },
  };
}

function serializePayment(payment, budgetPublicId = null) {
  return {
    id: payment.public_id,
    budget_id: budgetPublicId,
    amount: numberValue(payment.amount),
    method: payment.method,
    status: payment.status,
    reference: payment.reference,
    application: parseJson(payment.application, {}),
    notes: payment.notes,
    paid_at: payment.paid_at,
    created_by: payment.created_by,
    created_at: payment.created_at,
  };
}

function serializeWalletEntry(entry, budgetPublicId = null) {
  return {
    id: entry.public_id,
    budget_id: budgetPublicId,
    entry_type: entry.entry_type,
    amount: numberValue(entry.amount),
    status: entry.status,
    reference: entry.reference,
    notes: entry.notes,
    occurred_at: entry.occurred_at,
    created_by: entry.created_by,
  };
}

function serializeVoucher(voucher, movements) {
  return {
    id: voucher.public_id,
    budget_id: voucher.budget_public_id || null,
    budget_line_key: voucher.budget_line_key,
    treatment_id: voucher.treatment_id ? Number(voucher.treatment_id) : null,
    name: voucher.name,
    unit_label: voucher.unit_label,
    total_units: numberValue(voucher.total_units),
    available_units: numberValue(voucher.available_units),
    sold_amount: numberValue(voucher.sold_amount),
    activation_rule: voucher.activation_rule,
    status: voucher.status,
    expires_at: voucher.expires_at,
    source_system: voucher.source_system,
    source_reference: voucher.source_reference,
    movements: movements.map((movement) => ({
      id: String(movement.id),
      movement_type: movement.movement_type,
      units: numberValue(movement.units),
      appointment_id: movement.appointment_id,
      notes: movement.notes,
      occurred_at: movement.occurred_at,
      created_by: movement.created_by,
    })),
  };
}

function serializeFiscalDocument(document, budgetPublicId = null) {
  return {
    id: document.public_id,
    budget_id: budgetPublicId,
    document_type: document.document_type,
    series: document.series,
    number: document.number,
    status: document.status,
    issue_date: document.issue_date,
    due_date: document.due_date,
    issuer: parseJson(document.issuer_snapshot, {}),
    recipient: parseJson(document.recipient_snapshot, {}),
    lines: parseJson(document.lines, []),
    totals: parseJson(document.totals, {}),
    payment_data: parseJson(document.payment_data, null),
    template: parseJson(document.template_snapshot, {}),
    verifactu_status: document.verifactu_status,
    notes: document.notes,
    created_at: document.created_at,
  };
}

async function getWorkspace({ patientIdentifier, clinicId }) {
  const { clinicId: resolvedClinicId, patient, clinic } = await loadContext(patientIdentifier, clinicId);
  const budgets = await EconomicBudget.findAll({
    where: { clinic_id: resolvedClinicId, patient_id: patient.id_paciente },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
  });
  const budgetIds = budgets.map((budget) => budget.id);
  const [
    versions,
    events,
    payments,
    walletEntries,
    vouchers,
    fiscalDocuments,
    templates,
  ] = await Promise.all([
    budgetIds.length
      ? EconomicBudgetVersion.findAll({ where: { budget_id: { [Op.in]: budgetIds } } })
      : [],
    budgetIds.length
      ? EconomicBudgetEvent.findAll({
        where: { budget_id: { [Op.in]: budgetIds } },
        order: [['created_at', 'ASC']],
      })
      : [],
    EconomicPayment.findAll({
      where: { clinic_id: resolvedClinicId, patient_id: patient.id_paciente },
      order: [['paid_at', 'DESC']],
    }),
    PatientWalletEntry.findAll({
      where: { clinic_id: resolvedClinicId, patient_id: patient.id_paciente },
      order: [['occurred_at', 'DESC']],
    }),
    PatientVoucher.findAll({
      where: { clinic_id: resolvedClinicId, patient_id: patient.id_paciente },
      order: [['created_at', 'DESC']],
    }),
    PatientFiscalDocument.findAll({
      where: { clinic_id: resolvedClinicId, patient_id: patient.id_paciente },
      order: [['issue_date', 'DESC'], ['id', 'DESC']],
    }),
    listTemplates({ clinicId: resolvedClinicId }),
  ]);
  const voucherIds = vouchers.map((voucher) => voucher.id);
  const voucherMovements = voucherIds.length
    ? await PatientVoucherMovement.findAll({
      where: { voucher_id: { [Op.in]: voucherIds } },
      order: [['occurred_at', 'ASC']],
    })
    : [];
  const budgetPublicIds = new Map(budgets.map((budget) => [String(budget.id), budget.public_id]));
  const currentVersions = new Map(
    versions.map((version) => [`${version.budget_id}:${version.version_number}`, version])
  );
  const eventsByBudget = new Map();
  for (const event of events) {
    const key = String(event.budget_id);
    eventsByBudget.set(key, [...(eventsByBudget.get(key) || []), event]);
  }
  const paymentsByBudget = new Map();
  for (const payment of payments) {
    const key = String(payment.budget_id || '');
    paymentsByBudget.set(key, [...(paymentsByBudget.get(key) || []), payment]);
  }
  const walletAppliedByBudget = new Map();
  for (const entry of walletEntries.filter((item) => item.status === 'confirmed' && item.budget_id && numberValue(item.amount) < 0)) {
    const key = String(entry.budget_id);
    walletAppliedByBudget.set(key, roundMoney((walletAppliedByBudget.get(key) || 0) + Math.abs(numberValue(entry.amount))));
  }
  const movementsByVoucher = new Map();
  for (const movement of voucherMovements) {
    const key = String(movement.voucher_id);
    movementsByVoucher.set(key, [...(movementsByVoucher.get(key) || []), movement]);
  }
  const serializedBudgets = budgets
    .map((budget) => {
      const version = currentVersions.get(`${budget.id}:${budget.current_version}`);
      return version
        ? serializeBudget(
          budget,
          version,
          eventsByBudget.get(String(budget.id)) || [],
          paymentsByBudget.get(String(budget.id)) || [],
          walletAppliedByBudget.get(String(budget.id)) || 0
        )
        : null;
    })
    .filter(Boolean);
  const wallet = walletEntries.map((entry) => serializeWalletEntry(
    entry,
    entry.budget_id ? budgetPublicIds.get(String(entry.budget_id)) : null
  ));
  const walletAvailable = roundMoney(walletEntries
    .filter((entry) => entry.status === 'confirmed')
    .reduce((sum, entry) => sum + numberValue(entry.amount), 0));
  return {
    patient: mapPatientSnapshot(patient),
    clinic: mapClinicSnapshot(clinic),
    budgets: serializedBudgets,
    payments: payments.map((payment) => serializePayment(
      payment,
      payment.budget_id ? budgetPublicIds.get(String(payment.budget_id)) : null
    )),
    wallet: { available: walletAvailable, entries: wallet },
    vouchers: vouchers.map((voucher) => {
      voucher.budget_public_id = voucher.budget_id ? budgetPublicIds.get(String(voucher.budget_id)) : null;
      return serializeVoucher(voucher, movementsByVoucher.get(String(voucher.id)) || []);
    }),
    fiscal_documents: fiscalDocuments.map((document) => serializeFiscalDocument(
      document,
      document.budget_id ? budgetPublicIds.get(String(document.budget_id)) : null
    )),
    templates,
    verifactu: {
      mode: 'mock',
      enabled: false,
      label: 'Preparado para integración futura',
    },
  };
}

module.exports = {
  domainError,
  loadContext,
  listCatalog,
  listTemplates,
  saveTemplate,
  getWorkspace,
  createBudget,
  updateDraftBudget,
  reviseBudget,
  transitionBudget,
  createPayment,
  createWalletDeposit,
  voidPayment,
  applyWallet,
  createVoucher,
  sellVoucher,
  consumeVoucher,
  consumeVoucherForCompletedAppointment,
  createFiscalDocument,
  createPatientFiscalDocument,
  updateFiscalDocument,
};
