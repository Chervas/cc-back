const axios = require('../lib/metaQuarantineHttp');
const db = require('../../models');
const { normalizePhoneE164 } = require('../lib/phone');
const whatsappAccountHealthService = require('./whatsappAccountHealth.service');
const whatsappChannelBindingsService = require('./whatsappChannelBindings.service');
const whatsappAuthorizedBroker = require('../lib/whatsappAuthorizedBrokerClient');
const { Op } = require('sequelize');
const {
    resolveWhatsappRouting,
    selectWhatsappPhoneAsset,
} = require('../lib/whatsapp-channel-role');
const ClinicMetaAsset = db.ClinicMetaAsset;
const Clinica = db.Clinica;
const MarketingContactOptOut = db.MarketingContactOptOut;
const sequelize = db.sequelize;

const LIMITED_MODE_MAX_OUTBOUND_PER_24H = Number.parseInt(
    process.env.WHATSAPP_LIMITED_MODE_MAX_OUTBOUND_24H || '5',
    10
);
const WHATSAPP_MEDIA_DOWNLOAD_MAX_BYTES = Number.parseInt(
    process.env.WHATSAPP_MEDIA_DOWNLOAD_MAX_BYTES || '25000000',
    10
);

class WhatsAppService {
    constructor() {
        this.phoneNumberId = null;
        this.accessToken = null;
        this.apiVersion = process.env.META_API_VERSION || 'v24.0';
        this.defaultCountryCode =
            process.env.META_WHATSAPP_DEFAULT_COUNTRY_CODE || '+34';
        this.defaultTemplateName =
            process.env.META_WHATSAPP_TEMPLATE_NAME || 'hello_world';
        this.defaultTemplateLanguage =
            process.env.META_WHATSAPP_TEMPLATE_LANGUAGE || 'en_US';
        this.defaultUseTemplate =
            process.env.META_WHATSAPP_USE_TEMPLATE !== undefined
                ? process.env.META_WHATSAPP_USE_TEMPLATE === 'true'
                : false;
    }

    async resolvePhoneAssetByClinic(clinicId, { purpose = null } = {}) {
        if (!clinicId) {
            return null;
        }

        const authorizedIds = whatsappAuthorizedBroker.bindingsForClinic(Number(clinicId)).map(binding => binding.assetId);
        // Inactive containment rows are selectable only through an exact private
        // authorization. Their database flags and legacy credentials stay intact.
        const availability = authorizedIds.length
            ? { [Op.or]: [{ isActive: true }, { id: { [Op.in]: authorizedIds } }] }
            : { isActive: true };
        const clinicAssets = await ClinicMetaAsset.findAll({
            where: {
                clinicaId: clinicId,
                assignmentScope: 'clinic',
                ...availability,
                assetType: 'whatsapp_phone_number',
            },
            order: [['updatedAt', 'DESC']],
            raw: true,
        });

        const clinic = await Clinica.findByPk(clinicId, {
            attributes: ['grupoClinicaId'],
            raw: true,
        });
        const groupAssets = clinic?.grupoClinicaId
            ? await ClinicMetaAsset.findAll({
                where: {
                    grupoClinicaId: clinic.grupoClinicaId,
                    assignmentScope: 'group',
                    ...availability,
                    assetType: 'whatsapp_phone_number',
                },
                order: [['updatedAt', 'DESC']],
                raw: true,
            })
            : [];

        const [routedClinicAssets, routedGroupAssets] = await Promise.all([
            whatsappChannelBindingsService.applyClinicBindings(clinicId, clinicAssets),
            whatsappChannelBindingsService.applyClinicBindings(clinicId, groupAssets),
        ]);

        const [authorizedClinicAssets, authorizedGroupAssets] = await Promise.all([
            whatsappAuthorizedBroker.annotate(Number(clinicId), routedClinicAssets),
            whatsappAuthorizedBroker.annotate(Number(clinicId), routedGroupAssets),
        ]);
        return selectWhatsappPhoneAsset({
            clinicAssets: authorizedClinicAssets,
            groupAssets: authorizedGroupAssets,
            purpose,
            summarizeHealth: (asset) => whatsappAccountHealthService.summarizeAssetHealth(asset),
        });
    }

