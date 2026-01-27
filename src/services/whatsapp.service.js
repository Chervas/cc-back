const axios = require('axios');
const db = require('../../models');
const ClinicMetaAsset = db.ClinicMetaAsset;
const Clinica = db.Clinica;
const sequelize = db.sequelize;

const FALLBACK_CONFIG = {
    phoneNumberId: '101717972850686',
    accessToken:
        'EAAZAsOZAwCgukBPZBjIzcxUntETJTBYBP98DwdCZCgZBsmnxcLS7gN8hoiWMmMnyzaZBjwfRKimzsMKMQdpv3oo7XgWzJCZAzmKUvdWSfo9lCKaanDBRAoZA9RdpFJYbAImZCY5KWZAG85nedJpaap6FLCYbMKV4EkW6JZAeFEpjCFQZCKhzlXA6UuqDMPnuCRasOcs0NG6oL0bQEclTZASPYu3WLmhKV3yXDpTeClrPiuQHldEh1CPIZD',
    apiVersion: 'v22.0',
    defaultCountryCode: '+34',
    templateName: 'hello_world',
    templateLanguage: 'en_US',
    useTemplate: false,
};

const LIMITED_MODE_MAX_OUTBOUND_PER_24H = Number.parseInt(
    process.env.WHATSAPP_LIMITED_MODE_MAX_OUTBOUND_24H || '5',
    10
);

