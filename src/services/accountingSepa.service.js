'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const envelope = require('../lib/accountingSensitiveEnvelope');

const {
  sequelize,
  AccountingSepaMandate,
  AccountingRemittance,
  AccountingRemittanceItem,
  EconomicBudget,
  EconomicBudgetEvent,
  EconomicPayment,
  Paciente,
  PacienteClinica,
  Clinica,
} = db;

function domainError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function clean(value, max = 255) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function json(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function dateOnly(value) {
  const normalized = clean(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function normalizeIban(value) {
  const iban = clean(value, 40).replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) {
    throw domainError(400, 'sepa_iban_invalid', 'El IBAN no tiene un formato válido.');
  }
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  const numeric = rearranged.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  if (remainder !== 1) throw domainError(400, 'sepa_iban_invalid', 'El IBAN no supera la validación bancaria.');
  return iban;
}

function mandateContext(clinicId, publicId) {
  return `accounting-sepa:${clinicId}:${publicId}:iban`;
}

function serializeMandate(mandate, patient = null) {
  const value = mandate.toJSON ? mandate.toJSON() : mandate;
  return {
    id: value.public_id,
    patient_id: Number(value.patient_id),
    patient_name: patient ? [patient.nombre, patient.apellidos].filter(Boolean).join(' ') : null,
    reference: value.reference,
    account_holder: value.account_holder,
    iban_masked: `•••• ${value.iban_last4}`,
    bic: value.bic || null,
    signature_date: value.signature_date,
    scheme: value.scheme,
    sequence_type: value.sequence_type,
    status: value.status,
    notes: value.notes || null,
    created_at: value.created_at,
  };
}

function serializeRemittance(row, items = []) {
  const value = row.toJSON ? row.toJSON() : row;
  return {
    id: value.public_id,
    reference: value.reference,
    requested_collection_date: value.requested_collection_date,
    status: value.status,
    creditor: value.creditor_snapshot || {},
    total_amount: money(value.total_amount),
    item_count: Number(value.item_count || 0),
    exported_at: value.exported_at || null,
    items: items.map((item) => ({
      id: String(item.id),
      mandate_id: String(item.mandate_id),
      patient_id: Number(item.patient_id),
      budget_id: item.budget_id ? String(item.budget_id) : null,
      amount: money(item.amount),
      concept: item.concept,
      end_to_end_id: item.end_to_end_id,
    })),
    created_at: value.created_at,
  };
}

async function listEligibleCharges({ clinicId, mandates, remittances, remittanceItems }) {
  const activeMandates = mandates.filter((row) => row.status === 'active');
  const mandateByPatient = new Map(activeMandates.map((row) => [Number(row.patient_id), row]));
  if (!mandateByPatient.size) return [];
  const budgets = await EconomicBudget.findAll({
    where: {
      clinic_id: clinicId,
      patient_id: { [Op.in]: [...mandateByPatient.keys()] },
      status: { [Op.in]: ['accepted', 'partially_accepted'] },
    },
    order: [['responded_at', 'DESC'], ['id', 'DESC']],
  });
  if (!budgets.length) return [];
  const budgetIds = budgets.map((row) => row.id);
  const [events, payments, patients] = await Promise.all([
    EconomicBudgetEvent.findAll({
      where: {
        budget_id: { [Op.in]: budgetIds },
        event_type: { [Op.in]: ['accepted', 'partially_accepted'] },
      },
      order: [['created_at', 'ASC']],
    }),
    EconomicPayment.findAll({
      where: { budget_id: { [Op.in]: budgetIds }, status: 'confirmed' },
      attributes: ['budget_id', 'amount', 'application'],
    }),
    Paciente.findAll({
      where: { id_paciente: { [Op.in]: [...mandateByPatient.keys()] } },
      attributes: ['id_paciente', 'nombre', 'apellidos'],
    }),
  ]);
  const acceptanceByBudget = new Map();
  for (const event of events) acceptanceByBudget.set(String(event.budget_id), json(event.metadata));
  const paidByBudget = new Map();
  for (const payment of payments) {
    const allocations = json(payment.application, {}).allocations || [];
    const applied = allocations
      .filter((item) => ['budget', 'budget_line'].includes(item.target_type))
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const key = String(payment.budget_id);
    paidByBudget.set(key, money((paidByBudget.get(key) || 0) + applied));
  }
  const activeRemittanceIds = new Set(remittances
    .filter((row) => !['cancelled', 'rejected'].includes(row.status))
    .map((row) => Number(row.id)));
  const remittedByBudget = new Map();
  for (const item of remittanceItems.filter((row) => activeRemittanceIds.has(Number(row.remittance_id)))) {
    if (!item.budget_id) continue;
    const key = String(item.budget_id);
    remittedByBudget.set(key, money((remittedByBudget.get(key) || 0) + Number(item.amount || 0)));
  }
  const patientById = new Map(patients.map((row) => [Number(row.id_paciente), row]));
  return budgets.flatMap((budget) => {
    const acceptance = acceptanceByBudget.get(String(budget.id)) || {};
    if (acceptance.collection_method !== 'direct_debit') return [];
    const pending = money(
      Number(budget.accepted_amount || 0)
      - Number(paidByBudget.get(String(budget.id)) || 0)
      - Number(remittedByBudget.get(String(budget.id)) || 0),
    );
    const mandate = mandateByPatient.get(Number(budget.patient_id));
    if (!mandate || pending <= 0) return [];
    const patient = patientById.get(Number(budget.patient_id));
    return [{
      id: budget.public_id,
      budget_id: budget.public_id,
      budget_number: budget.number,
      mandate_id: mandate.public_id,
      patient_id: Number(budget.patient_id),
      patient_name: patient
        ? [patient.nombre, patient.apellidos].filter(Boolean).join(' ')
        : mandate.account_holder,
      iban_masked: `•••• ${mandate.iban_last4}`,
      pending_amount: pending,
      concept: `Presupuesto ${budget.number}`,
    }];
  });
}

async function resolvePatient(value, clinicId, transaction = null) {
  const numericId = positiveInteger(value);
  const patient = numericId
    ? await Paciente.findByPk(numericId, { transaction })
    : await Paciente.findOne({ where: { public_id: clean(value, 64) }, transaction });
  const directClinic = patient && Number(patient.clinica_id) === Number(clinicId);
  const linkedClinic = patient && !directClinic
    ? await PacienteClinica.findOne({
      where: { paciente_id: patient.id_paciente, clinica_id: clinicId },
      attributes: ['id'],
      transaction,
    })
    : null;
  if (!patient || (!directClinic && !linkedClinic)) {
    throw domainError(404, 'sepa_patient_not_found', 'Paciente no encontrado en esta clínica.');
  }
  return patient;
}

async function list({ clinicId }) {
  const [mandates, remittances] = await Promise.all([
    AccountingSepaMandate.findAll({
      where: { clinic_id: clinicId },
      order: [['created_at', 'DESC']],
    }),
    AccountingRemittance.findAll({
      where: { clinic_id: clinicId },
      order: [['created_at', 'DESC']],
      limit: 100,
    }),
  ]);
  const patientIds = [...new Set(mandates.map((row) => Number(row.patient_id)).filter(Boolean))];
  const patients = patientIds.length
    ? await Paciente.findAll({
      where: { id_paciente: { [Op.in]: patientIds } },
      attributes: ['id_paciente', 'nombre', 'apellidos'],
    })
    : [];
  const remittanceIds = remittances.map((row) => row.id);
  const items = remittanceIds.length
    ? await AccountingRemittanceItem.findAll({
      where: { remittance_id: { [Op.in]: remittanceIds } },
      order: [['id', 'ASC']],
    })
    : [];
  const patientById = new Map(patients.map((row) => [Number(row.id_paciente), row]));
  const itemsByRemittance = new Map();
  for (const item of items) {
    const key = String(item.remittance_id);
    itemsByRemittance.set(key, [...(itemsByRemittance.get(key) || []), item]);
  }
  return {
    mandates: mandates.map((row) => serializeMandate(row, patientById.get(Number(row.patient_id)))),
    remittances: remittances.map((row) => serializeRemittance(row, itemsByRemittance.get(String(row.id)) || [])),
    eligible_charges: await listEligibleCharges({
      clinicId,
      mandates,
      remittances,
      remittanceItems: items,
    }),
  };
}

async function saveMandate({ clinicId, actorId, payload, publicId = null }) {
  return sequelize.transaction(async (transaction) => {
    const patient = await resolvePatient(payload.patient_id, clinicId, transaction);
    let mandate = publicId
      ? await AccountingSepaMandate.findOne({
        where: { public_id: publicId, clinic_id: clinicId },
        transaction,
      })
      : null;
    if (publicId && !mandate) throw domainError(404, 'sepa_mandate_not_found', 'Mandato no encontrado.');
    const iban = payload.iban ? normalizeIban(payload.iban) : null;
    const mandatePublicId = mandate?.public_id || crypto.randomUUID();
    const reference = clean(payload.reference, 80)
      || `MAND-${clinicId}-${patient.id_paciente}-${String(Date.now()).slice(-6)}`;
    const values = {
      patient_id: patient.id_paciente,
      reference,
      account_holder: clean(payload.account_holder, 180)
        || [patient.nombre, patient.apellidos].filter(Boolean).join(' '),
      bic: clean(payload.bic, 11).toUpperCase() || null,
      signature_date: dateOnly(payload.signature_date) || new Date().toISOString().slice(0, 10),
      scheme: ['CORE', 'B2B'].includes(payload.scheme) ? payload.scheme : 'CORE',
      sequence_type: ['OOFF', 'FRST', 'RCUR', 'FNAL'].includes(payload.sequence_type)
        ? payload.sequence_type
        : 'RCUR',
      status: ['active', 'revoked', 'expired'].includes(payload.status) ? payload.status : 'active',
      notes: clean(payload.notes, 4000) || null,
      updated_by: actorId,
    };
    if (iban) {
      values.iban_envelope = envelope.encrypt(iban, mandateContext(clinicId, mandatePublicId));
      values.iban_last4 = iban.slice(-4);
    } else if (!mandate) {
      throw domainError(400, 'sepa_iban_required', 'Indica el IBAN del paciente.');
    }
    if (mandate) {
      await mandate.update(values, { transaction });
    } else {
      mandate = await AccountingSepaMandate.create({
        public_id: mandatePublicId,
        clinic_id: clinicId,
        ...values,
        created_by: actorId,
      }, { transaction });
    }
    return serializeMandate(mandate, patient);
  });
}

function clinicCreditor(clinic) {
  const fiscal = typeof clinic.datos_fiscales_clinica === 'object' && clinic.datos_fiscales_clinica
    ? clinic.datos_fiscales_clinica
    : {};
  return {
    name: fiscal.denominacion_social || fiscal.razon_social || clinic.nombre_clinica,
    tax_id: fiscal.nif || fiscal.cif || null,
    creditor_id: fiscal.sepa_creditor_id || fiscal.identificador_acreedor_sepa || null,
    iban: fiscal.iban || fiscal.numero_cuenta || null,
    bic: fiscal.bic || null,
  };
}

async function createRemittance({ clinicId, actorId, payload }) {
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (!rawItems.length) throw domainError(400, 'sepa_remittance_items_required', 'Añade al menos un recibo.');
  return sequelize.transaction(async (transaction) => {
    const clinic = await Clinica.findByPk(clinicId, { transaction });
    if (!clinic) throw domainError(404, 'clinic_not_found', 'Clínica no encontrada.');
    const creditor = clinicCreditor(clinic);
    const activeRemittances = await AccountingRemittance.findAll({
      where: {
        clinic_id: clinicId,
        status: { [Op.notIn]: ['cancelled', 'rejected'] },
      },
      attributes: ['id'],
      transaction,
    });
    const activeRemittanceIds = activeRemittances.map((row) => Number(row.id));
    const queuedByBudget = new Map();
    const items = [];
    for (const [index, item] of rawItems.entries()) {
      const mandate = await AccountingSepaMandate.findOne({
        where: {
          public_id: clean(item.mandate_id, 36),
          clinic_id: clinicId,
          status: 'active',
        },
        transaction,
      });
      if (!mandate) throw domainError(400, 'sepa_mandate_invalid', `El mandato del recibo ${index + 1} no está activo.`);
      const amount = money(item.amount);
      if (amount <= 0) throw domainError(400, 'sepa_amount_invalid', `El importe del recibo ${index + 1} no es válido.`);
      let budgetId = null;
      if (item.budget_id) {
        const budget = await EconomicBudget.findOne({
          where: {
            public_id: clean(item.budget_id, 36),
            clinic_id: clinicId,
            patient_id: mandate.patient_id,
            status: { [Op.in]: ['accepted', 'partially_accepted'] },
          },
          attributes: ['id', 'accepted_amount'],
          transaction,
        });
        if (!budget) {
          throw domainError(400, 'sepa_budget_invalid', `El presupuesto del recibo ${index + 1} no está disponible.`);
        }
        const acceptance = await EconomicBudgetEvent.findOne({
          where: {
            budget_id: budget.id,
            event_type: { [Op.in]: ['accepted', 'partially_accepted'] },
          },
          order: [['created_at', 'DESC']],
          transaction,
        });
        if (json(acceptance?.metadata).collection_method !== 'direct_debit') {
          throw domainError(
            400,
            'sepa_budget_not_direct_debit',
            `El presupuesto del recibo ${index + 1} no se aceptó mediante domiciliación.`,
          );
        }
        const [payments, existingItems] = await Promise.all([
          EconomicPayment.findAll({
            where: {
              budget_id: budget.id,
              status: 'confirmed',
            },
            attributes: ['amount', 'application'],
            transaction,
          }),
          activeRemittanceIds.length
            ? AccountingRemittanceItem.findAll({
              where: {
                budget_id: budget.id,
                remittance_id: { [Op.in]: activeRemittanceIds },
              },
              attributes: ['amount'],
              transaction,
            })
            : Promise.resolve([]),
        ]);
        const alreadyPaid = money(payments.reduce((sum, payment) => {
          const allocations = json(payment.application, {}).allocations || [];
          return sum + allocations
            .filter((allocation) => ['budget', 'budget_line'].includes(allocation.target_type))
            .reduce((allocationSum, allocation) => (
              allocationSum + Number(allocation.amount || 0)
            ), 0);
        }, 0));
        const alreadyRemitted = money(existingItems.reduce(
          (sum, existingItem) => sum + Number(existingItem.amount || 0),
          0,
        ));
        const queued = money(queuedByBudget.get(String(budget.id)) || 0);
        const pending = money(
          Number(budget.accepted_amount || 0)
          - alreadyPaid
          - alreadyRemitted
          - queued,
        );
        if (amount > pending) {
          throw domainError(
            400,
            'sepa_amount_exceeds_pending',
            `El recibo ${index + 1} supera los ${pending.toFixed(2)} € pendientes del presupuesto.`,
          );
        }
        queuedByBudget.set(String(budget.id), money(queued + amount));
        budgetId = budget.id;
      }
      items.push({
        mandate,
        patient_id: mandate.patient_id,
        budget_id: budgetId,
        amount,
        concept: clean(item.concept, 140) || 'Servicios clínicos',
        end_to_end_id: clean(item.end_to_end_id, 35) || `CC-${Date.now()}-${index + 1}`,
      });
    }
    const reference = clean(payload.reference, 80)
      || `REM-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Date.now()).slice(-5)}`;
    const remittance = await AccountingRemittance.create({
      public_id: crypto.randomUUID(),
      clinic_id: clinicId,
      reference,
      requested_collection_date: dateOnly(payload.requested_collection_date)
        || new Date().toISOString().slice(0, 10),
      status: 'draft',
      creditor_snapshot: creditor,
      total_amount: money(items.reduce((sum, item) => sum + item.amount, 0)),
      item_count: items.length,
      created_by: actorId,
    }, { transaction });
    const createdItems = [];
    for (const item of items) {
      createdItems.push(await AccountingRemittanceItem.create({
        remittance_id: remittance.id,
        mandate_id: item.mandate.id,
        patient_id: item.patient_id,
        budget_id: item.budget_id,
        amount: item.amount,
        concept: item.concept,
        end_to_end_id: item.end_to_end_id,
      }, { transaction }));
    }
    return serializeRemittance(remittance, createdItems);
  });
}

async function updateRemittanceStatus({ clinicId, publicId, status }) {
  const target = clean(status, 20);
  if (!['submitted', 'settled', 'rejected', 'cancelled'].includes(target)) {
    throw domainError(400, 'sepa_remittance_status_invalid', 'El estado de la remesa no es válido.');
  }
  const remittance = await AccountingRemittance.findOne({
    where: { public_id: publicId, clinic_id: clinicId },
  });
  if (!remittance) throw domainError(404, 'sepa_remittance_not_found', 'Remesa no encontrada.');
  const allowed = {
    draft: ['cancelled'],
    exported: ['submitted', 'cancelled'],
    submitted: ['settled', 'rejected', 'cancelled'],
    settled: [],
    rejected: [],
    cancelled: [],
  };
  if (!allowed[remittance.status]?.includes(target)) {
    throw domainError(409, 'sepa_remittance_transition_invalid', 'Ese cambio de estado no está permitido.');
  }
  await remittance.update({ status: target });
  const items = await AccountingRemittanceItem.findAll({
    where: { remittance_id: remittance.id },
    order: [['id', 'ASC']],
  });
  return serializeRemittance(remittance, items);
}

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function exportRemittance({ clinicId, publicId }) {
  const remittance = await AccountingRemittance.findOne({
    where: { public_id: publicId, clinic_id: clinicId },
  });
  if (!remittance) throw domainError(404, 'sepa_remittance_not_found', 'Remesa no encontrada.');
  const items = await AccountingRemittanceItem.findAll({
    where: { remittance_id: remittance.id },
    order: [['id', 'ASC']],
  });
  const mandateIds = [...new Set(items.map((item) => Number(item.mandate_id)))];
  const patientIds = [...new Set(items.map((item) => Number(item.patient_id)))];
  const [mandates, patients] = await Promise.all([
    AccountingSepaMandate.findAll({ where: { id: { [Op.in]: mandateIds } } }),
    Paciente.findAll({
      where: { id_paciente: { [Op.in]: patientIds } },
      attributes: ['id_paciente', 'nombre', 'apellidos'],
    }),
  ]);
  const mandateById = new Map(mandates.map((row) => [Number(row.id), row]));
  const patientById = new Map(patients.map((row) => [Number(row.id_paciente), row]));
  const creditor = remittance.creditor_snapshot || {};
  if (!creditor.creditor_id || !creditor.iban) {
    throw domainError(
      409,
      'sepa_creditor_incomplete',
      'Completa el identificador de acreedor SEPA y el IBAN de la clínica antes de exportar.',
    );
  }
  const preparedItems = items.map((item) => {
    const mandate = mandateById.get(Number(item.mandate_id));
    const patient = patientById.get(Number(item.patient_id));
    if (!mandate) {
      throw domainError(409, 'sepa_mandate_missing', 'Uno de los mandatos de la remesa ya no está disponible.');
    }
    const iban = envelope.decrypt(
      mandate.iban_envelope,
      mandateContext(clinicId, mandate.public_id),
    );
    return { item, mandate, patient, iban };
  });
  const groups = new Map();
  for (const prepared of preparedItems) {
    const key = `${prepared.mandate.scheme}:${prepared.mandate.sequence_type}`;
    groups.set(key, [...(groups.get(key) || []), prepared]);
  }
  const paymentInformation = [...groups.entries()].map(([key, group], groupIndex) => {
    const [scheme, sequenceType] = key.split(':');
    const groupTotal = money(group.reduce((sum, prepared) => sum + Number(prepared.item.amount), 0));
    const transactions = group.map(({ item, mandate, patient, iban }) => [
      '<DrctDbtTxInf>',
      `<PmtId><EndToEndId>${xml(item.end_to_end_id)}</EndToEndId></PmtId>`,
      `<InstdAmt Ccy="EUR">${money(item.amount).toFixed(2)}</InstdAmt>`,
      `<DrctDbtTx><MndtRltdInf><MndtId>${xml(mandate.reference)}</MndtId><DtOfSgntr>${xml(mandate.signature_date)}</DtOfSgntr></MndtRltdInf></DrctDbtTx>`,
      `<Dbtr><Nm>${xml([patient?.nombre, patient?.apellidos].filter(Boolean).join(' ') || mandate.account_holder)}</Nm></Dbtr>`,
      `<DbtrAcct><Id><IBAN>${xml(iban)}</IBAN></Id></DbtrAcct>`,
      `<RmtInf><Ustrd>${xml(item.concept)}</Ustrd></RmtInf>`,
      '</DrctDbtTxInf>',
    ].join('')).join('');
    const paymentSuffix = `-${groupIndex + 1}`;
    const paymentId = `${clean(remittance.reference, 35 - paymentSuffix.length)}${paymentSuffix}`;
    return [
      `<PmtInf><PmtInfId>${xml(paymentId)}</PmtInfId><PmtMtd>DD</PmtMtd><NbOfTxs>${group.length}</NbOfTxs><CtrlSum>${groupTotal.toFixed(2)}</CtrlSum>`,
      `<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>${xml(scheme)}</Cd></LclInstrm><SeqTp>${xml(sequenceType)}</SeqTp></PmtTpInf>`,
      `<ReqdColltnDt>${xml(remittance.requested_collection_date)}</ReqdColltnDt>`,
      `<Cdtr><Nm>${xml(creditor.name)}</Nm></Cdtr><CdtrAcct><Id><IBAN>${xml(normalizeIban(creditor.iban))}</IBAN></Id></CdtrAcct>`,
      `<CdtrSchmeId><Id><PrvtId><Othr><Id>${xml(creditor.creditor_id)}</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId>`,
      transactions,
      '</PmtInf>',
    ].join('');
  }).join('');
  const created = new Date().toISOString();
  const messageId = clean(remittance.reference, 35);
  const document = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02">',
    '<CstmrDrctDbtInitn>',
    `<GrpHdr><MsgId>${xml(messageId)}</MsgId><CreDtTm>${created}</CreDtTm><NbOfTxs>${items.length}</NbOfTxs><CtrlSum>${money(remittance.total_amount).toFixed(2)}</CtrlSum><InitgPty><Nm>${xml(creditor.name)}</Nm></InitgPty></GrpHdr>`,
    paymentInformation,
    '</CstmrDrctDbtInitn></Document>',
  ].join('');
  await remittance.update({ status: 'exported', exported_at: new Date() });
  return { filename: `${remittance.reference}.xml`, document };
}

module.exports = {
  domainError,
  list,
  saveMandate,
  createRemittance,
  updateRemittanceStatus,
  exportRemittance,
  __testing: { normalizeIban },
};
