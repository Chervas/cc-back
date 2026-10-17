'use strict';

const SCHEMA = 'cc-document-presentation/v1';
const IDENTITY_LABELS = 'mobile_fixed/v1';
// Issued once in the hashed context, never grafted onto historical snapshots.
const newPresentation = () => ({ schema_version: SCHEMA, patient_identity_labels: IDENTITY_LABELS });
function identityLabel(field, context) {
  const presentation = context?.document_presentation;
  if (presentation?.schema_version !== SCHEMA || presentation.patient_identity_labels !== IDENTITY_LABELS) return field.label;
  if (field.key === 'telefono') return 'Teléfono móvil';
  if (field.key === 'telefono2') return 'Teléfono fijo';
  return field.label;
}
module.exports = { SCHEMA, IDENTITY_LABELS, newPresentation, identityLabel };
