'use strict';

// These are registered SVG symbols, never URLs, markup or arbitrary namespaces.
const INSTALLATION_ICONS = Object.freeze([
  'heroicons_outline:building-office',
  'heroicons_outline:building-office-2',
  'heroicons_outline:clipboard-document-list',
  'heroicons_outline:user-circle',
  'heroicons_outline:heart',
  'heroicons_outline:beaker',
  'heroicons_outline:camera',
  'heroicons_outline:sparkles',
  'heroicons_outline:sun',
  'heroicons_outline:bolt',
  'heroicons_outline:users',
  'heroicons_outline:cube',
  'heroicons_outline:hand-raised',
  'heroicons_outline:arrows-up-down',
  'heroicons_outline:arrow-path',
]);
const allowed = new Set(INSTALLATION_ICONS);

function normalizeInstallationIcon(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && allowed.has(value)) return value;
  const error = new Error('Elige uno de los iconos de sala disponibles.');
  error.status = 400;
  error.code = 'installation_icon_invalid';
  throw error;
}

module.exports = { INSTALLATION_ICONS, normalizeInstallationIcon };
