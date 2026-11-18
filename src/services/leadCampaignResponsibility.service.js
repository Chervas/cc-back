'use strict';

// Local, read-only campaign evidence. Presentation labels, UTM names and click
// identifiers are not ownership evidence. Keep one SQL predicate for the bulk
// projection and the paginated QuickChat filter so they cannot disagree.
// Receipt shapes are the persisted contracts of metaLeadAttributionView,
// leadAdvertisingIdentity, meta-web-attribution and web-ad-attribution.
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function campaignResponsibilitySql(alias = 'LeadIntake') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw Error('campaign_responsibility_alias_invalid');
  const lead = `\`${alias}\``;
  const field = name => `${lead}.\`${name}\``;
  const json = (alias, root, name) => `JSON_EXTRACT(${alias}.${root}, '$.${name}')`;
  const scalar = (alias, root, name) => `JSON_UNQUOTE(${json(alias, root, name)})`;
  const identity = alias => `JSON_EXTRACT(${alias}.attribution_steps, '$.advertising_identity')`;
  const webAd = alias => `JSON_EXTRACT(${alias}.attribution_steps, '$.web_ad_identity')`;
  const jf = (object, name) => `JSON_EXTRACT(${object}, '$.${name}')`;
  const sf = (object, name) => `JSON_UNQUOTE(${jf(object, name)})`;
  const str = (object, name) => `JSON_TYPE(${jf(object, name)}) = 'STRING'`;
  const id = (object, name, pattern = '^[0-9]{1,64}$') => `(${str(object, name)} AND ${sf(object, name)} REGEXP '${pattern}')`;
  const optionalId = (object, name) => `(${jf(object, name)} IS NULL OR JSON_TYPE(${jf(object, name)}) = 'NULL' OR ${id(object, name)})`;
  const version = (object, value) => `(JSON_TYPE(${jf(object, 'version')}) = 'INTEGER' AND ${sf(object, 'version')} = '${value}')`;
  const positiveInteger = (object, name) => `(JSON_TYPE(${jf(object, name)}) = 'INTEGER' AND ${sf(object, name)} REGEXP '^[1-9][0-9]*$')`;
  const clinic = object => `(${sf(object, 'clinic_id')} = CAST(${field('clinica_id')} AS CHAR))`;
  const fingerprint = (object, name) => `(${str(object, name)} AND ${sf(object, name)} REGEXP '^[a-f0-9]{64}$')`;
  const present = object => `(${object} IS NOT NULL AND JSON_TYPE(${object}) <> 'NULL')`;
  const sameLead = audit => `${audit}.lead_intake_id = ${field('id')}`;
  const raw = (audit, name) => scalar(audit, 'raw_payload', name);
  const nativeMeta = audit => {
    const object = identity(audit);
    return `(${version(object, 1)} AND ${sf(object, 'verified_by')} = 'meta_graph'
      AND ${sf(object, 'provider')} = 'meta_ads' AND ${clinic(object)}
      AND ${['account_id', 'campaign_id', 'ad_id', 'page_id', 'form_id'].map(name => id(object, name, '^[1-9][0-9]{0,29}$')).join(' AND ')}
      AND (${jf(object, 'adset_id')} IS NULL OR JSON_TYPE(${jf(object, 'adset_id')}) = 'NULL' OR ${id(object, 'adset_id', '^[1-9][0-9]{0,29}$')})
      AND JSON_TYPE(${json(audit, 'raw_payload', 'lead_id')}) = 'STRING'
      AND JSON_TYPE(${json(audit, 'raw_payload', 'form_id')}) = 'STRING'
      AND JSON_TYPE(${json(audit, 'attribution_steps', 'meta_page_id')}) = 'STRING'
      AND ${raw(audit, 'provider')} = 'meta_leadgen' AND ${raw(audit, 'lead_id')} = ${field('external_id')}
      AND ${raw(audit, 'form_id')} = ${sf(object, 'form_id')}
      AND ${scalar(audit, 'attribution_steps', 'meta_page_id')} = ${sf(object, 'page_id')}
      AND ${field('source_detail')} = CONCAT('leadgen_form:', ${sf(object, 'form_id')}))`;
  };
  const nativeGoogle = audit => {
    const object = identity(audit);
    return `(${version(object, 1)} AND ${sf(object, 'verified_by')} = 'google_ads_api'
      AND ${sf(object, 'provider')} = 'google_ads' AND ${clinic(object)}
      AND ${['account_id', 'campaign_id', 'form_id'].map(name => id(object, name)).join(' AND ')}
      AND ${optionalId(object, 'ad_id')} AND ${optionalId(object, 'adgroup_id')}
      AND JSON_TYPE(${json(audit, 'raw_payload', 'lead_id')}) = 'STRING'
      AND CHAR_LENGTH(${raw(audit, 'lead_id')}) BETWEEN 1 AND 1024
      AND SHA2(${raw(audit, 'lead_id')}, 256) = ${field('external_id')}
      AND ${sf(object, 'account_id')} = ${field('google_ads_customer_id')}
      AND ${sf(object, 'campaign_id')} = ${field('google_ads_campaign_id')}
      AND ${field('source_detail')} = CONCAT('leadgen_form:', ${sf(object, 'form_id')}))`;
  };
  const nativeSignature = (audit, provider) => {
    const object = identity(audit);
    const names = provider === 'meta_ads' ? ['account_id', 'campaign_id', 'ad_id', 'page_id', 'form_id', 'adset_id']
      : ['account_id', 'campaign_id', 'form_id', 'ad_id', 'adgroup_id'];
    return `CAST(JSON_ARRAY(${names.map(name => `COALESCE(${sf(object, name)}, 'null')`).join(',')}) AS CHAR)`;
  };
  const proof = (valid, relevant, provider) => `(EXISTS (SELECT 1 FROM LeadAttributionAudits crp
      WHERE ${sameLead('crp')} AND ${valid('crp')})
    AND NOT EXISTS (SELECT 1 FROM LeadAttributionAudits crb
      WHERE ${sameLead('crb')} AND ${relevant('crb')} AND NOT COALESCE(${valid('crb')}, FALSE))
    AND (SELECT COUNT(DISTINCT ${nativeSignature('cru', provider)}) FROM LeadAttributionAudits cru
      WHERE ${sameLead('cru')} AND ${valid('cru')}) = 1)`;
  const metaRelevant = audit => `(${raw(audit, 'provider')} = 'meta_leadgen' OR ${present(identity(audit))})`;
  const googleRelevant = audit => present(identity(audit));
  const webIdentity = audit => {
    const object = identity(audit);
    return `(${field('source')} IN ('meta_ads','web','call_click','seo','direct')
      AND ${version(object, 2)} AND ${sf(object, 'verified_by')} = 'workspace_web_inventory'
      AND ${sf(object, 'provider')} = 'meta_ads' AND ${positiveInteger(object, 'clinic_id')} AND ${clinic(object)}
      AND ${id(object, 'account_id')} AND ${id(object, 'campaign_id')} AND ${positiveInteger(object, 'intake_config_id')}
      AND ${fingerprint(object, 'web_fingerprint')} AND ${fingerprint(object, 'campaign_binding')})`;
  };
  const webAdIdentity = audit => {
    const object = webAd(audit);
    return `(${field('source')} IN ('web','google_ads','meta_ads','call_click','seo','direct')
      AND ${version(object, 1)} AND ${sf(object, 'verified_by')} = 'workspace_web_ad_inventory'
      AND ${sf(object, 'provider')} IN ('meta_ads','google_ads')
      AND ${positiveInteger(object, 'clinic_id')} AND ${clinic(object)}
      AND ${['account_id', 'campaign_id', 'ad_id', 'adgroup_id'].map(name => id(object, name, '^[1-9][0-9]{0,63}$')).join(' AND ')}
      AND (${sf(object, 'provider')} <> 'google_ads' OR ${sf(object, 'account_id')} REGEXP '^[0-9]{10}$')
      AND ${positiveInteger(object, 'intake_config_id')} AND ${fingerprint(object, 'web_fingerprint')}
      AND ${str(object, 'verified_at')} AND ${sf(object, 'verified_at')} REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      AND STR_TO_DATE(LEFT(${sf(object, 'verified_at')},19), '%Y-%m-%dT%H:%i:%s') IS NOT NULL)`;
  };
  const sig = object => `CONCAT(${sf(object, 'provider')}, ':', ${sf(object, 'account_id')}, ':', ${sf(object, 'campaign_id')})`;
  const webConflict = [];
  for (const [leftValid, leftObject] of [[webIdentity, identity], [webAdIdentity, webAd]]) {
    for (const [rightValid, rightObject] of [[webIdentity, identity], [webAdIdentity, webAd]]) {
      webConflict.push(`EXISTS (SELECT 1 FROM LeadAttributionAudits crx JOIN LeadAttributionAudits cry
        ON cry.lead_intake_id = crx.lead_intake_id WHERE ${sameLead('crx')}
        AND ${leftValid('crx')} AND ${rightValid('cry')}
        AND ${sig(leftObject('crx'))} <> ${sig(rightObject('cry'))})`);
    }
  }
  const directGoogle = `(${field('source')} = 'google_ads' AND ${field('google_ads_customer_id')} REGEXP '^[0-9]{1,64}$'
    AND ${field('google_ads_campaign_id')} REGEXP '^[0-9]{1,64}$')`;
  const mismatchedGoogle = `EXISTS (SELECT 1 FROM LeadAttributionAudits crg WHERE ${sameLead('crg')}
    AND (${webIdentity('crg')} OR ${webAdIdentity('crg')}) AND ${directGoogle}
    AND ((COALESCE(${sf(webAd('crg'), 'provider')}, ${sf(identity('crg'), 'provider')})) <> 'google_ads'
      OR COALESCE(${sf(webAd('crg'), 'account_id')}, ${sf(identity('crg'), 'account_id')}) <> ${field('google_ads_customer_id')}
      OR COALESCE(${sf(webAd('crg'), 'campaign_id')}, ${sf(identity('crg'), 'campaign_id')}) <> ${field('google_ads_campaign_id')}))`;
  // Same precedence as resolveLeadContactMethod(). A phone request belongs to
  // reception even when its marketing campaign is known. This is not a claim
  // that the call connected or was answered, and it leaves attribution intact.
  const detail = `LOWER(TRIM(COALESCE(${field('source_detail')}, '')))`;
  const telephone = `(${detail} IN ('tel_modal','tel_modal_call','web_phone','phone_modal')
    OR (COALESCE(${field('source')}, '') = 'call_click' AND ${detail} NOT LIKE '%chat%' AND ${detail} NOT LIKE '%form%'
      AND ${detail} NOT LIKE '%whatsapp%'))`;
  const googleAccount = `REPLACE(${field('google_ads_customer_id')}, '-', '')`;
  const googleAlias = column => `(${column} = ${googleAccount} OR ${column} = CONCAT('act_', ${googleAccount})
    OR ${column} = CONCAT(LEFT(${googleAccount},3), '-', SUBSTRING(${googleAccount},4,3), '-', RIGHT(${googleAccount},4)))`;
  // Retain the documented legacy web campaign link used by leadCampaign():
  // explicit IDs alone are insufficient; require the existing local inventory,
  // active account mapping and one reviewed assignment to this exact clinic.
  // This proves a campaign link, never a verified ad or an answered call.
  const legacyGoogle = `(${field('source')} IN ('web','call_click','google_ads') AND ${field('channel')} = 'paid'
    AND ${field('google_ads_customer_id')} REGEXP '^([0-9]{10}|[0-9]{3}-[0-9]{3}-[0-9]{4})$'
    AND ${field('google_ads_campaign_id')} REGEXP '^[1-9][0-9]{0,63}$'
    AND EXISTS (SELECT 1 FROM ClinicGoogleAdsAccounts cra JOIN Clinicas crl ON crl.id_clinica = ${field('clinica_id')}
      WHERE cra.isActive = TRUE AND ${googleAlias('cra.customerId')}
      AND ((cra.assignmentScope = 'clinic' AND cra.clinicaId = ${field('clinica_id')})
        OR (cra.assignmentScope = 'group' AND cra.grupoClinicaId > 0 AND cra.grupoClinicaId = crl.grupoClinicaId)))
    AND (EXISTS (SELECT 1 FROM ExternalCampaignInventories cri WHERE cri.provider = 'google_ads'
        AND ${googleAlias('cri.customer_id')} AND cri.campaign_id = ${field('google_ads_campaign_id')})
      OR EXISTS (SELECT 1 FROM GoogleAdsAdInventory cri WHERE cri.present = TRUE
        AND ${googleAlias('cri.customerId')} AND cri.campaignId = ${field('google_ads_campaign_id')}))
    AND (SELECT COUNT(*) FROM ExternalCampaignAssignments cra WHERE cra.provider = 'google_ads'
      AND ${googleAlias('cra.customer_id')} AND cra.campaign_id = ${field('google_ads_campaign_id')}) = 1
    AND EXISTS (SELECT 1 FROM ExternalCampaignAssignments cra WHERE cra.provider = 'google_ads'
      AND ${googleAlias('cra.customer_id')} AND cra.campaign_id = ${field('google_ads_campaign_id')}
      AND cra.status = 'active' AND cra.clinica_id = ${field('clinica_id')}))`;
  return `(${field('clinica_id')} IS NOT NULL AND COALESCE(${field('channel')}, 'unknown') <> 'organic'
    AND NOT ${telephone}
    AND CASE WHEN ${field('external_source')} = 'meta_leadgen' THEN
      (${field('source')} = 'meta_ads' AND ${field('channel')} = 'paid' AND ${field('external_id')} REGEXP '^[1-9][0-9]{0,29}$'
        AND ${['gclid','gbraid','wbraid','google_ads_customer_id','google_ads_campaign_id','ttclid'].map(name => `(${field(name)} IS NULL OR ${field(name)} = '')`).join(' AND ')}
        AND ${proof(nativeMeta, metaRelevant, 'meta_ads')})
    WHEN ${field('external_source')} = 'google_lead_form' THEN
      (${field('source')} = 'google_ads' AND ${field('external_id')} REGEXP '^[a-f0-9]{64}$'
        AND ${proof(nativeGoogle, googleRelevant, 'google_ads')})
    ELSE (EXISTS (SELECT 1 FROM Campanas crc WHERE crc.id_campana = ${field('campana_id')} AND crc.clinica_id = ${field('clinica_id')})
      OR ((${legacyGoogle} OR EXISTS (SELECT 1 FROM LeadAttributionAudits crw
        WHERE ${sameLead('crw')} AND (${webIdentity('crw')} OR ${webAdIdentity('crw')})))
        AND NOT (${webConflict.join(' OR ')}) AND NOT ${mismatchedGoogle})) END)`;
}

function createLeadCampaignResponsibilityService(db) {
  async function forLeads(leads, { transaction = null } = {}) {
    const ids = [...new Set(leads.map(lead => Number(lead.id)).filter(positive))];
    if (!ids.length || !db.sequelize?.query) return new Map();
    const [rows] = await db.sequelize.query(`SELECT \`LeadIntake\`.\`id\`, \`LeadIntake\`.\`clinica_id\`, (${campaignResponsibilitySql()}) AS eligible
      FROM LeadIntakes AS \`LeadIntake\` WHERE \`LeadIntake\`.\`id\` IN (:ids)`, { replacements: { ids }, transaction });
    const clinics = new Map(leads.map(lead => [Number(lead.id), Number(lead.clinica_id)]));
    // IDs are local to a single LeadIntake, nevertheless retain exact caller
    // scope in the predicate rather than accepting a presentation-only DTO.
    return new Map(rows.map(row => [Number(row.id), Boolean(Number(row.eligible))
      && positive(clinics.get(Number(row.id))) && Number(row.clinica_id) === clinics.get(Number(row.id))]));
  }
  return { forLeads };
}

module.exports = { campaignResponsibilitySql, createLeadCampaignResponsibilityService };
