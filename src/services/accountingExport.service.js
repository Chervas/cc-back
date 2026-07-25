'use strict';

const db = require('../../models');
const accounting = require('./accounting.service');
const economicDocumentPdf = require('./economicDocumentPdf.service');
const clinicalPrivateStorage = require('./clinicalPrivateStorage.service');
const { createZip } = require('../lib/zipArchive');

const { Clinica, ClinicalPrivateAsset } = db;

function safeName(value) {
  return String(value || 'clinica')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    || 'clinica';
}

async function exportBundle({ clinicIds, query = {}, actorId }) {
  const ids = [...new Set(clinicIds.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
  const clinics = ids.length
    ? await Clinica.findAll({
      where: { id_clinica: ids },
      attributes: ['id_clinica', 'nombre_clinica'],
      order: [['nombre_clinica', 'ASC']],
    })
    : [];
  const entries = [];
  for (const clinic of clinics) {
    const prefix = `${safeName(clinic.nombre_clinica)}-${clinic.id_clinica}`;
    const workspace = await accounting.getWorkspace({
      clinicId: clinic.id_clinica,
      query,
      portalMode: true,
    });
    entries.push({
      name: `${prefix}/contabilidad-${workspace.period.from}-${workspace.period.to}.csv`,
      data: `\uFEFF${await accounting.exportCsv({ clinicId: clinic.id_clinica, query })}`,
    });
    for (const document of workspace.issued_documents) {
      if (document.status !== 'issued') continue;
      const result = await economicDocumentPdf.fiscalPdf({
        publicId: document.id,
        actorId,
      });
      entries.push({
        name: `${prefix}/emitidas/${safeName(document.number)}.pdf`,
        data: result.buffer,
      });
    }
    for (const expense of workspace.received_documents) {
      if (!expense.attachment?.id) continue;
      const asset = await ClinicalPrivateAsset.findOne({
        where: {
          public_id: expense.attachment.id,
          clinic_id: clinic.id_clinica,
          status: 'active',
        },
      });
      if (!asset) continue;
      const stored = await clinicalPrivateStorage.readClinicalPrivateAsset(asset);
      entries.push({
        name: `${prefix}/recibidas/${safeName(expense.document_number)}-${safeName(stored.filename)}`,
        data: stored.buffer,
      });
    }
  }
  if (!entries.length) {
    entries.push({
      name: 'sin-documentos.txt',
      data: 'No hay documentos contables en el periodo seleccionado.',
    });
  }
  return createZip(entries);
}

module.exports = { exportBundle };