    async resolveWabaAssetByClinic(clinicId) {
        if (!clinicId) {
            return null;
        }

        const clinicAsset = await ClinicMetaAsset.findOne({
            where: {
                clinicaId: clinicId,
                isActive: true,
                assetType: 'whatsapp_business_account',
            },
            order: [['updatedAt', 'DESC']],
            raw: true,
        });
        if (clinicAsset) {
            return clinicAsset;
        }

        const clinic = await Clinica.findByPk(clinicId, {
            attributes: ['grupoClinicaId'],
            raw: true,
        });
        if (!clinic?.grupoClinicaId) {
            return null;
        }

        return ClinicMetaAsset.findOne({
            where: {
                grupoClinicaId: clinic.grupoClinicaId,
                assignmentScope: 'group',
                isActive: true,
                assetType: 'whatsapp_business_account',
            },
            order: [['updatedAt', 'DESC']],
            raw: true,
        });
    }

    /**
     * Calcula si la ventana de 24h está abierta
     * @param {Date|string|null} lastInboundAt
     */
    checkSessionWindow(lastInboundAt) {
        if (!lastInboundAt) return true;
        const delta = Date.now() - new Date(lastInboundAt).getTime();
        return delta <= 24 * 60 * 60 * 1000;
    }

    /**
     * Obtiene credenciales y phoneNumberId por clínica desde ClinicMetaAssets
     */
    async getClinicConfig(clinicId, options = {}) {
        const asset = await this.resolvePhoneAssetByClinic(clinicId, options);

        if (asset?.whatsappAuthorizedBinding) return this.authorizedConfig(asset, Number(clinicId));

        if (asset && (asset.routing_unavailable === true || (asset.waAccessToken && asset.phoneNumberId))) {
            return {
                originId: asset.id || null,
                phoneNumberId: asset.phoneNumberId,
                accessToken: asset.waAccessToken,
                wabaId: asset.wabaId || null,
                assignmentScope: asset.assignmentScope || null,
                clinicaId: asset.clinicaId || clinicId,
                grupoClinicaId: asset.grupoClinicaId || null,
                additionalData: asset.additionalData || {},
                routingUnavailable: asset.routing_unavailable === true,
                routingPurpose: asset.routing_purpose || null,
            };
        }

        const waba = await this.resolveWabaAssetByClinic(clinicId);

        if (waba?.waAccessToken && waba?.phoneNumberId) {
            return {
                originId: waba.id || null,
                phoneNumberId: waba.phoneNumberId,
                accessToken: waba.waAccessToken,
                wabaId: waba.wabaId || null,
                assignmentScope: waba.assignmentScope || null,
                clinicaId: waba.clinicaId || clinicId,
                grupoClinicaId: waba.grupoClinicaId || null,
                additionalData: waba.additionalData || {},
            };
        }

        return null;
    }

    async getConfigByAssetId(assetId, { clinicId = null } = {}) {
        const normalizedAssetId = Number.parseInt(String(assetId || ''), 10);
        if (!Number.isInteger(normalizedAssetId) || normalizedAssetId <= 0) {
            return null;
        }
        const authorized = whatsappAuthorizedBroker.bindingsForClinic(Number(clinicId)).find(binding => binding.assetId === normalizedAssetId);
        const asset = await ClinicMetaAsset.findOne({
            where: {
                id: normalizedAssetId,
                assetType: 'whatsapp_phone_number',
                ...(!authorized ? { isActive: true } : {}),
            },
            raw: true,
        });
        if (asset && authorized) {
            const binding = await whatsappAuthorizedBroker.binding(Number(clinicId), normalizedAssetId, asset);
            return this.authorizedConfig({ ...asset, whatsappAuthorizedBinding: binding }, Number(clinicId));
        }
        if (!asset?.waAccessToken || !asset?.phoneNumberId) {
            return null;
        }
        return {
            originId: asset.id,
            phoneNumberId: asset.phoneNumberId,
            accessToken: asset.waAccessToken,
            wabaId: asset.wabaId || null,
            assignmentScope: asset.assignmentScope || null,
            clinicaId: asset.clinicaId || clinicId || null,
            grupoClinicaId: asset.grupoClinicaId || null,
            additionalData: asset.additionalData || {},
            originLabel: asset.metaAssetName || asset.waVerifiedName || null,
        };
    }

    authorizedConfig(asset, clinicId) {
        const binding = asset.whatsappAuthorizedBinding;
        if (!binding || binding.clinicId !== clinicId || binding.assetId !== asset.id) {
            throw Object.assign(new Error('whatsapp_authorized_binding_invalid'), { code: 'whatsapp_authorized_binding_invalid', retryable: false });
        }
        return {
            originId: asset.id,
            phoneNumberId: binding.phoneId,
            wabaId: binding.wabaId,
            clinicId,
            clinicaId: clinicId,
            assignmentScope: asset.assignmentScope || null,
            grupoClinicaId: asset.grupoClinicaId || null,
            additionalData: asset.additionalData || {},
            authorizedBroker: binding,
            routingUnavailable: asset.routing_unavailable === true || !binding.sendEnabled,
            routingPurpose: asset.routing_purpose || null,
            originLabel: asset.metaAssetName || asset.waVerifiedName || null,
        };
    }

