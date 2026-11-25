'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataTypes } = require('sequelize');
const { parseDocument, DomUtils } = require('htmlparser2');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { decorateEmailWhatsappLinks, attributeEmailWhatsappReply } = require('../../services/marketingEmailWhatsappAttribution.service');
const { renderMarketingCampaign } = require('../../services/emailTemplates.service');
const { buildLeadAttributionView } = require('../../lib/lead-attribution-view');

test('direct WhatsApp links compose across channels and materialize one campaign lead per contact', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1',
}, async () => {
  const previousKey = process.env.EMAIL_DATA_ENCRYPTION_KEY;
  process.env.EMAIL_DATA_ENCRYPTION_KEY = 'fictitious-attribution-contract-key';
  try {
    await withIsolatedCampaignMysql(async ({ sql }) => {
      const origin = require('../../../models/whatsappweborigin')(sql, DataTypes);
      const audits = require('../../../models/leadattributionaudit')(sql, DataTypes);
      const LeadIntake = sql.define('LeadIntake', {
        external_source: DataTypes.STRING, external_id: DataTypes.STRING, clinica_id: DataTypes.INTEGER,
        grupo_clinica_id: DataTypes.INTEGER, source: DataTypes.STRING, channel: DataTypes.STRING,
        source_detail: DataTypes.STRING, status_lead: DataTypes.STRING, telefono: DataTypes.STRING,
        phone_hash: DataTypes.STRING, utm_source: DataTypes.STRING, utm_medium: DataTypes.STRING,
        utm_campaign: DataTypes.STRING, utm_content: DataTypes.STRING, archived_at: DataTypes.DATE,
      }, { indexes: [{ unique: true, fields: ['external_source', 'external_id'] }] });
      const Conversation = sql.define('Conversation', { clinic_id: DataTypes.INTEGER,
        contact_id: DataTypes.STRING, channel: DataTypes.STRING, lead_id: DataTypes.INTEGER });
      const clinic = { id_clinica: 21, grupoClinicaId: 11 };
      const list = { id: 29, scope_type: 'group', grupo_clinica_id: 11, clinic_ids: [21, 22], criteria: {
        record_kind: 'campaign', template_commercial: true, channels: ['email'], campaign_name: 'Campaña ficticia',
      } };
      const clinicPhone = '34910000001';
      const ownAsset = { id: 44, assetType: 'whatsapp_phone_number', isActive: true, assignmentScope: 'group',
        grupoClinicaId: 11, metaAssetId: '90101', additionalData: { displayPhoneNumber: '+' + clinicPhone } };
      const db = { WhatsAppWebOrigin: origin, LeadAttributionAudit: audits, LeadIntake, Conversation,
        MarketingPatientList: { findByPk: async id => id === list.id ? list : null },
        ClinicMetaAsset: { findAll: async () => [ownAsset] },
        WhatsappChannelBinding: { findAll: async () => [{ clinic_id: 21, asset_id: 44, is_active: true, role: 'primary' }] },
      };
      await sql.sync();
      const conversation = await Conversation.create({ clinic_id: 21, channel: 'whatsapp', contact_id: '+34600000001' });
      const input = {
        html: '<a href="https://wa.me/34910000001?text=Hola%20%C3%81lex">Primero</a>'
          + '<a href="https://wa.me/34910000001?text=Hola">Segundo</a>'
          + '<a href="https://wa.me/34910000002">Ajeno</a><a href="tel:+34910000001">Llamar</a>',
        text: 'Primero (https://wa.me/34910000001?text=Hola%20%C3%81lex)',
      };
      const now = new Date();
      const render = () => sql.transaction(transaction => decorateEmailWhatsappLinks({ db, body: input, list, clinic, transaction, now }));
      const [decorated, nextRecipient] = await Promise.all([render(), render()]);
      assert.deepEqual(nextRecipient, decorated);
      assert.equal(await origin.count(), 2);
      const output = renderMarketingCampaign({ composer_version: 2, body_html: decorated.html, body_text: decorated.text,
        unsubscribe_url: 'https://example.test/email/baja', browser_view_url: 'https://example.test/email/ver',
        preferences_url: 'https://example.test/email/preferencias' });
      const anchors = DomUtils.findAll(node => node.name === 'a', parseDocument(output.html).children);
      const links = anchors.filter(node => node.attribs?.href?.startsWith('https://wa.me/')).map(node => new URL(node.attribs.href));
      const content = links[0].searchParams.get('text');
      assert.match(content, /^Hola Álex\n\nRef\. CC-[A-F0-9]{20}$/);
      assert.match(links[1].searchParams.get('text'), /^Hola\n\nRef\. CC-[A-F0-9]{20}$/);
      assert.notEqual(links[0].href, links[1].href);
      assert.ok(output.text.includes(links[0].href) && output.text.includes(links[1].href));
      assert.equal(links[2].href, 'https://wa.me/34910000002');
      assert.match(output.html, /href="tel:\+34910000001"/);
      assert.equal(await decorateEmailWhatsappLinks({ db, clinic, list: { ...list, criteria: { ...list.criteria, review_request: true } }, body: input }), input);
      assert.equal(await decorateEmailWhatsappLinks({ db, clinic: { ...clinic, id_clinica: 23 }, list, body: input }), input);

      const binding = { phoneId: '90101', assetId: 44, clinicId: 21 };
      const message = { id: 501, direction: 'inbound', conversation_id: conversation.id,
        content, metadata: { provider_type: 'text' }, sent_at: new Date() };
      const apply = (options = {}) => sql.transaction(transaction => attributeEmailWhatsappReply({ db, message,
        conversation, binding, transaction, ...options }));
      for (const rejected of [
        { message: { ...message, content: 'Hola' } },
        { message: { ...message, content: content + '\n' + links[1].searchParams.get('text') } },
        { message: { ...message, sent_at: new Date(Date.now() + 31 * 86400000) } },
        { binding: { ...binding, phoneId: '90102' } },
        { binding: { ...binding, assetId: 45 } },
        { conversation: { id: conversation.id, clinic_id: 22, contact_id: conversation.contact_id, channel: 'whatsapp' } },
      ]) assert.equal(await apply(rejected), null);
      assert.equal(await LeadIntake.count(), 0);
      const lead = await apply({ message: { ...message, content: content.toLowerCase() + '\nGracias.' } });
      const repeat = await apply({ message: { ...message, id: 502, content: links[1].searchParams.get('text') } });
      assert.equal(lead.duplicate, false);
      assert.equal(repeat.duplicate, true);
      assert.equal(repeat.lead.id, lead.lead.id);
      assert.equal(await LeadIntake.count(), 1);
      assert.equal(await audits.count(), 1);
      assert.equal((await Conversation.findByPk(conversation.id)).lead_id, lead.lead.id);
      assert.equal(lead.lead.utm_content, 'boton_1');
      const view = buildLeadAttributionView(lead.lead.get({ plain: true }));
      assert.equal(view.marketing_origin, 'bulk_email');
      assert.equal(view.contact_method, 'whatsapp');
      assert.equal(view.marketing_campaign.name, 'Campaña ficticia');
    });
  } finally {
    if (previousKey === undefined) delete process.env.EMAIL_DATA_ENCRYPTION_KEY;
    else process.env.EMAIL_DATA_ENCRYPTION_KEY = previousKey;
  }
});
