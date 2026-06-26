const axios = require('axios');
const db = require('../../models');
const { normalizePhoneE164 } = require('../lib/phone');
const ClinicMetaAsset = db.ClinicMetaAsset;
const Clinica = db.Clinica;
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

    async resolvePhoneAssetByClinic(clinicId) {
        if (!clinicId) {
            return null;
        }

        const clinicAsset = await ClinicMetaAsset.findOne({
            where: {
                clinicaId: clinicId,
                isActive: true,
                assetType: 'whatsapp_phone_number',
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
                assetType: 'whatsapp_phone_number',
            },
            order: [['updatedAt', 'DESC']],
            raw: true,
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
    async getClinicConfig(clinicId) {
        const asset = await this.resolvePhoneAssetByClinic(clinicId);

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

        const waba = await this.resolveWabaAssetByClinic(clinicId);

        if (waba?.waAccessToken && waba?.phoneNumberId) {
            return {
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

        if (interactiveCtaUrl) {
            return this.sendCtaUrlMessage({
                to,
                body,
                displayText: interactiveCtaText,
                url: interactiveCtaUrl,
                clinicConfig,
            });
        }

        return this.sendTextMessage({ to, body, previewUrl, clinicConfig });
    }

    /**
     * Envía un mensaje interactivo con botón CTA URL dentro de ventana de servicio.
     * Meta renderiza el enlace como botón y evita exponer URLs largas en el cuerpo.
     */
    async sendCtaUrlMessage({ to, body, displayText = 'Abrir enlace', url, clinicConfig = {} }) {
        this.setClinicCredentials(clinicConfig);
        this.assertConfiguration();

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

        const apiUrl = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
        const response = await axios.post(apiUrl, payload, {
            headers: {
                Authorization: `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
            },
        });

        return response.data;
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