    /**
     * Permite usar credenciales por clínica (si se pasan)
     * @param {*} clinicConfig { phoneNumberId, accessToken }
     */
    setClinicCredentials(clinicConfig = {}) {
        this.phoneNumberId = clinicConfig.phoneNumberId || null;
        this.accessToken = clinicConfig.accessToken || null;
    }

    /**
     * Normaliza un número de teléfono al formato E.164
     * @param {string} raw
     * @returns {string|null}
     */
    normalizePhoneNumber(raw) {
        return normalizePhoneE164(raw, {
            defaultCountryCode: this.defaultCountryCode.replace(/\D/g, '') || undefined,
        });
    }

    /**
     * Decide si enviar plantilla o texto
     */
    async sendMessage({
        to,
        body,
        previewUrl = false,
        useTemplate,
        templateName,
        templateLanguage,
        templateParams,
        templateComponents,
        interactiveCtaUrl,
        interactiveCtaText,
        clinicConfig = {},
        healthContext = {},
    }) {
        await whatsappAccountHealthService.assertCanSend({
            clinicConfig,
            source: healthContext.source || 'whatsapp_service_preflight',
            messageId: healthContext.messageId || null,
            jobId: healthContext.jobId || null,
            allowPaymentRecoveryProbe: healthContext.allowPaymentRecoveryProbe === true,
        });
        await this.assertRecipientCanReceive({ to, clinicConfig });
        this.setClinicCredentials(clinicConfig);
        const shouldUseTemplate =
            useTemplate !== undefined ? useTemplate : this.defaultUseTemplate;

        try {
            if (shouldUseTemplate) {
                return await this.sendTemplateMessage({
                    to,
                    templateName: templateName || this.defaultTemplateName,
                    templateLanguage:
                        templateLanguage || this.defaultTemplateLanguage,
                    templateParams,
                    templateComponents,
                    clinicConfig,
                    healthContext,
                });
            }

            if (interactiveCtaUrl) {
                return await this.sendCtaUrlMessage({
                    to,
                    body,
                    displayText: interactiveCtaText,
                    url: interactiveCtaUrl,
                    clinicConfig,
                    healthContext,
                });
            }

            return await this.sendTextMessage({ to, body, previewUrl, clinicConfig, healthContext });
        } catch (error) {
            await whatsappAccountHealthService.recordProviderFailure({
                clinicConfig,
                error,
                source: healthContext.source || 'whatsapp_messages_api',
                messageId: healthContext.messageId || null,
                jobId: healthContext.jobId || null,
            }).catch(() => null);
            throw error;
        }
    }

    async assertRecipientCanReceive({ to, clinicConfig = {} }) {
        if (!MarketingContactOptOut) return;
        const phoneDigits = String(this.normalizePhoneNumber(to) || to || '').replace(/\D+/g, '');
        const clinicId = Number(clinicConfig.clinicId || clinicConfig.clinicaId || 0);
        if (!phoneDigits || !clinicId) return;
        const restriction = await MarketingContactOptOut.findOne({
            where: {
                clinica_id: clinicId,
                phone_digits: phoneDigits,
                channel: 'whatsapp',
                scope: 'whatsapp_number',
                status: 'active',
            },
            order: [['updated_at', 'DESC']],
        });
        if (!restriction) return;
        const error = new Error('whatsapp_recipient_number_restricted');
        error.code = 'WHATSAPP_RECIPIENT_NUMBER_RESTRICTED';
        error.status = 409;
        error.details = {
            restriction_id: restriction.id,
            reason: restriction.reason_text || 'Número marcado como erróneo o perteneciente a otra persona',
        };
        throw error;
    }

