const axios = require('axios');
const db = require('../../models');
const ClinicMetaAsset = db.ClinicMetaAsset;

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
            };
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

        // fallback global
        return {
            phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID || FALLBACK_CONFIG.phoneNumberId,
            accessToken: process.env.META_WHATSAPP_ACCESS_TOKEN || FALLBACK_CONFIG.accessToken,
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
}

module.exports = new WhatsAppService();
