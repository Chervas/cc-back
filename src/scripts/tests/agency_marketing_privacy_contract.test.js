'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');

const db = require('../../../models');
const accessPolicy = require('../../lib/access-policy');
const {
  ADMIN_ROLES,
  MARKETING_WRITE_ROLES,
  canManagePersonal,
} = require('../../lib/role-helpers');
const { getAccessibleMarketingClinicIds } = require('../../lib/marketingScopeAccess');
const { authorizePersonalMerge } = require('../../lib/personalMergeAccess');
const personalController = require('../../controllers/personal.controller');

async function main() {
  assert.equal(accessPolicy.defaultForFeature('marketing', 'agencia'), true);
  assert.equal(accessPolicy.defaultForFeature('leads.sensitive.view', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('leads.manage', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('quickchat.read_leads', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('quickchat.read_team', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('clinic.settings.view', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('team.view', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('team.manage', 'agencia'), false);
  assert.equal(ADMIN_ROLES.includes('agencia'), false,
    'agency must never inherit clinic/team administration from its Marketing assignment');
  assert.equal(canManagePersonal(9001, 'agencia'), false);
  assert.ok(MARKETING_WRITE_ROLES.includes('agencia'),
    'agency must retain write access to scoped Marketing/Meta assets');

  let capturedWhere = null;
  const clinicIds = await getAccessibleMarketingClinicIds({
    userId: 9001,
    clinicIds: [56],
    access: 'write',
    globalAdminCheck: () => false,
    membershipModel: {
      async findAll(options) {
        capturedWhere = options.where;
        const allowedRoles = options.where.rol_clinica[Op.in];
        return allowedRoles.includes('agencia') ? [{ id_clinica: 56 }] : [];
      },
    },
  });
  assert.deepEqual(clinicIds, [56]);
  assert.ok(capturedWhere.rol_clinica[Op.in].includes('agencia'));
  assert.deepEqual(capturedWhere.rol_clinica[Op.in], MARKETING_WRITE_ROLES);

  const appSource = fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8');
  assert.match(appSource, /readPatients && patientSensitive/);
  assert.match(appSource, /readLeads && leadSensitive/);
  assert.match(appSource, /allowedClinicIds\.includes\(id\)/);

  const intakeSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/intake.controller.js'),
    'utf8',
  );
  const payloadStart = intakeSource.indexOf('const buildLeadCreatedSocketPayload');
  const payloadEnd = intakeSource.indexOf('const buildLeadCallInitiatedSocketPayload', payloadStart);
  assert.ok(payloadStart >= 0 && payloadEnd > payloadStart);
  const createdPayload = intakeSource.slice(payloadStart, payloadEnd);
  assert.doesNotMatch(createdPayload, /\b(?:nombre|apellidos|email|telefono|notas|page_url|landing_url)\b/);
  assert.match(createdPayload, /campaign_id/);
  assert.match(createdPayload, /status_lead/);

  const oauthRoutes = fs.readFileSync(path.resolve(__dirname, '../../routes/oauth.routes.js'), 'utf8');
  assert.match(oauthRoutes, /requireSingleMappingClinicWrite/);
  assert.match(oauthRoutes, /requireAssetMappingClinicAccess[\s\S]{0,120}'write'/);

  const personalPath = path.resolve(__dirname, '../../controllers/personal.controller.js');
  const personalSource = fs.readFileSync(personalPath, 'utf8');
  // Protect the security contract semantically. A full-file hash made this
  // test fail for unrelated, reviewed edits and encouraged unsafe baseline
  // refreshes without proving which owner boundary remained intact.
  assert.match(personalSource, /code:\s*'owner_membership_manage_forbidden'/);
  assert.match(personalSource, /code:\s*'owner_unlink_forbidden'/);
  assert.match(
    personalSource,
    /async function getAccessibleClinicIdsForUser[\s\S]*?featureKey:\s*'team\.view'/,
    'personal reads must consume team.view so a marketing-only agency cannot enumerate the team',
  );
  assert.match(
    personalSource,
    /async function hasAdminScopePivot[\s\S]*?rol_clinica:\s*\{\s*\[Op\.in\]: ADMIN_ROLES\s*\}[\s\S]*?async function canManageTeamInClinic/,
    'personal/team administration must consume the centrally restricted ADMIN_ROLES set',
  );
  const inviteStart = personalSource.indexOf('exports.invitePersonal');
  const inviteEnd = personalSource.indexOf('\nexports.', inviteStart + 1);
  assert.match(personalSource.slice(inviteStart, inviteEnd), /exports\.invitarPersonal/,
    'legacy personal invite API must delegate to the canonical guarded path');
  const canonicalInviteStart = personalSource.indexOf('exports.invitarPersonal =');
  const canonicalInviteEnd = personalSource.indexOf('\nexports.', canonicalInviteStart + 1);
  assert.match(personalSource.slice(canonicalInviteStart, canonicalInviteEnd), /canManageTeamInClinic/,
    'canonical personal invite API must enforce team management scope');
  const removeStart = personalSource.indexOf('async function removeClinicCollaborationInternal');
  const removeEnd = personalSource.indexOf('\nexports.removeClinicCollaboration', removeStart);
  assert.match(personalSource.slice(removeStart, removeEnd), /canManagePersonalInClinic/,
    'personal removal API must enforce team management scope');
  for (const handler of ['updateHorarios', 'copyHorarioClinica', 'moveHorarioClinica']) {
    const start = personalSource.indexOf(`exports.${handler} =`);
    assert.notEqual(start, -1, `${handler} must exist`);
    const end = personalSource.indexOf('\nexports.', start + 1);
    assert.match(personalSource.slice(start, end < 0 ? undefined : end), /canManageTeamInClinic|canEditHorarios|exports\.updateHorariosClinica/,
      `${handler} must enforce team/schedule management scope`);
  }
  const targetMemberships = {
    async findAll() {
      return [
        { id_usuario: 100, id_clinica: 56, rol_clinica: 'personaldeclinica' },
        { id_usuario: 101, id_clinica: 56, rol_clinica: 'personaldeclinica' },
      ];
    },
  };
  assert.equal(await authorizePersonalMerge({
    actorId: 9001,
    primaryUserId: 100,
    secondaryUserId: 101,
    membershipModel: targetMemberships,
    featureCheck: async () => false,
    globalAdminCheck: () => false,
  }), false, 'agency without team.manage must be blocked before destructive merge controller');
  assert.equal(await authorizePersonalMerge({
    actorId: 9003,
    primaryUserId: 100,
    secondaryUserId: 101,
    membershipModel: targetMemberships,
    featureCheck: async ({ featureKey, clinicId }) => featureKey === 'team.manage' && clinicId === 56,
    globalAdminCheck: () => false,
  }), true, 'explicit team.manage over every affected clinic may pass the route guard');
  assert.equal(await authorizePersonalMerge({
    actorId: 9003,
    primaryUserId: 100,
    secondaryUserId: 101,
    membershipModel: {
      async findAll() {
        return [{ id_usuario: 100, id_clinica: 56, rol_clinica: 'propietario' }];
      },
    },
    featureCheck: async () => true,
    globalAdminCheck: () => false,
  }), false, 'owner pivots remain protected even when team.manage is granted');
  const personalRoutes = fs.readFileSync(path.resolve(__dirname, '../../routes/personal.routes.js'), 'utf8');
  assert.match(personalRoutes, /router\.post\('\/fusionar', requirePersonalMergeAccess, personalController\.mergePersonalAccounts\)/);

  const { pickBetterRole, canEditBloqueos } = personalController.__personalSecurityContract;
  assert.equal(pickBetterRole('agencia', 'propietario'), 'propietario');
  assert.equal(pickBetterRole('propietario', 'agencia'), 'propietario');

  const scopedAbsenceDependencies = {
    globalAdminCheck: () => false,
    staffPivotCheck: async (userId, clinicId) => userId === 200 && clinicId === 56,
    ownerPivotCheck: async () => false,
    teamManageCheck: async (actorId, clinicId) => [901, 902].includes(actorId) && clinicId === 56,
    adminClinicIdsLoader: async () => [],
    targetClinicIdsLoader: async () => [56],
  };
  assert.equal(await canEditBloqueos(901, 200, 56, scopedAbsenceDependencies), true,
    'admin_staff with team.manage can manage third-party absences in its clinic');
  assert.equal(await canEditBloqueos(902, 200, 56, scopedAbsenceDependencies), true,
    'reception with team.manage can manage third-party absences in its clinic');
  assert.equal(await canEditBloqueos(901, 200, 57, scopedAbsenceDependencies), false,
    'team.manage in one clinic cannot manage absences outside that clinic');
  assert.equal(await canEditBloqueos(901, 200, null, scopedAbsenceDependencies), false,
    'a clinic-scoped team.manage grant cannot create a global third-party absence');
  assert.equal(await canEditBloqueos(901, 200, 56, {
    ...scopedAbsenceDependencies,
    ownerPivotCheck: async (userId, clinicId) => userId === 200 && clinicId === 56,
  }), false, 'admin_staff/reception cannot manage an owner absence');

  console.log('agency marketing/privacy contract: ok');
}

main()
  .then(() => db.sequelize.close())
  .catch(async (error) => {
    console.error(error);
    await db.sequelize.close().catch(() => {});
    process.exitCode = 1;
  });