    /**
     * Envía un mensaje interactivo con botón CTA URL dentro de ventana de servicio.
     * Meta renderiza el enlace como botón y evita exponer URLs largas en el cuerpo.
     */
    async sendCtaUrlMessage({ to, body, displayText = 'Abrir enlace', url, clinicConfig = {}, healthContext = {} }) {
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'cta_url',
                body: {
                    text: String(body || '').trim(),
                },
                action: {
                    name: 'cta_url',
                    parameters: {
                        display_text: String(displayText || 'Abrir enlace').trim().slice(0, 20),
                        url: String(url || '').trim(),
                    },
                },
            },
        };

        return this.dispatchMessage(payload, clinicConfig, healthContext);
    }

    /**
     * Envía un mensaje de texto a través de la API de WhatsApp
     * @param {Object} params
     * @param {string} params.to
     * @param {string} params.body
     * @param {boolean} [params.previewUrl=false]
     */
    async sendTextMessage({ to, body, previewUrl = false, clinicConfig = {}, healthContext = {} }) {
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: {
                body,
                preview_url: previewUrl,
            },
        };

        return this.dispatchMessage(payload, clinicConfig, healthContext);
    }

    /**
     * Envía una plantilla preaprobada
     */
    buildTemplateComponents({ templateParams, templateComponents }) {
        if (Array.isArray(templateComponents) && templateComponents.length) {
            return templateComponents;
        }

        if (templateParams === undefined || templateParams === null) {
            return null;
        }

        const normalizeParam = (value) => {
            if (value && typeof value === 'object' && value.type && value.text) {
                return value;
            }
            return { type: 'text', text: String(value ?? '') };
        };

        let ordered = [];
        if (Array.isArray(templateParams)) {
            ordered = templateParams.map(normalizeParam);
        } else if (typeof templateParams === 'object') {
            ordered = Object.keys(templateParams)
                .sort((a, b) => Number(a) - Number(b))
                .map((key) => normalizeParam(templateParams[key]));
        }

        if (!ordered.length) {
            return null;
        }

        return [
            {
                type: 'body',
                parameters: ordered,
            },
        ];
    }

    async sendTemplateMessage({
        to,
        templateName,
        templateLanguage,
        templateParams,
        templateComponents,
        clinicConfig = {},
        healthContext = {},
    }) {
        const payload = {
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: {
                name: templateName,
                language: {
                    code: templateLanguage,
                },
            },
        };

        const components = this.buildTemplateComponents({ templateParams, templateComponents });
        if (components) {
            payload.template.components = components;
        }

        return this.dispatchMessage(payload, clinicConfig, healthContext);
    }

    async assertClinicNonOperationalAllowed(payload, clinicConfig, message = null) {
        const configuredClinicId = Number(clinicConfig.clinicId || clinicConfig.clinicaId);
        const heldClinic = value => [66, 72].includes(value);
        let clinicId = configuredClinicId;
        if (!message?.conversation_id && !heldClinic(clinicId)) return;
        const eligibility = require('../lib/whatsappAppointmentEligibility');
        const deny = () => eligibility.assertClinicNonOperationalAllowed(heldClinic(clinicId) ? clinicId : configuredClinicId, {
            metadata: { communication_purpose: 'consent' },
        });
        try {
            // The message's caller-controlled metadata never supplies clinic scope.
            // A queued message must still belong to the selected conversation.
            if (message?.conversation_id) {
                const conversation = await db.Conversation.findByPk(message.conversation_id, {
                    attributes: ['id', 'clinic_id'], raw: true,
                });
                if (!conversation || !Number.isSafeInteger(Number(conversation.clinic_id)) || Number(conversation.clinic_id) < 1) {
                    throw new Error('whatsapp_automation_scope_changed');
                }
                clinicId = Number(conversation.clinic_id);
                if (clinicId !== configuredClinicId) {
                    if (heldClinic(clinicId) || heldClinic(configuredClinicId)) return deny();
                    return;
                }
            }
            if (!heldClinic(clinicId)) return;
            const metadata = eligibility.object(message?.metadata);
            eligibility.assertClinicNonOperationalAllowed(clinicId, { payload, metadata });
            eligibility.assertClinicNonOperationalAllowed(clinicId, {
                metadata: { communication_purpose: metadata.flow_domain },
            });
            const strings = [], purposeStrings = [], buttonUrls = [];
            const urlPattern = /https?:\/\/[^\s<>"']+/gi;
            const mediaTypes = new Set(['image', 'video', 'audio', 'document', 'sticker']);
            const collect = (value, depth = 0, role = 'content') => {
                if (depth > 12 || strings.length > 10000) return deny();
                if (typeof value === 'string') {
                    // Catalog fields can be serialized JSON. Classify their
                    // structure, not JSON escapes or an example image's folder.
                    if (/^\s*[\[{]/.test(value)) {
                        let parsed;
                        try { parsed = JSON.parse(value); }
                        catch (_notJson) { /* Ordinary visible text stays text. */ }
                        if (parsed && typeof parsed === 'object') return collect(parsed, depth + 1, role);
                    }
                    strings.push(value);
                    const links = value.match(urlPattern) || [];
                    if (role === 'button') buttonUrls.push(...links);
                    // Keep every URL for destination checks below. Only media
                    // locators/examples lose URL words for PURPOSE detection;
                    // final body text, bindings, metadata and buttons do not.
                    const mediaPath = /^(?:data:|\/?[^\s<>]+\/[^\s<>]+$|[^\s<>{}]+\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp|pdf|mp[34]|m4[av]|mov|webm|ogg|opus|wav|aac)$)/i.test(value.trim());
                    purposeStrings.push(role === 'asset' || role === 'example'
                        ? links.length ? value.replace(urlPattern, ' ') : mediaPath ? '' : value
                        : value);
                } else if (Array.isArray(value)) value.forEach(item => collect(item, depth + 1, role));
                else if (value && typeof value === 'object') {
                    const type = String(value.type || '').trim().toLowerCase();
                    const media = mediaTypes.has(type) || type === 'header' && mediaTypes.has(String(value.format || '').toLowerCase());
                    const nodeRole = ['button', 'buttons'].includes(type) ? 'button' : media ? 'asset' : role;
                    Object.entries(value).forEach(([key, item]) => {
                        strings.push(key); purposeStrings.push(key);
                        const field = key.toLowerCase();
                        const childRole = ['button', 'buttons'].includes(field) ? 'button'
                            : ['template_usage', 'purpose', 'communication_purpose', 'family_key', 'binding'].includes(field) ? 'content'
                            : ['example', 'examples'].includes(field) ? 'example'
                            : mediaTypes.has(field) ? 'asset'
                            : nodeRole === 'asset' && ['text', 'caption'].includes(field) ? 'content' : nodeRole;
                        collect(item, depth + 1, childRole);
                    });
                }
            };
            // Only outbound content, never the patient's clinical history or notes.
            collect(payload?.text);
            collect(payload?.interactive);
            collect(payload?.document);
            for (const type of ['image', 'video', 'audio', 'sticker']) collect(payload?.[type], 0, 'asset');
            collect(payload?.template?.components);
            if (payload?.type === 'template') {
                const template = await db.WhatsappTemplate.findOne({
                    where: { waba_id: String(clinicConfig.wabaId || ''), name: payload.template?.name,
                        language: payload.template?.language?.code },
                    attributes: ['id', 'name', 'catalog_template_id', 'variables', 'components'], raw: true,
                });
                if (template) {
                    const catalog = Number(template.catalog_template_id) > 0
                        ? await db.WhatsappTemplateCatalog.findByPk(template.catalog_template_id, {
                            attributes: ['id', 'name', 'family_key', 'body_text', 'variables', 'components'], raw: true,
                        }) : null;
                    if (require('../lib/whatsapp-template-workflow').isReviewWorkflowWhatsappTemplate({ ...template, catalog })) {
                        eligibility.assertClinicNonOperationalAllowed(clinicId, { metadata: { communication_purpose: 'review_request' } });
                    }
                    eligibility.assertClinicNonOperationalAllowed(clinicId, {
                        templateName: catalog?.name, metadata: { communication_purpose: catalog?.family_key },
                    });
                    const before = purposeStrings.length;
                    collect(template.variables); collect(template.components);
                    collect(catalog?.family_key); collect(catalog?.variables);
                    collect(catalog?.components); collect(catalog?.body_text);
                    const normalized = purposeStrings.slice(before).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
                    if (/\bconsent(?:imiento(?:s)?|_signature|_package|_document|_required)?\b/.test(normalized)
                        || /(?:url_dejar_resena|url_resena_google|google_review_url|review_request|solicitud_resena|firma_resenas|enlace_resena)/.test(normalized)
                        || /\b(?:resena|reviews)\b/.test(normalized)
                        || /\b(?:deja(?:r)?|solicita(?:r)?|escrib(?:e|ir))\b.{0,50}\bresena\b/.test(normalized)) return deny();
                }
            }
            // A real button is an outgoing destination, unlike header media or
            // a catalog example. Do not let an innocuous display label hide its
            // review/consent route even when the template has a neutral name.
            if (buttonUrls.some(value => /(?:consent|resena|\breviews?\b)/i.test(value))) return deny();
            const urls = strings.flatMap(value => value.match(/https?:\/\/[^\s<>"']+/gi) || []);
            // Consent PDFs and signing links are recognizable independently of the
            // filename, template name and caller's generic document/package IDs.
            for (const value of urls) {
                let url, path;
                try { url = new URL(value.replace(/[),.;]+$/, '')); path = decodeURIComponent(url.pathname); }
                catch (_invalidUrl) { continue; }
                if (/^\/tablet\/consentimientos\/[^/]+\/?$/.test(path)
                    || /^\/(?:api\/)?consentimientos\/documents\/[1-9]\d*\/pdf\/?$/.test(path)
                    || url.hostname === 'g.page' && /^\/r\/[^/]+\/review\/?$/.test(path)
                    || /^(?:search\.)?google\.[a-z.]+$/.test(url.hostname) && path === '/local/writereview') return deny();
            }
            if (urls.length) {
                // url_dejar_resena is derived, not a Clinicas SQL column. The
                // existing resolver reads locally synchronized business-profile
                // links and configured aliases; it never calls Google's API.
                const clinic = await Clinica.findByPk(clinicId, { attributes: ['id_clinica', 'configuracion'], raw: true });
                const links = await require('./googleLocalLinks.service').resolveClinicGoogleReviewLinks(clinic || { id_clinica: clinicId });
                const configuredReviewUrl = String(links?.url_dejar_resena || '').trim();
                if (configuredReviewUrl && urls.some(value => {
                    try {
                        const expected = new URL(configuredReviewUrl), actual = new URL(value.replace(/[),.;]+$/, ''));
                        return expected.host === actual.host && expected.pathname.replace(/\/$/, '') === actual.pathname.replace(/\/$/, '')
                            && [...expected.searchParams].every(([key, item]) => actual.searchParams.get(key) === item);
                    } catch (_invalidUrl) { return false; }
                })) return deny();
            }
        } catch (_error) {
            // Unknown DB/classification failures must not leak SQL, signed links or
            // tokens, nor turn into a fallback send through the legacy Graph route.
            if (heldClinic(clinicId) || heldClinic(configuredClinicId)) return deny();
            // A failed lookup cannot prove that a persisted conversation is
            // outside BS. This is a scope failure, not a new consent/review ban
            // for other clinics, and must not fall back to a direct send.
            throw Object.assign(new Error('whatsapp_automation_scope_changed'), {
                code: 'whatsapp_automation_scope_changed', retryable: false, statusCode: 409,
                details: { reason_code: 'whatsapp_automation_scope_changed' },
            });
        }
    }

    async dispatchMessage(payload, clinicConfig = {}, healthContext = {}) {
        let storedMessage = null;
        if (healthContext.messageId) {
            const message = await db.Message.findByPk(healthContext.messageId);
            storedMessage = message;
            if (message && (whatsappAuthorizedBroker.isManagedMessage
                ? await whatsappAuthorizedBroker.isManagedMessage(message) : message.metadata?.visit_communication_id)) {
                await require('./appointmentVisitManaged.service').current().assertTransport(message.id, healthContext.visitDispatchAuthorization);
                if (!clinicConfig.authorizedBroker) throw Object.assign(new Error('appointment_visit_runtime_authorized_broker_required'), {
                    code: 'appointment_visit_runtime_authorized_broker_required', retryable: false,
                });
            }
        }
        await this.assertClinicNonOperationalAllowed(payload, clinicConfig, storedMessage);
        if (payload.type === 'template') {
            await require('./whatsappTemplateScope.service').assertTemplateInWaba({
                wabaId: clinicConfig.wabaId, clinicId: clinicConfig.clinicId || clinicConfig.clinicaId,
                name: payload.template.name, language: payload.template.language.code,
            });
            await require('./securityMonitoring.service').assertTemplateAllowed(clinicConfig.wabaId, payload.template.name, payload.template.language.code);
        }
        await require('../lib/automation-runtime-stop').assertMessageCanDispatch(healthContext.messageId);
        if (clinicConfig.authorizedBroker) {
            const binding = clinicConfig.authorizedBroker;
            const messageId = Number.isSafeInteger(healthContext.messageId) && healthContext.messageId > 0
                ? String(healthContext.messageId) : healthContext.messageId;
            if (Object.hasOwn(clinicConfig, 'accessToken') || clinicConfig.phoneNumberId !== binding.phoneId || clinicConfig.wabaId !== binding.wabaId) {
                throw Object.assign(new Error('whatsapp_authorized_binding_invalid'), { code: 'whatsapp_authorized_binding_invalid', retryable: false });
            }
            try {
                return await whatsappAuthorizedBroker.send({ messageId, clinicId: Number(clinicConfig.clinicId || clinicConfig.clinicaId),
                    assetId: Number(clinicConfig.originId), expectedBinding: binding, message: payload }, healthContext.visitDispatchAuthorization);
            } catch (error) {
                if (require('../lib/whatsapp-dispatch-wait').deferred(error) && !healthContext.visitDispatchAuthorization) {
                    await require('./whatsappDispatchWait.service').defer(error);
                }
                throw error;
            }
        }
        this.setClinicCredentials(clinicConfig);
        this.assertConfiguration();
        const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
        const response = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
            },
        });

        return response.data;
    }

    /**
     * Registra un numero de telefono en la Cloud API
     * Requiere el token del WABA/numero y, si aplica, el PIN de verificacion en dos pasos
     */
    async registerPhoneNumber({ phoneNumberId, accessToken, pin }) {
        if (!phoneNumberId) {
            throw new Error('phoneNumberId requerido');
        }
        if (!accessToken) {
            throw new Error('accessToken requerido');
        }

        const url = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}/register`;
        const payload = { messaging_product: 'whatsapp' };
        if (pin) {
            payload.pin = String(pin).trim();
        }

        const response = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
        });

        return response.data;
    }

    /**
     * Solicita a Meta la sincronizacion inicial de datos de WhatsApp Business App
     * para numeros conectados en modo coexistencia.
     *
     * syncType admitidos por Meta:
     * - smb_app_state_sync: contactos de la app WhatsApp Business
     * - history: historial de chats compartido por la clinica
     */
    async requestBusinessAppDataSync({ phoneNumberId, accessToken, syncType }) {
        if (!phoneNumberId) {
            throw new Error('phoneNumberId requerido');
        }
        if (!accessToken) {
            throw new Error('accessToken requerido');
        }
        if (!['smb_app_state_sync', 'history'].includes(syncType)) {
            throw new Error(`syncType no soportado: ${syncType}`);
        }

        const url = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}/smb_app_data`;
        const response = await axios.post(
            url,
            {
                messaging_product: 'whatsapp',
                sync_type: syncType,
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        return response.data;
    }

    /**
     * Configura el PIN de verificación en dos pasos para un número de WhatsApp.
     */
    async setTwoStepVerification({ phoneNumberId, accessToken, pin }) {
        if (!phoneNumberId) {
            throw new Error('phoneNumberId requerido');
        }
        if (!accessToken) {
            throw new Error('accessToken requerido');
        }
        if (!pin) {
            throw new Error('pin requerido');
        }

        const url = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}/two_step_verification`;
        const payload = { pin: String(pin).trim() };

        const response = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
        });

        return response.data;
    }

    /**
     * Obtiene el estado del numero de telefono en la Cloud API
     */
    async getPhoneNumberStatus({ phoneNumberId, accessToken }) {
        if (!phoneNumberId || !accessToken) {
            return null;
        }

        const url = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}`;
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
            params: {
                fields:
                    'id,verified_name,display_phone_number,quality_rating,code_verification_status,status,platform_type',
            },
        });

        return response.data;
    }

    async getMediaInfo({ mediaId, accessToken }) {
        if (!mediaId) {
            throw new Error('whatsapp_media_id_required');
        }
        if (!accessToken) {
            throw new Error('whatsapp_access_token_required');
        }

        const url = `https://graph.facebook.com/${this.apiVersion}/${mediaId}`;
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });

        return response.data;
    }

    async downloadMediaBuffer({ mediaId, accessToken, maxBytes = WHATSAPP_MEDIA_DOWNLOAD_MAX_BYTES }) {
        const mediaInfo = await this.getMediaInfo({ mediaId, accessToken });
        const mediaUrl = mediaInfo?.url;
        if (!mediaUrl) {
            throw new Error('whatsapp_media_url_missing');
        }

        const fileSize = Number(mediaInfo?.file_size || 0);
        if (Number.isFinite(fileSize) && fileSize > 0 && maxBytes > 0 && fileSize > maxBytes) {
            throw new Error('whatsapp_media_too_large');
        }

        const response = await axios.get(mediaUrl, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
            responseType: 'arraybuffer',
            timeout: 30000,
            maxBodyLength: maxBytes > 0 ? maxBytes : Infinity,
            maxContentLength: maxBytes > 0 ? maxBytes : Infinity,
        });
        const buffer = Buffer.from(response.data || []);
        if (maxBytes > 0 && buffer.length > maxBytes) {
            throw new Error('whatsapp_media_too_large');
        }

        return {
            mediaInfo,
            buffer,
            contentType: response.headers?.['content-type'] || mediaInfo?.mime_type || null,
        };
    }

    /**
     * Asegura que la configuración mínima esté presente
     */
    assertConfiguration() {
        if (!this.phoneNumberId) {
            throw new Error('whatsapp_phone_number_not_configured_for_scope');
        }

        if (!this.accessToken) {
            throw new Error('whatsapp_access_token_not_configured_for_scope');
        }
    }

    isLimitedMode(additionalData = {}, displayPhoneNumber = '') {
        if (additionalData?.limitedMode || additionalData?.isTestNumber) {
            return true;
        }
        const digits = String(displayPhoneNumber || '').replace(/\D/g, '');
        return digits.startsWith('1555');
    }

    async getScopeClinicIds(config = {}) {
        if (config.assignmentScope === 'clinic' && config.clinicaId) {
            return [config.clinicaId];
        }
        if (config.assignmentScope === 'group' && config.grupoClinicaId) {
            const clinics = await Clinica.findAll({
                where: { grupoClinicaId: config.grupoClinicaId },
                attributes: ['id_clinica'],
                raw: true,
            });
            return clinics.map((c) => c.id_clinica);
        }
        if (config.clinicaId) {
            return [config.clinicaId];
        }
        return [];
    }

    async countOutboundLast24hByClinics(clinicIds = []) {
        if (!clinicIds.length) {
            return 0;
        }
        const rows = await sequelize.query(
            `
            SELECT COUNT(*) AS total
            FROM Messages m
            JOIN Conversations c ON c.id = m.conversation_id
            WHERE m.direction = 'outbound'
              AND m.createdAt >= (NOW() - INTERVAL 24 HOUR)
              AND c.clinic_id IN (:clinicIds)
              AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.limitReason')), '') != 'limit_reached'
            `,
            {
                replacements: { clinicIds },
                type: db.Sequelize.QueryTypes.SELECT,
            }
        );
        return Number(rows?.[0]?.total || 0);
    }

    async getOutboundUsageForPhone({ clinicConfig, displayPhoneNumber }) {
        const limitedMode = this.isLimitedMode(
            clinicConfig?.additionalData,
            displayPhoneNumber || clinicConfig?.additionalData?.displayPhoneNumber
        );
        if (!limitedMode) {
            return { limitedMode: false, count: 0, limit: null, clinicIds: [] };
        }

        const clinicIds = await this.getScopeClinicIds(clinicConfig);
        const count = await this.countOutboundLast24hByClinics(clinicIds);
        return {
            limitedMode: true,
            count,
            limit: LIMITED_MODE_MAX_OUTBOUND_PER_24H,
            clinicIds,
        };
    }

    async checkOutboundLimit({ clinicConfig, conversation }) {
        let usage = await this.getOutboundUsageForPhone({ clinicConfig });

        // Si aun no detectamos modo limitado, intentamos leer el display phone number en vivo
        if (
            !usage.limitedMode &&
            clinicConfig?.phoneNumberId &&
            clinicConfig?.accessToken
        ) {
            try {
                const live = await this.getPhoneNumberStatus({
                    phoneNumberId: clinicConfig.phoneNumberId,
                    accessToken: clinicConfig.accessToken,
                });
                if (live?.display_phone_number) {
                    const limitedLive = this.isLimitedMode(
                        clinicConfig.additionalData,
                        live.display_phone_number
                    );
                    if (limitedLive) {
                        const asset = await ClinicMetaAsset.findOne({
                            where: {
                                phoneNumberId: clinicConfig.phoneNumberId,
                            },
                        });
                        if (asset) {
                            const additionalData = asset.additionalData || {};
                            additionalData.isTestNumber = true;
                            additionalData.limitedMode = true;
                            additionalData.displayPhoneNumber =
                                live.display_phone_number;
                            asset.additionalData = additionalData;
                            await asset.save();
                            clinicConfig.additionalData = additionalData;
                        }
                        usage = await this.getOutboundUsageForPhone({
                            clinicConfig,
                            displayPhoneNumber: live.display_phone_number,
                        });
                    }
                }
            } catch (err) {
                // no bloqueamos el envio si falla el check en vivo
            }
        }

        const limitReached =
            usage.limitedMode && usage.limit !== null && usage.count >= usage.limit;

        return {
            ...usage,
            limitReached,
            conversationId: conversation?.id || null,
        };
    }
}

module.exports = new WhatsAppService();