class WhatsAppService {
    constructor() {
        this.phoneNumberId =
            process.env.META_WHATSAPP_PHONE_NUMBER_ID ||
            FALLBACK_CONFIG.phoneNumberId;
        this.accessToken =
            process.env.META_WHATSAPP_ACCESS_TOKEN ||
            FALLBACK_CONFIG.accessToken;
        this.apiVersion =
            process.env.META_API_VERSION || FALLBACK_CONFIG.apiVersion;
        this.defaultCountryCode =
            process.env.META_WHATSAPP_DEFAULT_COUNTRY_CODE ||
            FALLBACK_CONFIG.defaultCountryCode;
        this.defaultTemplateName =
            process.env.META_WHATSAPP_TEMPLATE_NAME ||
            FALLBACK_CONFIG.templateName;
        this.defaultTemplateLanguage =
            process.env.META_WHATSAPP_TEMPLATE_LANGUAGE ||
            FALLBACK_CONFIG.templateLanguage;
        this.defaultUseTemplate =
            process.env.META_WHATSAPP_USE_TEMPLATE !== undefined
                ? process.env.META_WHATSAPP_USE_TEMPLATE === 'true'
                : FALLBACK_CONFIG.useTemplate;
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
    async getClinicConfig(clinicId) {
        const asset = await ClinicMetaAsset.findOne({
            where: {
                clinicaId: clinicId,
                isActive: true,
                assetType: 'whatsapp_phone_number',
            },
            raw: true,
        });

        if (asset?.waAccessToken && asset?.phoneNumberId) {
            return {
                phoneNumberId: asset.phoneNumberId,
                accessToken: asset.waAccessToken,
                wabaId: asset.wabaId || null,
                assignmentScope: asset.assignmentScope || null,
                clinicaId: asset.clinicaId || clinicId,
                grupoClinicaId: asset.grupoClinicaId || null,
                additionalData: asset.additionalData || {},
            };
        }

        // fallback a número de grupo si existe
        const clinic = await Clinica.findByPk(clinicId, {
            attributes: ['grupoClinicaId'],
            raw: true,
        });
        if (clinic?.grupoClinicaId) {
            const groupPhone = await ClinicMetaAsset.findOne({
                where: {
                    grupoClinicaId: clinic.grupoClinicaId,
                    assignmentScope: 'group',
                    isActive: true,
                    assetType: 'whatsapp_phone_number',
                },
                raw: true,
            });
            if (groupPhone?.waAccessToken && groupPhone?.phoneNumberId) {
                return {
                    phoneNumberId: groupPhone.phoneNumberId,
                    accessToken: groupPhone.waAccessToken,
                    wabaId: groupPhone.wabaId || null,
                    assignmentScope: groupPhone.assignmentScope || 'group',
                    clinicaId: groupPhone.clinicaId || clinicId,
                    grupoClinicaId: groupPhone.grupoClinicaId || clinic?.grupoClinicaId || null,
                    additionalData: groupPhone.additionalData || {},
                };
            }
        }

        // fallback a WABA si no hay phone number específico
        const waba = await ClinicMetaAsset.findOne({
            where: {
                clinicaId: clinicId,
                isActive: true,
                assetType: 'whatsapp_business_account',
            },
            raw: true,
        });

        if (waba?.waAccessToken && waba?.phoneNumberId) {
            return {
                phoneNumberId: waba.phoneNumberId,
                accessToken: waba.waAccessToken,
            };
        }

        if (clinic?.grupoClinicaId) {
            const groupWaba = await ClinicMetaAsset.findOne({
                where: {
                    grupoClinicaId: clinic.grupoClinicaId,
                    assignmentScope: 'group',
                    isActive: true,
                    assetType: 'whatsapp_business_account',
                },
                raw: true,
            });
            if (groupWaba?.waAccessToken && groupWaba?.phoneNumberId) {
                return {
                    phoneNumberId: groupWaba.phoneNumberId,
                    accessToken: groupWaba.waAccessToken,
                    wabaId: groupWaba.wabaId || null,
                    assignmentScope: groupWaba.assignmentScope || 'group',
                    clinicaId: groupWaba.clinicaId || clinicId,
                    grupoClinicaId: groupWaba.grupoClinicaId || clinic?.grupoClinicaId || null,
                    additionalData: groupWaba.additionalData || {},
                };
            }
        }

        // fallback global
        return {
            phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID || FALLBACK_CONFIG.phoneNumberId,
            accessToken: process.env.META_WHATSAPP_ACCESS_TOKEN || FALLBACK_CONFIG.accessToken,
            wabaId: null,
            assignmentScope: null,
            clinicaId: clinicId,
            grupoClinicaId: null,
            additionalData: {},
        };
    }

    /**
     * Permite usar credenciales por clínica (si se pasan)
     * @param {*} clinicConfig { phoneNumberId, accessToken }
     */
    setClinicCredentials(clinicConfig = {}) {
        this.phoneNumberId =
            clinicConfig.phoneNumberId ||
            process.env.META_WHATSAPP_PHONE_NUMBER_ID ||
            FALLBACK_CONFIG.phoneNumberId;
        this.accessToken =
            clinicConfig.accessToken ||
            process.env.META_WHATSAPP_ACCESS_TOKEN ||
            FALLBACK_CONFIG.accessToken;
    }

    /**
     * Normaliza un número de teléfono al formato E.164
     * @param {string} raw
     * @returns {string|null}
     */
    normalizePhoneNumber(raw) {
        if (!raw) {
            return null;
        }

        const trimmed = String(raw).trim();
        if (!trimmed) {
            return null;
        }

        const cleaned = trimmed.replace(/[^\d+]/g, '');
        if (!cleaned) {
            return null;
        }

        if (cleaned.startsWith('+')) {
            return cleaned;
        }

        if (cleaned.startsWith('00')) {
            return `+${cleaned.slice(2)}`;
        }

        if (
            this.defaultCountryCode &&
            cleaned.startsWith(
                this.defaultCountryCode.replace('+', '')
            )
        ) {
            return `+${cleaned}`;
        }

        return `${this.defaultCountryCode}${cleaned}`;
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
        clinicConfig = {},
    }) {
        this.setClinicCredentials(clinicConfig);
        const shouldUseTemplate =
            useTemplate !== undefined ? useTemplate : this.defaultUseTemplate;

        if (shouldUseTemplate) {
            return this.sendTemplateMessage({
                to,
                templateName: templateName || this.defaultTemplateName,
                templateLanguage:
                    templateLanguage || this.defaultTemplateLanguage,
                templateParams,
                templateComponents,
                clinicConfig,
            });
        }

        return this.sendTextMessage({ to, body, previewUrl, clinicConfig });
    }

    /**
     * Envía un mensaje de texto a través de la API de WhatsApp
     * @param {Object} params
     * @param {string} params.to
     * @param {string} params.body
     * @param {boolean} [params.previewUrl=false]
     */
    async sendTextMessage({ to, body, previewUrl = false, clinicConfig = {} }) {
        this.setClinicCredentials(clinicConfig);
        this.assertConfiguration();

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
    }) {
        this.setClinicCredentials(clinicConfig);
        this.assertConfiguration();

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

    /**
     * Asegura que la configuración mínima esté presente
     */
    assertConfiguration() {
        if (!this.phoneNumberId) {
            throw new Error(
                'META_WHATSAPP_PHONE_NUMBER_ID no está configurado.'
            );
        }

        if (!this.accessToken) {
            throw new Error('META_WHATSAPP_ACCESS_TOKEN no está configurado.');
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
