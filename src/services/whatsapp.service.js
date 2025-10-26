const axios = require('axios');

const FALLBACK_CONFIG = {
    phoneNumberId: '101717972850686',
    accessToken:
        'EAAZAsOZAwCgukBP3ASYn9E4cb5EaAuSs37LZAIA78YL1n33lNlbIZAHSJYHHiBTqqIu2npXqB3h7h77kym8zScuGW4oIOWmY9grYCafpJfk1ueiDUKpAJ1ypnIILnly1xSZA0YebAmAvtoBxHxVBozQSJFWcnSOoOnZBRJKmuHRRK55LPSsP04bq29FR6zqTlZCMZCn6OSHDgNFqFdKJqdyZAqT4UZBS7o8FePiOOvrisZCbWQ28gZDZD',
    apiVersion: 'v22.0',
    defaultCountryCode: '+34',
    templateName: 'hello_world',
    templateLanguage: 'en_US',
    useTemplate: true,
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
    }) {
        const shouldUseTemplate =
            useTemplate !== undefined ? useTemplate : this.defaultUseTemplate;

        if (shouldUseTemplate) {
            return this.sendTemplateMessage({
                to,
                templateName: templateName || this.defaultTemplateName,
                templateLanguage:
                    templateLanguage || this.defaultTemplateLanguage,
            });
        }

        return this.sendTextMessage({ to, body, previewUrl });
    }

    /**
     * Envía un mensaje de texto a través de la API de WhatsApp
     * @param {Object} params
     * @param {string} params.to
     * @param {string} params.body
     * @param {boolean} [params.previewUrl=false]
     */
    async sendTextMessage({ to, body, previewUrl = false }) {
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
    async sendTemplateMessage({ to, templateName, templateLanguage }) {
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
