'use strict';

function buildValidWebDocument() {
  return {
    schema_version: 1,
    design_system: {
      brand: 'clinic',
      tokens: {
        color_primary: '#574CFA',
        color_secondary: '#17213B',
        color_accent: '#23C3A6',
        color_surface: '#FFFFFF',
        color_text: '#17213B',
        font_heading: 'manrope',
        font_body: 'inter',
        radius: 'lg',
        spacing_density: 'comfortable',
      },
    },
    pages: [
      {
        id: 'page_home',
        title: 'Implantes dentales en Barcelona',
        slug: 'implantes-dentales-barcelona',
        root_node_ids: ['section_hero'],
        seo: {
          title: 'Implantes dentales en Barcelona',
          description: 'Pide una primera visita y recibe una valoración personalizada.',
          canonical_url: 'https://example.com/implantes-dentales-barcelona',
          social_asset_id: 'public_media_101',
          index: true,
          follow: true,
        },
      },
    ],
    globals: {
      header_node_id: null,
      footer_node_id: null,
    },
    nodes: {
      section_hero: {
        id: 'section_hero',
        type: 'section',
        version: 1,
        props: {
          layout: 'stack',
          columns: 1,
          semantic_tag: 'main',
        },
        children: ['heading_main', 'text_intro', 'image_hero', 'button_primary', 'form_lead'],
        style_tokens: {
          background: 'surface',
          content_width: 'standard',
          spacing_top: 'xl',
          spacing_bottom: 'xl',
          gap: 'md',
          align: 'start',
        },
        responsive: {
          mobile: { spacing_top: 'lg', gap: 'sm' },
        },
      },
      heading_main: {
        id: 'heading_main',
        type: 'heading',
        version: 1,
        props: {
          text: 'Recupera tu sonrisa con un plan claro',
          level: 1,
          size: '3xl',
          align: 'left',
          tone: 'default',
        },
        children: [],
        binding_ids: ['binding_clinic_name'],
      },
      text_intro: {
        id: 'text_intro',
        type: 'text',
        version: 1,
        props: {
          text: 'Te explicamos tus opciones y resolvemos tus dudas antes de decidir.',
          size: 'lg',
          align: 'left',
          tone: 'muted',
        },
        children: [],
      },
      image_hero: {
        id: 'image_hero',
        type: 'image',
        version: 1,
        props: {
          asset_id: 'public_media_102',
          alt: 'Profesional explicando un tratamiento a una paciente',
          decorative: false,
          loading: 'eager',
          fit: 'cover',
          aspect_ratio: '4:3',
          focal_x: 50,
          focal_y: 40,
          caption: '',
        },
        children: [],
      },
      button_primary: {
        id: 'button_primary',
        type: 'button',
        version: 1,
        props: {
          label: 'Pedir primera visita',
          action: 'intake_form_anchor',
          target: 'form_lead',
          variant: 'primary',
          open_in_new_tab: false,
        },
        children: [],
      },
      form_lead: {
        id: 'form_lead',
        type: 'intake_form',
        version: 1,
        props: {
          form_key: 'first_visit',
          title: 'Cuéntanos cómo podemos ayudarte',
          description: 'Déjanos tus datos y el equipo de la clínica te contactará.',
          submit_label: 'Quiero que me contacten',
          success_message: 'Gracias. Hemos recibido tu solicitud.',
          fields: [
            {
              id: 'field_name',
              name: 'first_name',
              type: 'text',
              label: 'Nombre',
              required: true,
              autocomplete: 'given-name',
            },
            {
              id: 'field_phone',
              name: 'phone',
              type: 'tel',
              label: 'Teléfono',
              required: true,
              autocomplete: 'tel',
            },
            {
              id: 'field_privacy',
              name: 'privacy_consent',
              type: 'checkbox',
              label: 'He leído y acepto la política de privacidad',
              required: true,
              autocomplete: 'off',
            },
          ],
        },
        children: [],
      },
    },
    bindings: {
      binding_clinic_name: {
        target_node_id: 'heading_main',
        target_prop: 'text',
        source: 'clinic',
        source_id: null,
        field: 'name',
      },
    },
    seo: {
      title_suffix: 'Clinicaclick',
      indexing: 'inherit',
      default_social_asset_id: 'public_media_101',
    },
    consent: {
      provider: 'inherit',
      preview_mode: false,
      privacy_policy_url: '/politica-de-privacidad',
      privacy_policy_version: '2026-07-17',
      privacy_consent_text: 'He leído y acepto la política de privacidad.',
    },
    integrations: {
      intake_config_id: 'intake_101',
      chat_enabled: true,
      whatsapp_enabled: true,
      phone_enabled: true,
    },
  };
}

module.exports = { buildValidWebDocument };
