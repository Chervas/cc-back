'use strict';
// Execute the real intake parser/scope functions without controller bootstrap,
// sessions, providers or business data. Only existing permission decisions are
// supplied by the fixture; no alternative access policy is implemented here.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Op } = require('sequelize');
const { parseIntakeId } = require('../../../lib/intakeLocations');
const source = fs.readFileSync(path.resolve(__dirname, '../../../controllers/intake.controller.js'), 'utf8');
function createLeadCallScopeFixture({ allowedClinicIds = [66,72], groupClinicIds = { 48: [66,72], 99: [35] }, globalAdmin = false } = {}) {
  const parser = source.slice(source.indexOf('const parseIntegerList ='), source.indexOf('const findClinicIdsByGroup ='));
  const resolver = source.slice(source.indexOf('const resolveLeadScopeFilter ='), source.indexOf('const getAccessibleLeadClinicIds ='));
  const apply = source.slice(source.indexOf('const applyLeadScopeWhere ='), source.indexOf('const ensureLeadScopeAccess ='));
  return vm.runInNewContext(parser + resolver + apply + '\n({parseIntegerList,resolveLeadScopeFilter,applyLeadScopeWhere});', {
    Op, Array, Set, Number, parseInteger: parseIntakeId, isGlobalAdmin: () => globalAdmin,
    findClinicIdsByGroup: async groupId => groupClinicIds[groupId] || [],
    findAllClinicIds: async () => [...new Set(Object.values(groupClinicIds).flat())],
    findGroupIdsForClinics: async () => Object.keys(groupClinicIds).map(Number),
    getAccessibleLeadClinicIds: async ({ clinicIds }) => clinicIds.filter(id => allowedClinicIds.includes(id)),
    hasFullGroupMarketingAccess: async (_actor, groupId) => (groupClinicIds[groupId] || []).length > 0
      && groupClinicIds[groupId].every(id => allowedClinicIds.includes(id)),
  });
}
function dashboardTaskItems() {
  const text = fs.readFileSync(path.resolve(__dirname, '../../../services/panelesDashboard.service.js'), 'utf8');
  const block = text.slice(text.indexOf('function taskItems('), text.indexOf('async function loadPendingConsentCards('));
  return vm.runInNewContext(block + '\ntaskItems;', { Number });
}
module.exports = { createLeadCallScopeFixture, dashboardTaskItems };
