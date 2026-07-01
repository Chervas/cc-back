const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../models');
const crypto = require('crypto');

const CitaPaciente = db.CitaPaciente;
const LeadIntake = db.LeadIntake;
const LeadAttributionAudit = db.LeadAttributionAudit;
const { findCanonicalWhatsappConversation } = require('../lib/canonical-conversation');
const Paciente = db.Paciente;
const Clinica = db.Clinica;
const Campana = db.Campana;
const Instalacion = db.Instalacion;
const InstalacionHorario = db.InstalacionHorario;
const InstalacionBloqueo = db.InstalacionBloqueo;
const DoctorClinica = db.DoctorClinica;
const DoctorHorario = db.DoctorHorario;
const DoctorBloqueo = db.DoctorBloqueo;
const Tratamiento = db.Tratamiento;
const FlowExecutionV2 = db.FlowExecutionV2;
const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const Conversation = db.Conversation;
const Message = db.Message;
const ConversationRead = db.ConversationRead;
const appointmentAutomationV2Runtime = require('../services/appointmentAutomationV2Runtime.service');
const { CITA_STATUS_VALUES } = require('../lib/status-catalog');
const { getIO } = require('../services/socket.service');
const { normalizePhoneDigits, getPhoneLookupCandidates } = require('../lib/phone');
const { normalizeHumanName } = require('../lib/name');
const consentimientosService = require('../services/consentimientos.service');
const appointmentNotificationCleanup = require('../services/appointmentNotificationCleanup.service');

const CITA_ESTADOS_VALIDOS = new Set(CITA_STATUS_VALUES);
const ACTIVE_APPOINTMENT_WHERE = { estado: { [Op.ne]: 'cancelada' } };
const CITA_ESTADOS_TERMINALES_AUTOMATION = new Set(['cancelada', 'reprogramada', 'completada', 'no_asistio']);
const CITA_ESTADOS_RESUELVEN_NOTIFICACIONES = new Set([
    'info_confirmada',
    'recordatorio_confirmado',
    'cancelada',
    'reprogramada',
    'completada',
    'no_asistio'
]);
const generatePacientePublicId = () => `pac_${crypto.randomBytes(10).toString('hex')}`;

async function generateUniquePacientePublicId() {
    for (let i = 0; i < 8; i++) {
        const publicId = generatePacientePublicId();
        const existing = await Paciente.findOne({ where: { public_id: publicId }, attributes: ['id_paciente'] });
        if (!existing) return publicId;
    }
    throw new Error('paciente_public_id_generation_failed');
}

async function findPacienteByIdentifier(id) {
    const value = String(id || '').trim();
    if (!value) return null;
    if (/^\d+$/.test(value)) {
        return Paciente.findByPk(Number(value), {
            include: [{ model: db.PacienteClinica, as: 'clinicasVinculadas', required: false }]
        });
    }
    const publicIds = value.startsWith('pat_') ? [value, `pac_${value.slice(4)}`] : [value];
    return Paciente.findOne({
        where: { public_id: { [Op.in]: publicIds } },
        include: [{ model: db.PacienteClinica, as: 'clinicasVinculadas', required: false }]
    });
}

async function ensureConsentPackageAndAutomation(cita, req, triggerSource = 'appointment') {
    if (!cita?.id_cita) return null;
    try {
        const result = await consentimientosService.ensurePackageForAppointment(cita.id_cita, {
            createdBy: req.userData?.userId || null,
            triggerSource,
        });
        const packagePlain = result?.package?.toJSON ? result.package.toJSON() : result?.package;
        if (packagePlain?.id) {
            await appointmentAutomationV2Runtime.enqueueExecutionForCita(cita, {
                event_name: 'consent_required',
                window_identifier: `consent:${packagePlain.public_id || packagePlain.id}`,
                trigger_data: {
                    consent_package_id: packagePlain.id,
                    consent_package_public_id: packagePlain.public_id || null,
                    consent_required_count: result?.summary?.required_total || packagePlain.required_count || 0,
                    consent_pending_required: result?.summary?.pending_required || 0,
                    consent_public_url_pending: true,
                },
                user_id: req.userData?.userId || null,
                user_name: req.userData?.name || req.userData?.nombre || req.userData?.email || null,
                user_role: req.userData?.role || req.userData?.rol || 'admin',
            });
        }
        return result;
    } catch (error) {
        console.warn('⚠️ [Citas] No se pudo preparar paquete de consentimientos:', error.message || error);
        return null;
    }
}

const LEAD_ACTIVE_APPOINTMENT_STATES = new Set([
    'pendiente',
    'info_enviada',
    'info_confirmada',
    'recordatorio_enviado',
    'recordatorio_confirmado',
    'reprogramada',
]);

const LEAD_SOURCE_LABELS = {
    meta_ads: 'Meta Ads',
    google_ads: 'Google Ads',
    tiktok_ads: 'TikTok Ads',
    web: 'Web',
    whatsapp: 'WhatsApp',
    call_click: 'Llamada web',
    seo: 'SEO',
    direct: 'Directo',
    local_services: 'Servicios locales',
};

const LEAD_SOURCE_DETAIL_LABELS = {
    tel_modal: 'Popup de llamada web',
    tel_modal_call: 'Popup de llamada web',
};

function emitAppointmentSocketEvent(eventName, citaLike) {
    const io = getIO();
    if (!io || !citaLike) return;

    const clinicId = Number(citaLike.clinica_id || citaLike.clinic_id || 0);
    const appointmentId = Number(citaLike.id_cita || citaLike.id || 0);
    if (!Number.isFinite(clinicId) || clinicId <= 0 || !Number.isFinite(appointmentId) || appointmentId <= 0) {
        return;
    }

    const payload = {
        appointment_id: appointmentId,
        clinic_id: clinicId,
        patient_id: Number(citaLike.paciente_id || citaLike.patient_id || 0) || null,
        lead_intake_id: Number(citaLike.lead_intake_id || 0) || null,
        doctor_id: Number(citaLike.doctor_id || 0) || null,
        instalacion_id: Number(citaLike.instalacion_id || 0) || null,
        tratamiento_id: Number(citaLike.tratamiento_id || 0) || null,
        estado: citaLike.estado || null,
        inicio: citaLike.inicio || null,
        fin: citaLike.fin || null,
        updated_at: citaLike.updated_at || citaLike.updatedAt || new Date().toISOString(),
        created_at: citaLike.created_at || citaLike.createdAt || new Date().toISOString(),
    };

    io.to(`clinic:${clinicId}`).emit(eventName, payload);
}

function mapEstadoToAutomationV2Event(estado) {
    if (estado === 'pendiente') return 'appointment_created';
    if (estado === 'info_enviada') return 'appointment_created';
    if (estado === 'info_confirmada') return 'appointment_confirmed';
    if (estado === 'recordatorio_confirmado') return 'appointment_confirmed';
    if (estado === 'reprogramada') return 'appointment_rescheduled';
    if (estado === 'no_asistio') return 'appointment_no_show';
    if (estado === 'cancelada') return 'appointment_cancelled';
    if (estado === 'completada') return 'appointment_completed';
    return null;
}

function mapFlowSummary(flow) {
    if (!flow) return null;
    return {
        flow_instance_id: flow.id,
        flow_status: flow.status,
        current_step_index: flow.current_step_index,
        current_step_type: flow.current_step_type,
        current_step_label: flow.current_step_label,
        current_state: flow.current_state,
        agenda_icon: flow.agenda_icon,
        next_action_at: flow.next_action_at,
        last_transition_at: flow.last_transition_at,
        error_message: flow.last_error || null,
        template_id: flow.template_id,
        template_version: flow.template_version || null
    };
}

function mapFlowSummaryV2(execution) {
    if (!execution) return null;
    const item = execution?.toJSON ? execution.toJSON() : execution;
    const template = item?.templateVersion || null;
    const nodes = Array.isArray(template?.nodes) ? template.nodes : [];
    const currentNodeId = item.current_node_id || null;
    const currentNode = currentNodeId ? nodes.find((node) => String(node?.id || '') === String(currentNodeId)) : null;
    const waitUntil = item.wait_until || item.waiting_meta?.wait_until || null;

    return {
        flow_instance_id: item.id,
        flow_status: item.status,
        current_step_index: null,
        current_step_type: currentNode?.type || null,
        current_step_label: currentNode?.label || currentNodeId || null,
        current_state: item.status,
        agenda_icon: null,
        next_action_at: waitUntil,
        last_transition_at: item.updated_at || item.created_at || null,
        error_message: item.last_error || null,
        template_id: item.template_version_id || null,
        template_version: template?.version || null,
        template_name: template?.name || null,
    };
}

function parsePositiveInt(value) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizePhone(value) {
    return normalizePhoneDigits(value);
}

async function findPendingCallLeadForAppointment({ clinica_id, telefono }) {
    const clinicId = parsePositiveInt(clinica_id);
    const normalizedPhone = normalizePhone(telefono);
    if (!clinicId || !normalizedPhone) return null;

    const localPhone = normalizedPhone.length > 9 ? normalizedPhone.slice(-9) : normalizedPhone;
    const phoneWhere = [
        { telefono: normalizedPhone },
        { telefono: { [Op.like]: `%${normalizedPhone}` } },
    ];
    if (localPhone && localPhone !== normalizedPhone) {
        phoneWhere.push({ telefono: localPhone });
        phoneWhere.push({ telefono: { [Op.like]: `%${localPhone}` } });
    }

    const candidates = await LeadIntake.findAll({
        where: {
            clinica_id: clinicId,
            call_initiated: true,
            call_outcome: { [Op.is]: null },
            call_outcome_appointment_id: { [Op.is]: null },
            [Op.or]: phoneWhere,
        },
        order: [['call_initiated_at', 'DESC'], ['created_at', 'DESC'], ['id', 'DESC']],
        limit: 20,
    });

    return candidates.find((lead) => {
        const candidatePhone = normalizePhone(lead?.telefono);
        return !!candidatePhone && (candidatePhone === normalizedPhone || candidatePhone.endsWith(localPhone));
    }) || null;
}

async function findHistoricalAttributedLeadForPatient({ clinica_id, telefono, email }) {
    const clinicId = parsePositiveInt(clinica_id);
    const normalizedPhone = normalizePhone(telefono);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!clinicId || (!normalizedPhone && !normalizedEmail)) return null;

    const localPhone = normalizedPhone && normalizedPhone.length > 9
        ? normalizedPhone.slice(-9)
        : normalizedPhone;
    const orWhere = [];

    if (normalizedPhone) {
        orWhere.push({ telefono: normalizedPhone });
        orWhere.push({ telefono: { [Op.like]: `%${normalizedPhone}` } });
        if (localPhone && localPhone !== normalizedPhone) {
            orWhere.push({ telefono: localPhone });
            orWhere.push({ telefono: { [Op.like]: `%${localPhone}` } });
        }
    }

    if (normalizedEmail) {
        orWhere.push({ email: normalizedEmail });
    }

    const candidates = await LeadIntake.findAll({
        where: {
            clinica_id: clinicId,
            [Op.or]: orWhere,
        },
        include: [
            {
                model: Campana,
                as: 'campana',
                attributes: ['id', 'nombre'],
                required: false,
            },
        ],
        order: [['created_at', 'ASC'], ['id', 'ASC']],
        limit: 50,
    });

    return candidates.find((lead) => {
        const candidatePhone = normalizePhone(lead?.telefono);
        const candidateEmail = String(lead?.email || '').trim().toLowerCase();
        const phoneMatches = normalizedPhone
            ? !!candidatePhone && (candidatePhone === normalizedPhone || (!!localPhone && candidatePhone.endsWith(localPhone)))
            : false;
        const emailMatches = normalizedEmail
            ? candidateEmail === normalizedEmail
            : false;
        if (!phoneMatches && !emailMatches) {
            return false;
        }
        return !!(
            lead?.source
            || lead?.source_detail
            || lead?.campana_id
            || lead?.page_url
            || lead?.landing_url
            || lead?.call_initiated
        );
    }) || null;
}

function buildLeadMeasurementPreview(lead, kind, { autoLinkOnSave = false } = {}) {
    if (!lead) return null;
    const plain = lead?.toJSON ? lead.toJSON() : lead;
    const source = String(plain?.source || '').trim() || null;
    const sourceDetail = String(plain?.source_detail || '').trim() || null;
    return {
        kind,
        auto_link_on_save: !!autoLinkOnSave,
        lead_id: parsePositiveInt(plain?.id),
        source,
        source_label: source ? (LEAD_SOURCE_LABELS[source] || source) : null,
        source_detail: sourceDetail,
        source_detail_label: sourceDetail ? (LEAD_SOURCE_DETAIL_LABELS[sourceDetail] || sourceDetail) : null,
        campaign_id: parsePositiveInt(plain?.campana_id),
        campaign_name: String(plain?.campana?.nombre || '').trim() || null,
        page_url: String(plain?.page_url || '').trim() || null,
        landing_url: String(plain?.landing_url || '').trim() || null,
        call_initiated_at: plain?.call_initiated_at || null,
        phone: String(plain?.telefono || '').trim() || null,
    };
}

exports.getManualAttributionPreview = asyncHandler(async (req, res) => {
    const clinicaId = parsePositiveInt(req.query?.clinica_id);
    const patientId = parsePositiveInt(req.query?.patient_id);
    const tipoCita = String(req.query?.tipo_cita || '').trim().toLowerCase();
    if (!clinicaId) {
        return res.status(400).json({ success: false, message: 'clinica_id inválida' });
    }

    let telefono = String(req.query?.telefono || '').trim();
    let email = String(req.query?.email || '').trim();

    if (patientId) {
        const patient = await Paciente.findByPk(patientId, {
            attributes: ['id_paciente', 'telefono_movil', 'email'],
        });
        if (patient) {
            telefono = telefono || String(patient.telefono_movil || '').trim();
            email = email || String(patient.email || '').trim();
        }
    }

    if (tipoCita === 'continuacion') {
        return res.json({
            success: true,
            data: {
                kind: 'continuation',
                auto_link_on_save: false,
                source: null,
                source_label: null,
                source_detail: null,
                source_detail_label: null,
                campaign_id: null,
                campaign_name: null,
                page_url: null,
                landing_url: null,
                call_initiated_at: null,
                phone: normalizePhone(telefono),
            },
        });
    }

    const pendingLead = await findPendingCallLeadForAppointment({
        clinica_id: clinicaId,
        telefono,
    });
    if (pendingLead) {
        const hydratedLead = await LeadIntake.findByPk(pendingLead.id, {
            include: [
                {
                    model: Campana,
                    as: 'campana',
                    attributes: ['id', 'nombre'],
                    required: false,
                },
            ],
        });
        return res.json({
            success: true,
            data: buildLeadMeasurementPreview(hydratedLead || pendingLead, 'pending_call_auto_link', { autoLinkOnSave: true }),
        });
    }

    const historicalLead = await findHistoricalAttributedLeadForPatient({
        clinica_id: clinicaId,
        telefono,
        email,
    });
    if (historicalLead) {
        return res.json({
            success: true,
            data: buildLeadMeasurementPreview(historicalLead, 'patient_origin'),
        });
    }

    return res.json({
        success: true,
        data: {
            kind: 'manual_no_attribution',
            auto_link_on_save: false,
            source: null,
            source_label: null,
            source_detail: null,
            source_detail_label: null,
            campaign_id: null,
            campaign_name: null,
            page_url: null,
            landing_url: null,
            call_initiated_at: null,
            phone: normalizePhone(telefono),
        },
    });
});

async function syncLeadStatusFromAppointments(leadId) {
    const normalizedLeadId = parsePositiveInt(leadId);
    if (!normalizedLeadId || !LeadIntake) return null;

    const lead = await LeadIntake.findByPk(normalizedLeadId);
    if (!lead) return null;

    if (['convertido', 'descartado', 'acudio_cita'].includes(String(lead.status_lead || '').toLowerCase())) {
        return lead;
    }

    const citas = await CitaPaciente.findAll({
        where: { lead_intake_id: normalizedLeadId },
        attributes: ['id_cita', 'estado', 'inicio'],
        order: [['inicio', 'DESC'], ['id_cita', 'DESC']],
        raw: true,
    });

    const activeAppointment = citas.find((row) =>
        LEAD_ACTIVE_APPOINTMENT_STATES.has(String(row?.estado || '').toLowerCase())
    ) || null;

    let nextStatus = String(lead.status_lead || '').toLowerCase() || 'nuevo';
    let nextAppointmentId = parsePositiveInt(lead.call_outcome_appointment_id);

    if (activeAppointment) {
        nextStatus = 'citado';
        nextAppointmentId = parsePositiveInt(activeAppointment.id_cita);
    } else {
        if (nextStatus === 'citado') {
            nextStatus = 'info_recibida';
        }
        nextAppointmentId = null;
    }

    const changedStatus = nextStatus !== String(lead.status_lead || '').toLowerCase();
    const changedAppointmentId = nextAppointmentId !== parsePositiveInt(lead.call_outcome_appointment_id);
    if (!changedStatus && !changedAppointmentId) {
        return lead;
    }

    await lead.update({
        status_lead: nextStatus,
        call_outcome_appointment_id: nextAppointmentId,
    });
    return lead;
}

async function attachFlowSummaryToCitas(citas) {
    const list = Array.isArray(citas) ? citas : (citas ? [citas] : []);
    if (!list.length) return citas;

    const citaIds = list
        .map((cita) => Number(cita?.id_cita))
        .filter((id) => Number.isFinite(id) && id > 0);
    if (!citaIds.length) return citas;

    const v2Promise = FlowExecutionV2.findAll({
        where: {
            trigger_entity_type: 'appointment',
            trigger_entity_id: {
                [db.Sequelize.Op.in]: citaIds
            }
        },
        include: [
            {
                model: AutomationFlowTemplateV2,
                as: 'templateVersion',
                attributes: ['id', 'version', 'name', 'nodes'],
                required: false,
            },
        ],
        order: [['updated_at', 'DESC']],
        limit: Math.max(50, citaIds.length * 3),
    });

    const v2Rows = await v2Promise;
    const byCitaIdV2 = new Map();
    for (const row of v2Rows) {
        const citaId = Number(row.trigger_entity_id);
        if (!Number.isFinite(citaId) || citaId <= 0) continue;
        if (!byCitaIdV2.has(citaId)) {
            byCitaIdV2.set(citaId, row);
            continue;
        }
        const current = byCitaIdV2.get(citaId);
        const currentIsActive = ['running', 'waiting', 'paused'].includes(String(current?.status || '').toLowerCase());
        const rowIsActive = ['running', 'waiting', 'paused'].includes(String(row?.status || '').toLowerCase());
        if (!currentIsActive && rowIsActive) {
            byCitaIdV2.set(citaId, row);
        }
    }

    list.forEach((cita) => {
        const key = Number(cita?.id_cita);
        const flowV2 = byCitaIdV2.get(key) || null;
        const summary = flowV2 ? mapFlowSummaryV2(flowV2) : null;
        if (typeof cita?.setDataValue === 'function') {
            cita.setDataValue('appointment_flow', summary);
        } else if (cita && typeof cita === 'object') {
            cita.appointment_flow = summary;
        }
    });

    return citas;
}

async function getUnreadCountForConversation(conversationId, userId) {
    if (!Message || !conversationId) return 0;

    const lastOutbound = await Message.findOne({
        where: {
            conversation_id: conversationId,
            direction: 'outbound',
            message_type: { [Op.ne]: 'event' },
        },
        attributes: ['createdAt'],
        order: [['createdAt', 'DESC']],
        raw: true,
    });

    const where = { conversation_id: conversationId, direction: 'inbound' };
    if (lastOutbound?.createdAt) {
        where.createdAt = { [Op.gt]: lastOutbound.createdAt };
    }
    return Message.count({ where });
}

async function attachUnreadCountsToCitas(citas, userId) {
    const list = Array.isArray(citas) ? citas : (citas ? [citas] : []);
    if (!list.length || !Conversation || !Message) return citas;

    await Promise.all(list.map(async (cita) => {
        try {
            const plain = typeof cita?.toJSON === 'function' ? cita.toJSON() : cita;
            if (!plain?.clinica_id || !plain?.paciente_id) {
                return;
            }

            const conv = await findCanonicalWhatsappConversation({
                clinicId: plain.clinica_id,
                contactId: plain?.paciente?.telefono_movil || null,
                patientId: plain.paciente_id,
                leadId: plain.lead_intake_id || null,
                createIfMissing: false,
            });

            const unreadCount = conv ? await getUnreadCountForConversation(conv.id, userId) : 0;
            if (typeof cita?.setDataValue === 'function') {
                cita.setDataValue('conversation_id', conv?.id || null);
                cita.setDataValue('unread_count', unreadCount);
            } else {
                cita.conversation_id = conv?.id || null;
                cita.unread_count = unreadCount;
            }
        } catch (err) {
            if (typeof cita?.setDataValue === 'function') {
                cita.setDataValue('unread_count', 0);
            } else if (cita) {
                cita.unread_count = 0;
            }
        }
    }));

    return citas;
}

function setCitaDataValue(cita, key, value) {
    if (typeof cita?.setDataValue === 'function') {
        cita.setDataValue(key, value);
        return;
    }
    if (cita && typeof cita === 'object') {
        cita[key] = value;
    }
}

function plainCita(cita) {
    return typeof cita?.toJSON === 'function' ? cita.toJSON() : cita;
}

function scoreCalendarConversation(conversation, citaLike, phoneCandidatesByPatient) {
    let score = 0;
    if (Number(conversation.patient_id) === Number(citaLike.paciente_id)) score += 100;
    if (citaLike.lead_intake_id && Number(conversation.lead_id) === Number(citaLike.lead_intake_id)) score += 50;
    const phoneCandidates = phoneCandidatesByPatient.get(Number(citaLike.paciente_id)) || new Set();
    if (conversation.contact_id && phoneCandidates.has(String(conversation.contact_id))) score += 30;
    if (conversation.last_inbound_at) score += 8;
    if (conversation.last_message_at) score += 4;
    return score;
}

async function attachCalendarUnreadCountsToCitas(citas, userId) {
    const list = Array.isArray(citas) ? citas : (citas ? [citas] : []);
    if (!list.length || !Conversation || !Message) return citas;

    const plainList = list.map(plainCita).filter(Boolean);
    const patientIds = Array.from(new Set(
        plainList
            .map((cita) => Number(cita?.paciente_id))
            .filter((id) => Number.isInteger(id) && id > 0)
    ));
    if (!patientIds.length) return citas;

    const leadIds = Array.from(new Set(
        plainList
            .map((cita) => Number(cita?.lead_intake_id))
            .filter((id) => Number.isInteger(id) && id > 0)
    ));

    const phoneCandidatesByPatient = new Map();
    const allPhoneCandidates = new Set();
    plainList.forEach((cita) => {
        const patientId = Number(cita?.paciente_id);
        const candidates = getPhoneLookupCandidates(cita?.paciente?.telefono_movil || null);
        if (!Number.isInteger(patientId) || patientId <= 0 || !candidates.length) return;
        const bucket = phoneCandidatesByPatient.get(patientId) || new Set();
        candidates.forEach((candidate) => {
            const value = String(candidate || '').trim();
            if (!value) return;
            bucket.add(value);
            allPhoneCandidates.add(value);
        });
        phoneCandidatesByPatient.set(patientId, bucket);
    });

    const orConditions = [
        { patient_id: { [Op.in]: patientIds } },
    ];
    if (leadIds.length) {
        orConditions.push({ lead_id: { [Op.in]: leadIds } });
    }
    if (allPhoneCandidates.size) {
        orConditions.push({ contact_id: { [Op.in]: Array.from(allPhoneCandidates) } });
    }

    const conversations = await Conversation.findAll({
        where: {
            clinic_id: { [Op.in]: Array.from(new Set(plainList.map((cita) => Number(cita?.clinica_id)).filter((id) => Number.isInteger(id) && id > 0))) },
            channel: 'whatsapp',
            [Op.or]: orConditions,
        },
        attributes: ['id', 'clinic_id', 'contact_id', 'patient_id', 'lead_id', 'last_message_at', 'last_inbound_at', 'unread_count', 'updatedAt'],
        raw: true,
    });

    if (!conversations.length) {
        list.forEach((cita) => {
            setCitaDataValue(cita, 'conversation_id', null);
            setCitaDataValue(cita, 'unread_count', 0);
        });
        return citas;
    }

    const conversationIds = conversations
        .map((conversation) => Number(conversation.id))
        .filter((id) => Number.isInteger(id) && id > 0);

    const pendingReplyByConversation = new Map();
    if (conversationIds.length) {
        const rows = await db.sequelize.query(`
            SELECT
                base.conversation_id AS conversation_id,
                COUNT(m.id) AS unread_count
            FROM (
                SELECT id AS conversation_id
                FROM Conversations
                WHERE id IN (:conversationIds)
            ) base
            LEFT JOIN (
                SELECT conversation_id, MAX(createdAt) AS last_outbound_at
                FROM Messages
                WHERE conversation_id IN (:conversationIds)
                  AND direction = 'outbound'
                  AND message_type <> 'event'
                GROUP BY conversation_id
            ) last_outbound
              ON last_outbound.conversation_id = base.conversation_id
            LEFT JOIN Messages m
              ON m.conversation_id = base.conversation_id
             AND m.direction = 'inbound'
             AND (
                last_outbound.last_outbound_at IS NULL
                OR m.createdAt > last_outbound.last_outbound_at
             )
            GROUP BY base.conversation_id
        `, {
            replacements: { conversationIds },
            type: db.Sequelize.QueryTypes.SELECT,
        });
        rows.forEach((row) => {
            pendingReplyByConversation.set(Number(row.conversation_id), Number(row.unread_count || 0));
        });
    } else {
        conversations.forEach((conversation) => {
            pendingReplyByConversation.set(Number(conversation.id), Number(conversation.unread_count || 0));
        });
    }

    list.forEach((cita) => {
        const plain = plainCita(cita);
        let best = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        conversations.forEach((conversation) => {
            if (Number(conversation.clinic_id) !== Number(plain?.clinica_id)) return;
            const score = scoreCalendarConversation(conversation, plain, phoneCandidatesByPatient);
            if (score > bestScore) {
                best = conversation;
                bestScore = score;
            }
        });
        if (!best || bestScore <= 0) {
            setCitaDataValue(cita, 'conversation_id', null);
            setCitaDataValue(cita, 'unread_count', 0);
            return;
        }
        setCitaDataValue(cita, 'conversation_id', best.id);
        setCitaDataValue(cita, 'unread_count', pendingReplyByConversation.get(Number(best.id)) || 0);
    });

    return citas;
}

function mapCalendarCitaRow(cita) {
    const plain = plainCita(cita);
    if (!plain) return null;
    return {
        id_cita: plain.id_cita,
        clinica_id: plain.clinica_id,
        paciente_id: plain.paciente_id,
        lead_intake_id: plain.lead_intake_id,
        doctor_id: plain.doctor_id,
        instalacion_id: plain.instalacion_id,
        tratamiento_id: plain.tratamiento_id,
        titulo: plain.titulo,
        nota: plain.nota,
        motivo: plain.motivo,
        tipo_cita: plain.tipo_cita,
        estado: plain.estado,
        inicio: plain.inicio,
        fin: plain.fin,
        conversation_id: plain.conversation_id || null,
        unread_count: Number(plain.unread_count || 0) || 0,
        paciente: plain.paciente ? {
            id_paciente: plain.paciente.id_paciente,
            public_id: plain.paciente.public_id,
            nombre: plain.paciente.nombre,
            apellidos: plain.paciente.apellidos,
            telefono_movil: plain.paciente.telefono_movil,
            foto: plain.paciente.foto,
        } : null,
        instalacion: plain.instalacion ? {
            id: plain.instalacion.id,
            nombre: plain.instalacion.nombre,
            color: plain.instalacion.color,
        } : null,
        tratamiento: plain.tratamiento ? {
            id_tratamiento: plain.tratamiento.id_tratamiento,
            nombre: plain.tratamiento.nombre,
            duracion_min: plain.tratamiento.duracion_min,
            color: plain.tratamiento.color,
        } : null,
        doctor: plain.doctor ? {
            id_usuario: plain.doctor.id_usuario,
            nombre: plain.doctor.nombre,
            apellidos: plain.doctor.apellidos,
            avatar: plain.doctor.avatar,
        } : null,
    };
}
const { buildHorarioExceptionMap, expandHorariosForDate } = require('../lib/personal-schedule-recurring');
const DEFAULT_TIMEZONE = 'Europe/Madrid';


/**
 * Helper: asegurar vínculo paciente-clínica sin romper por duplicados
 */
async function ensurePacienteClinica({ paciente_id, clinica_id, es_principal }) {
    try {
        const [vinculo] = await db.PacienteClinica.findOrCreate({
            where: { paciente_id, clinica_id },
            defaults: { es_principal }
        });
        return vinculo;
    } catch (err) {
        if (err && err.name === 'SequelizeUniqueConstraintError') {
            return db.PacienteClinica.findOne({ where: { paciente_id, clinica_id } });
        }
        throw err;
    }
}

/**
 * Helper: encontrar o crear paciente por teléfono/email en una clínica
 */
async function findOrCreatePaciente({ clinica_id, nombre, apellidos, telefono, email, id_paciente }) {
    if (!telefono && !email && !id_paciente) {
        throw new Error('Se requiere teléfono o email para crear el paciente');
    }

    // Si viene un id_paciente, vincularlo si hace falta y devolverlo
    if (id_paciente) {
        const existente = await findPacienteByIdentifier(id_paciente);
        if (!existente) {
            throw new Error('Paciente no encontrado');
        }
        const yaVinculado = existente.clinica_id === clinica_id ||
            (existente.clinicasVinculadas || []).some(vc => vc.clinica_id === clinica_id);
        if (!yaVinculado) {
            await ensurePacienteClinica({
                paciente_id: existente.id_paciente,
                clinica_id,
                es_principal: false
            });
        }
        return existente;
    }

    const whereContacto = [];
    const normalizedPhone = normalizePhoneDigits(telefono);
    const localPhone = normalizedPhone && normalizedPhone.length > 9 ? normalizedPhone.slice(-9) : normalizedPhone;

    if (telefono) {
        whereContacto.push({ telefono_movil: telefono });
    }
    if (normalizedPhone) {
        whereContacto.push({ telefono_movil: normalizedPhone });
        whereContacto.push({ telefono_movil: { [Op.like]: `%${normalizedPhone}` } });
    }
    if (localPhone) {
        whereContacto.push({ telefono_movil: localPhone });
        whereContacto.push({ telefono_movil: { [Op.like]: `%${localPhone}` } });
    }
    if (email) {
        whereContacto.push({ email });
    }

    const candidatos = await Paciente.findAll({
        where: { [Op.or]: whereContacto },
        include: [
            {
                model: db.PacienteClinica,
                as: 'clinicasVinculadas',
                required: false
            }
        ],
        limit: 20
    });
    const paciente = candidatos.find((row) => {
        const candidatePhone = normalizePhone(row.telefono_movil);
        const phoneMatches = !normalizedPhone || !candidatePhone
            ? true
            : candidatePhone === normalizedPhone || candidatePhone.endsWith(localPhone || normalizedPhone);
        if (!phoneMatches && email && row.email && String(row.email).trim().toLowerCase() !== String(email).trim().toLowerCase()) {
            return false;
        }
        return (
        row.clinica_id === clinica_id ||
        (row.clinicasVinculadas || []).some((vc) => vc.clinica_id === clinica_id)
        );
    }) || null;
    if (paciente) {
        // Asegurar vínculo explícito
        const yaVinculado = (paciente.clinicasVinculadas || []).some(vc => vc.clinica_id === clinica_id);
        if (!yaVinculado) {
            await ensurePacienteClinica({
                paciente_id: paciente.id_paciente,
                clinica_id,
                es_principal: false
            });
        }
        return paciente;
    }

    const nuevoPaciente = await Paciente.create({
        public_id: await generateUniquePacientePublicId(),
        nombre: normalizeHumanName(nombre || 'Sin nombre') || 'Sin nombre',
        apellidos: normalizeHumanName(apellidos || ''),
        telefono_movil: normalizedPhone || telefono || '',
        email: email || null,
        clinica_id: clinica_id
    });

    await ensurePacienteClinica({
        paciente_id: nuevoPaciente.id_paciente,
        clinica_id,
        es_principal: true
    });

    return nuevoPaciente;
}

const parseBool = (v) => v === true || v === 'true' || v === '1';
const overlap = (startA, endA, startB, endB) => startA < endB && startB < endA;
const dayIndexFromLocalDate = (fechaLocal) => new Date(`${fechaLocal}T12:00:00Z`).getUTCDay();

const parseClinicConfig = (value) => {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (err) {
            return null;
        }
    }
    return null;
};

const isValidTimeZone = (value) => {
    if (!value || typeof value !== 'string') return false;
    try {
        Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
        return true;
    } catch (err) {
        return false;
    }
};

const resolveClinicTimezone = (clinica) => {
    const cfg = parseClinicConfig(clinica && clinica.configuracion);
    const candidates = [
        cfg && (cfg.timezone || cfg.timeZone || cfg.tz),
        clinica && (clinica.timezone || clinica.time_zone || clinica.tz)
    ];

    for (const candidate of candidates) {
        if (isValidTimeZone(candidate)) return candidate;
    }
    return DEFAULT_TIMEZONE;
};

const formatPartsInTimeZone = (date, timeZone) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).formatToParts(date);

    const bag = {};
    parts.forEach((p) => {
        if (p.type !== 'literal') bag[p.type] = p.value;
    });

    return {
        year: Number(bag.year),
        month: Number(bag.month),
        day: Number(bag.day),
        hour: Number(bag.hour),
        minute: Number(bag.minute),
        second: Number(bag.second)
    };
};

const offsetMinutesForTimeZone = (date, timeZone) => {
    const p = formatPartsInTimeZone(date, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUtc - date.getTime()) / 60000);
};

const normalizeHms = (value, fallback = '00:00:00') => {
    const raw = String(value || fallback).trim();
    const m = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    return `${m[1]}:${m[2]}:${m[3] || '00'}`;
};

const localDateTimeToUtc = (fechaLocal, timeValue, timeZone) => {
    if (!fechaLocal || typeof fechaLocal !== 'string') return null;
    const d = fechaLocal.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!d) return null;

    const hms = normalizeHms(timeValue);
    if (!hms) return null;
    const t = hms.match(/^(\d{2}):(\d{2}):(\d{2})$/);
    if (!t) return null;

    const year = Number(d[1]);
    const month = Number(d[2]);
    const day = Number(d[3]);
    const hour = Number(t[1]);
    const minute = Number(t[2]);
    const second = Number(t[3]);

    const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    let ts = naiveUtc;
    for (let i = 0; i < 2; i++) {
        const offsetMin = offsetMinutesForTimeZone(new Date(ts), timeZone);
        ts = naiveUtc - offsetMin * 60000;
    }
    return new Date(ts);
};

const formatDateLocal = (date, timeZone) => {
    const p = formatPartsInTimeZone(date, timeZone);
    const pad = (n) => String(n).padStart(2, '0');
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

const buildWindowsFromHorarios = (horarios, dow, fechaIso, timeZone) => {
    const exceptionMap = buildHorarioExceptionMap(
        (horarios || []).flatMap((h) => Array.isArray(h?.excepciones) ? h.excepciones : [])
    );
    return expandHorariosForDate(horarios || [], fechaIso, exceptionMap)
        .filter((h) => h.dia_semana === dow && h.activo)
        .map((h) => ({
            start: localDateTimeToUtc(fechaIso, h.hora_inicio, timeZone),
            end: localDateTimeToUtc(fechaIso, h.hora_fin, timeZone)
        }))
        .filter((w) => w.start && w.end && Number.isFinite(w.start.getTime()) && Number.isFinite(w.end.getTime()) && w.start < w.end);
};

const buildBlockWindowsFromBloqueos = (bloqueos, fechaIso, timeZone) => {
    const targetDow = dayIndexFromLocalDate(fechaIso);
    return (bloqueos || []).flatMap((bloqueo) => {
        const exceptions = Array.isArray(bloqueo?.excepciones) ? bloqueo.excepciones : [];
        const canceled = exceptions.some((row) => String(row?.fecha || '') === fechaIso && row?.cancelado !== false);
        if (canceled) return [];

        const startDay = formatDateLocal(bloqueo.fecha_inicio, timeZone);
        const endDay = formatDateLocal(bloqueo.fecha_fin, timeZone);
        const startParts = formatPartsInTimeZone(bloqueo.fecha_inicio, timeZone);
        const endParts = formatPartsInTimeZone(bloqueo.fecha_fin, timeZone);
        const startHm = `${String(startParts.hour).padStart(2, '0')}:${String(startParts.minute).padStart(2, '0')}`;
        const endHm = `${String(endParts.hour).padStart(2, '0')}:${String(endParts.minute).padStart(2, '0')}`;
        const recurrente = String(bloqueo.recurrente || 'none');

        let applies = false;
        if (recurrente === 'none') {
            applies = fechaIso >= startDay && fechaIso <= endDay;
        } else if (recurrente === 'daily') {
            applies = fechaIso >= startDay;
        } else if (recurrente === 'weekly') {
            applies = fechaIso >= startDay && targetDow === dayIndexFromLocalDate(startDay);
        } else if (recurrente === 'monthly') {
            applies = fechaIso >= startDay && Number(fechaIso.slice(8, 10)) === Number(startDay.slice(8, 10));
        }
        if (!applies) return [];

        const occStartHm = recurrente === 'none'
            ? (fechaIso === startDay ? startHm : '00:00')
            : startHm;
        const occEndHm = recurrente === 'none'
            ? (fechaIso === endDay ? endHm : '23:59')
            : endHm;
        const start = localDateTimeToUtc(fechaIso, occStartHm, timeZone);
        const end = localDateTimeToUtc(fechaIso, occEndHm, timeZone);
        if (!start || !end || start >= end) return [];
        return [{ start, end }];
    });
};

const inAnyWindow = (windows, start, end) => {
    if (!Array.isArray(windows) || windows.length === 0) return false;
    return windows.some((w) => start >= w.start && end <= w.end);
};

const normalizeRecibeCitas = (value) => {
    if (typeof value === 'boolean') return value;
    const normalized = String(value || '').trim().toLowerCase();
    if (['1', 'true', 'si', 'sí', 'yes'].includes(normalized)) return true;
    if (['0', 'false', 'no'].includes(normalized)) return false;
    return false;
};

const mergeWindows = (windows) => {
    const sorted = (windows || [])
        .filter((w) => w?.start && w?.end && w.start < w.end)
        .sort((a, b) => a.start - b.start);
    if (!sorted.length) return [];

    const merged = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const curr = sorted[i];
        const last = merged[merged.length - 1];
        if (curr.start <= last.end) {
            last.end = new Date(Math.max(last.end.getTime(), curr.end.getTime()));
            continue;
        }
        merged.push({ start: curr.start, end: curr.end });
    }
    return merged;
};

const intersectWindows = (a, b) => {
    if (!a.length || !b.length) return [];
    return a
        .flatMap((w) =>
            b.map((d) => ({
                start: new Date(Math.max(w.start, d.start)),
                end: new Date(Math.min(w.end, d.end))
            }))
        )
        .filter((w) => w.start < w.end);
};

function buildDoctorAvailabilityContext({
    doctorId,
    dc,
    dow,
    fechaIso,
    clinicTimezone
}) {
    if (!doctorId) {
        return {
            docWins: [],
            dcMissing: false,
            outOfHoursMessage: 'Doctor fuera de horario'
        };
    }

    if (!dc) {
        return {
            docWins: [],
            dcMissing: true,
            outOfHoursMessage: 'Doctor no asignado a la clínica'
        };
    }

    const receiveAppointments = normalizeRecibeCitas(dc.recibe_citas);
    const clinicWins = buildWindowsFromHorarios(dc.horarios || [], dow, fechaIso, clinicTimezone);

    if (!receiveAppointments) {
        return {
            docWins: [],
            dcMissing: false,
            outOfHoursMessage: 'Profesional en modo sin citas (no aparece en agenda de citas)'
        };
    }

    const outOfHoursMessage = clinicWins.length
        ? 'Profesional fuera de su horario en esta clínica'
        : 'Profesional sin horario configurado en esta clínica';

    return {
        docWins: mergeWindows(clinicWins),
        dcMissing: false,
        outOfHoursMessage
    };
}

async function checkDisponibilidad({ clinica_id, inicio, fin, doctor_id, instalacion_id, clinicTimezone = DEFAULT_TIMEZONE }) {
    const conflicts = [];
    const start = new Date(inicio);
    const end = new Date(fin);
    const fechaIso = formatDateLocal(start, clinicTimezone);
    const dow = dayIndexFromLocalDate(fechaIso);

    if (instalacion_id) {
        const inst = await Instalacion.findByPk(instalacion_id, { include: [{ model: InstalacionHorario, as: 'horarios' }, { model: InstalacionBloqueo, as: 'bloqueos' }] });
        if (!inst || !inst.activo) conflicts.push({ type: 'not_found', message: 'Instalación no encontrada o inactiva' });
        else {
            if (inst.clinica_id !== clinica_id) conflicts.push({ type: 'not_in_clinic', message: 'Instalación fuera de la clínica' });
            const instWins = buildWindowsFromHorarios(inst.horarios || [], dow, fechaIso, clinicTimezone);
            const inRange = inAnyWindow(instWins, start, end);
            if (!inRange) conflicts.push({ type: 'out_of_hours', message: 'Instalación fuera de horario' });
            (inst.bloqueos || []).forEach(b => {
                if (overlap(start, end, b.fecha_inicio, b.fecha_fin)) conflicts.push({ type: 'blocked', message: b.motivo || 'Bloqueo instalación' });
            });
            const citasInst = await CitaPaciente.findAll({ where: { ...ACTIVE_APPOINTMENT_WHERE, instalacion_id, inicio: { [db.Sequelize.Op.lt]: end }, fin: { [db.Sequelize.Op.gt]: start } }, attributes: ['id_cita'] });
            if (citasInst.length) conflicts.push({ type: 'overlap', message: 'Instalación ocupada' });
        }
    }

    if (doctor_id) {
        const dc = await DoctorClinica.findOne({
            where: { doctor_id, clinica_id, activo: true },
            include: [{ model: DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] }]
        });
        const doctorCtx = buildDoctorAvailabilityContext({
            doctorId: doctor_id,
            dc: dc || null,
            dow,
            fechaIso,
            clinicTimezone,
        });
        if (doctorCtx.dcMissing) {
            conflicts.push({ type: 'doctor_unavailable', message: 'Doctor no asignado a la clínica' });
        } else {
            const inRange = inAnyWindow(doctorCtx.docWins, start, end);
            if (!inRange) conflicts.push({ type: 'doctor_unavailable', message: doctorCtx.outOfHoursMessage });
        }
        const bloqueos = await DoctorBloqueo.findAll({
            where: {
                doctor_id,
                [Op.or]: [
                    { recurrente: 'none', fecha_inicio: { [db.Sequelize.Op.lt]: end }, fecha_fin: { [db.Sequelize.Op.gt]: start } },
                    { recurrente: { [Op.ne]: 'none' }, fecha_inicio: { [db.Sequelize.Op.lte]: end } },
                ],
            },
            include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }],
        });
        const bloqueoWindows = buildBlockWindowsFromBloqueos(bloqueos, fechaIso, clinicTimezone);
        if (bloqueoWindows.some((w) => overlap(start, end, w.start, w.end))) {
            conflicts.push({ type: 'doctor_unavailable', message: (bloqueos[0] && bloqueos[0].motivo) || 'Bloqueo doctor' });
        }
        const citasDoc = await CitaPaciente.findAll({
            where: { ...ACTIVE_APPOINTMENT_WHERE, doctor_id, inicio: { [db.Sequelize.Op.lt]: end }, fin: { [db.Sequelize.Op.gt]: start } },
            attributes: ['id_cita', 'clinica_id']
        });
        if (citasDoc.some((c) => Number(c.clinica_id) !== Number(clinica_id))) {
            conflicts.push({ type: 'doctor_unavailable', message: 'Doctor ocupado en otra clínica' });
        }
        if (citasDoc.some((c) => Number(c.clinica_id) === Number(clinica_id))) {
            conflicts.push({ type: 'overlap', message: 'Doctor ocupado' });
        }
    }
    return conflicts;
}

/**
 * Helper: conflictos canónicos (17.6) + compatibilidad legacy para el 409 de POST /citas.
 * Fuente de verdad: `force=true` solo actúa cuando todos los conflictos son forzables.
 */
async function checkDisponibilidadCanonica({ clinica_id, inicio, fin, doctor_id, instalacion_id, ignore_cita_id = null, clinicTimezone = DEFAULT_TIMEZONE }) {
    const clinicaId = Number(clinica_id);
    const start = new Date(inicio);
    const end = new Date(fin);
    const fechaIso = formatDateLocal(start, clinicTimezone);
    const dow = dayIndexFromLocalDate(fechaIso);

    const resourceConflicts = [];
    const legacyConflicts = [];

    const addLegacy = (type, message) => legacyConflicts.push({ type, message });
    const addResource = (conflict) => resourceConflicts.push(conflict);

    // Instalación
    if (instalacion_id) {
        const inst = await Instalacion.findByPk(instalacion_id, {
            include: [
                { model: InstalacionHorario, as: 'horarios' },
                { model: InstalacionBloqueo, as: 'bloqueos' }
            ]
        });

        if (!inst || !inst.activo) {
            addLegacy('not_found', 'Instalación no encontrada o inactiva');
            addResource({
                resource_type: 'installation',
                resource_id: Number(instalacion_id),
                clinica_id: clinicaId,
                code: 'INSTALLATION_BLOCKED',
                can_force: false,
                details: { message: 'Instalación no encontrada o inactiva' }
            });
        } else if (inst.clinica_id !== clinicaId) {
            addLegacy('not_in_clinic', 'Instalación fuera de la clínica');
            addResource({
                resource_type: 'installation',
                resource_id: Number(instalacion_id),
                clinica_id: clinicaId,
                code: 'INSTALLATION_BLOCKED',
                can_force: false,
                details: { message: 'Instalación fuera de la clínica' }
            });
        } else {
            const instWins = buildWindowsFromHorarios(inst.horarios || [], dow, fechaIso, clinicTimezone);
            const inRange = inAnyWindow(instWins, start, end);
            if (!inRange) {
                addLegacy('out_of_hours', 'Instalación fuera de horario');
                addResource({
                    resource_type: 'installation',
                    resource_id: Number(instalacion_id),
                    clinica_id: clinicaId,
                    code: 'INSTALLATION_OUT_OF_HOURS',
                    can_force: false,
                    details: { message: 'Instalación fuera de horario' }
                });
            }

            (inst.bloqueos || []).forEach(b => {
                if (overlap(start, end, b.fecha_inicio, b.fecha_fin)) {
                    addLegacy('blocked', b.motivo || 'Bloqueo instalación');
                    addResource({
                        resource_type: 'installation',
                        resource_id: Number(instalacion_id),
                        clinica_id: clinicaId,
                        code: 'INSTALLATION_BLOCKED',
                        can_force: false,
                        details: { bloqueo_id: b.id, message: b.motivo || 'Bloqueo instalación' }
                    });
                }
            });

            const citasInstWhere = {
                ...ACTIVE_APPOINTMENT_WHERE,
                instalacion_id,
                inicio: { [db.Sequelize.Op.lt]: end },
                fin: { [db.Sequelize.Op.gt]: start }
            };
            if (ignore_cita_id) citasInstWhere.id_cita = { [db.Sequelize.Op.ne]: ignore_cita_id };
            const citasInst = await CitaPaciente.findAll({ where: citasInstWhere, attributes: ['id_cita'] });
            if (citasInst.length) {
                addLegacy('overlap', 'Instalación ocupada');
                addResource({
                    resource_type: 'installation',
                    resource_id: Number(instalacion_id),
                    clinica_id: clinicaId,
                    code: 'INSTALLATION_OVERLAP',
                    can_force: true,
                    details: { cita_ids: citasInst.map(c => c.id_cita), message: 'Instalación ocupada' }
                });
            }
        }
    }

    // Staff (doctor)
    if (doctor_id) {
        const dc = await DoctorClinica.findOne({
            where: { doctor_id, clinica_id: clinicaId, activo: true },
            include: [{ model: DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] }]
        });
        const doctorCtx = buildDoctorAvailabilityContext({
            doctorId: doctor_id,
            dc: dc || null,
            dow,
            fechaIso,
            clinicTimezone,
        });

        if (doctorCtx.dcMissing) {
            addLegacy('doctor_unavailable', 'Doctor no asignado a la clínica');
            addResource({
                resource_type: 'staff',
                resource_role: 'doctor',
                resource_id: Number(doctor_id),
                clinica_id: clinicaId,
                code: 'STAFF_OUT_OF_HOURS',
                can_force: false,
                details: { message: 'Doctor no asignado a la clínica' }
            });
        } else {
            const inRange = inAnyWindow(doctorCtx.docWins, start, end);
            if (!inRange) {
                addLegacy('doctor_unavailable', doctorCtx.outOfHoursMessage);
                addResource({
                    resource_type: 'staff',
                    resource_role: 'doctor',
                    resource_id: Number(doctor_id),
                    clinica_id: clinicaId,
                    code: 'STAFF_OUT_OF_HOURS',
                    can_force: false,
                    details: { message: doctorCtx.outOfHoursMessage }
                });
            }
        }

        const bloqueos = await DoctorBloqueo.findAll({
            where: {
                doctor_id,
                [Op.or]: [
                    { recurrente: 'none', fecha_inicio: { [db.Sequelize.Op.lt]: end }, fecha_fin: { [db.Sequelize.Op.gt]: start } },
                    { recurrente: { [Op.ne]: 'none' }, fecha_inicio: { [db.Sequelize.Op.lte]: end } },
                ],
            },
            include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }],
        });
        const bloqueoWindows = buildBlockWindowsFromBloqueos(bloqueos, fechaIso, clinicTimezone);
        if (bloqueoWindows.some((w) => overlap(start, end, w.start, w.end))) {
            addLegacy('doctor_unavailable', (bloqueos[0] && bloqueos[0].motivo) || 'Bloqueo doctor');
            addResource({
                resource_type: 'staff',
                resource_role: 'doctor',
                resource_id: Number(doctor_id),
                clinica_id: clinicaId,
                code: 'STAFF_BLOCKED',
                can_force: false,
                details: { bloqueo_id: bloqueos[0].id, message: (bloqueos[0] && bloqueos[0].motivo) || 'Bloqueo doctor' }
            });
        }

        const citasDocWhere = { ...ACTIVE_APPOINTMENT_WHERE, doctor_id, inicio: { [db.Sequelize.Op.lt]: end }, fin: { [db.Sequelize.Op.gt]: start } };
        if (ignore_cita_id) citasDocWhere.id_cita = { [db.Sequelize.Op.ne]: ignore_cita_id };
        const citasDoc = await CitaPaciente.findAll({ where: citasDocWhere, attributes: ['id_cita', 'clinica_id'] });
        const citasDocOtherClinics = citasDoc.filter((c) => Number(c.clinica_id) !== Number(clinicaId));
        const citasDocSameClinic = citasDoc.filter((c) => Number(c.clinica_id) === Number(clinicaId));

        if (citasDocOtherClinics.length) {
            addLegacy('doctor_unavailable', 'Doctor ocupado en otra clínica');
            addResource({
                resource_type: 'staff',
                resource_role: 'doctor',
                resource_id: Number(doctor_id),
                clinica_id: clinicaId,
                code: 'STAFF_OVERLAP',
                can_force: false,
                details: {
                    cita_ids: citasDocOtherClinics.map((c) => c.id_cita),
                    clinica_ids: Array.from(
                        new Set(
                            citasDocOtherClinics
                                .map((c) => Number(c.clinica_id))
                                .filter((id) => Number.isFinite(id))
                        )
                    ),
                    message: 'Doctor ocupado en otra clínica'
                }
            });
        }

        if (citasDocSameClinic.length) {
            addLegacy('overlap', 'Doctor ocupado');
            addResource({
                resource_type: 'staff',
                resource_role: 'doctor',
                resource_id: Number(doctor_id),
                clinica_id: clinicaId,
                code: 'STAFF_OVERLAP',
                can_force: true,
                details: { cita_ids: citasDocSameClinic.map(c => c.id_cita), message: 'Doctor ocupado' }
            });
        }
    }

    const canForce = resourceConflicts.length > 0 && resourceConflicts.every((c) => !!c.can_force);

    return { resourceConflicts, legacyConflicts, canForce };
}

/**
 * Crear cita para paciente (y lead opcional)
 */
exports.createCita = asyncHandler(async (req, res) => {
    try {
        const {
            clinica_id,
            inicio,
            fin,
            duracion_min = null,
            estado = 'pendiente',
            nota,
            motivo,
            tipo_cita = 'continuacion',
            lead_intake_id = null,
            doctor_id = null,
            instalacion_id = null,
            tratamiento_id = null,
            campana_id = null,
            force = false,
            paciente: datosPaciente
        } = req.body || {};

        if (!clinica_id || !inicio || (!fin && !duracion_min) || !datosPaciente) {
            return res.status(400).json({ message: 'clinica_id, inicio, (fin o duracion_min) y paciente son obligatorios' });
        }

        const estadoRaw = String(estado || '').trim().toLowerCase();
        if (!CITA_ESTADOS_VALIDOS.has(estadoRaw)) {
            return res.status(400).json({
                message: 'estado inválido',
                allowed: Array.from(CITA_ESTADOS_VALIDOS),
            });
        }

        // Validar clínica
        const clinica = await Clinica.findOne({ where: { id_clinica: clinica_id } });
        if (!clinica) {
            return res.status(400).json({ message: 'Clínica no encontrada' });
        }
        const clinicTimezone = resolveClinicTimezone(clinica);

        // Resolver lead si viene
        let lead = null;
        const explicitLeadIntakeId = parsePositiveInt(lead_intake_id);
        let resolvedLeadIntakeId = explicitLeadIntakeId;
        if (explicitLeadIntakeId) {
            lead = await LeadIntake.findByPk(explicitLeadIntakeId);
            if (!lead) {
                return res.status(404).json({ message: 'Lead no encontrado' });
            }
        }

        // Calcular fin si falta: prioridad cuerpo -> tratamiento -> instalación -> 30
        const inicioDate = new Date(inicio);
        let finDate = fin ? new Date(fin) : null;
        let duracionEfectiva = duracion_min ? parseInt(duracion_min, 10) : null;

        if (!duracionEfectiva && tratamiento_id) {
            const trat = await Tratamiento.findByPk(tratamiento_id, { attributes: ['duracion_min'] });
            if (trat?.duracion_min) duracionEfectiva = trat.duracion_min;
        }
        if (!duracionEfectiva && instalacion_id) {
            const inst = await Instalacion.findByPk(instalacion_id, { attributes: ['default_duracion_minutos'] });
            if (inst?.default_duracion_minutos) duracionEfectiva = inst.default_duracion_minutos;
        }
        if (!duracionEfectiva) duracionEfectiva = 30;
        if (!finDate) finDate = new Date(inicioDate.getTime() + duracionEfectiva * 60000);

        // Chequear disponibilidad si hay doctor/instalación (canónico + legacy)
        const { resourceConflicts, legacyConflicts, canForce } = await checkDisponibilidadCanonica({
            clinica_id,
            inicio: inicioDate,
            fin: finDate,
            doctor_id,
            instalacion_id,
            clinicTimezone
        });

        if (resourceConflicts.length) {
            const wantsForce = parseBool(force);

            if (!wantsForce || !canForce) {
                const firstLegacy = legacyConflicts[0];
                const reason = (firstLegacy && ['overlap', 'blocked', 'out_of_hours', 'doctor_unavailable'].includes(firstLegacy.type))
                    ? firstLegacy.type
                    : 'blocked';

                return res.status(409).json({
                    reason,
                    message: 'No hay disponibilidad para el rango solicitado.',
                    can_force: canForce,
                    resource_conflicts: resourceConflicts,
                    // Compatibilidad con el frontend legacy actual
                    conflicts: legacyConflicts
                });
            }
            // wantsForce && canForce -> seguimos
        }

        // Resolver/crear paciente
        const paciente = await findOrCreatePaciente({
            clinica_id,
            nombre: datosPaciente.nombre,
            apellidos: datosPaciente.apellidos,
            telefono: datosPaciente.telefono,
            email: datosPaciente.email,
            id_paciente: datosPaciente.id_paciente || datosPaciente.id
        });

        const shouldAutoLinkPendingCallLead = !lead
            && String(tipo_cita || '').trim().toLowerCase() !== 'continuacion';
        if (shouldAutoLinkPendingCallLead) {
            lead = await findPendingCallLeadForAppointment({
                clinica_id,
                telefono: datosPaciente.telefono || paciente?.telefono_movil || null,
            });
            resolvedLeadIntakeId = parsePositiveInt(lead?.id) || null;
        }

        // Crear cita
        const cita = await CitaPaciente.create({
            clinica_id,
            paciente_id: paciente.id_paciente,
            lead_intake_id: resolvedLeadIntakeId || null,
            doctor_id,
            instalacion_id,
            tratamiento_id,
            campana_id: campana_id || lead?.campana_id || null,
            created_by: req.userData?.userId || null,
            updated_by: req.userData?.userId || null,
            titulo: datosPaciente.titulo || null,
            nota: nota || null,
            motivo: motivo || null,
            tipo_cita,
            estado: estadoRaw,
            inicio: inicioDate,
            fin: finDate
        });

        // Disparar motor v2 de automatizaciones de cita (si el tratamiento tiene plantilla v2 asignada).
        try {
            await appointmentAutomationV2Runtime.enqueueExecutionForCita(cita, {
                event_name: 'appointment_created',
                user_id: req.userData?.userId || null,
                user_name: req.userData?.name || req.userData?.nombre || req.userData?.email || null,
                user_role: req.userData?.role || req.userData?.rol || 'admin',
            });
            await appointmentAutomationV2Runtime.syncScheduledTriggersForCita(cita, {
                user_id: req.userData?.userId || null,
                user_name: req.userData?.name || req.userData?.nombre || req.userData?.email || null,
                user_role: req.userData?.role || req.userData?.rol || 'admin',
            });
        } catch (automationErr) {
            console.error('⚠️ [createCita] Error disparando automation v2:', automationErr.message);
        }

        await ensureConsentPackageAndAutomation(cita, req, 'appointment_created');

        // Marcar lead como citado si aplica
        if (lead) {
            const leadUpdatePayload = {
                status_lead: 'citado',
                call_outcome_appointment_id: cita.id_cita,
            };
            if (lead.call_initiated && !lead.call_outcome) {
                leadUpdatePayload.call_outcome = 'citado';
                leadUpdatePayload.call_outcome_at = new Date();
                leadUpdatePayload.call_outcome_notes = lead.call_outcome_notes
                    || 'Lead vinculado automáticamente al crear una cita manual con el mismo teléfono.';
            }
            await lead.update(leadUpdatePayload);

            if (!explicitLeadIntakeId && resolvedLeadIntakeId && LeadAttributionAudit) {
                try {
                    await LeadAttributionAudit.create({
                        lead_intake_id: resolvedLeadIntakeId,
                        raw_payload: {
                            appointment_id: cita.id_cita,
                            patient_id: paciente.id_paciente,
                            matched_by: 'phone',
                            source: 'manual_appointment_auto_link',
                        },
                        attribution_steps: {
                            action: 'auto_link_manual_appointment_from_pending_call',
                            userId: req.userData?.userId || null,
                            clinic_id: clinica_id,
                        }
                    });
                } catch (auditErr) {
                    console.warn('⚠️ No se pudo registrar auditoría de auto-link de cita manual:', auditErr.message || auditErr);
                }
            }
        }

        const citaCreada = await CitaPaciente.findByPk(cita.id_cita, {
            include: [
                { model: Paciente, as: 'paciente' },
                { model: LeadIntake, as: 'lead' },
                { model: Clinica, as: 'clinica', attributes: ['id_clinica','nombre_clinica', ['grupoClinicaId', 'grupo_clinica_id']] },
                Campana ? { model: Campana, as: 'campana' } : null,
                { model: Instalacion, as: 'instalacion', required: false },
                { model: Tratamiento, as: 'tratamiento', required: false },
                db.Usuario ? { model: db.Usuario, as: 'doctor', required: false, attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar'] } : null
            ].filter(Boolean)
        });

        await attachFlowSummaryToCitas(citaCreada);
        await attachUnreadCountsToCitas(citaCreada, req.userData?.userId || null);
        await consentimientosService.attachConsentSummaryToCitas(citaCreada);
        emitAppointmentSocketEvent('appointment:created', citaCreada?.toJSON ? citaCreada.toJSON() : citaCreada);

        return res.status(201).json(citaCreada);
    } catch (err) {
        console.error('❌ [createCita] Error:', err.message, err.original?.sqlMessage || '', err);
        return res.status(500).json({
            message: 'error_creating_cita',
            detail: err.original?.sqlMessage || err.message
        });
    }
});

/**
 * Listar citas (simplificado para calendario)
 */
exports.getCitas = asyncHandler(async (req, res) => {
    const { clinica_id, startDate, endDate, paciente_id, patient_id } = req.query;

    const where = {};
    if (clinica_id) {
        where.clinica_id = clinica_id;
    }
    const pacienteIdRaw = paciente_id || patient_id;
    if (pacienteIdRaw) {
        let pacienteId = Number(pacienteIdRaw);
        if ((!Number.isFinite(pacienteId) || pacienteId <= 0) && Paciente) {
            const pacientePublicId = String(pacienteIdRaw).trim();
            const publicIds = pacientePublicId.startsWith('pat_') ? [pacientePublicId, `pac_${pacientePublicId.slice(4)}`] : [pacientePublicId];
            const paciente = await Paciente.findOne({
                where: { public_id: { [Op.in]: publicIds } },
                attributes: ['id_paciente'],
            });
            pacienteId = Number(paciente?.id_paciente);
        }
        if (!Number.isFinite(pacienteId) || pacienteId <= 0) {
            return res.status(400).json({ message: 'paciente_id inválido' });
        }
        where.paciente_id = pacienteId;
    }
    if (startDate && endDate) {
        where.inicio = { [db.Sequelize.Op.between]: [new Date(startDate), new Date(endDate)] };
    }

    const citas = await CitaPaciente.findAll({
        where,
        order: [['inicio', 'ASC']],
        include: [
            { model: Paciente, as: 'paciente' },
            { model: LeadIntake, as: 'lead' },
            { model: Clinica, as: 'clinica' },
            { model: Instalacion, as: 'instalacion', required: false },
            { model: Tratamiento, as: 'tratamiento', required: false },
            db.Usuario ? { model: db.Usuario, as: 'doctor', required: false, attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar'] } : null
        ]
        .filter(Boolean)
    });

    await attachFlowSummaryToCitas(citas);
    await attachUnreadCountsToCitas(citas, req.userData?.userId || null);
    await consentimientosService.attachConsentSummaryToCitas(citas);
    res.json(citas);
});

/**
 * Listado ligero para agenda.
 * Evita cargar detalle de flujos/consentimientos en el primer render; el drawer usa getCitaById.
 */
exports.getCitasCalendar = asyncHandler(async (req, res) => {
    const { clinica_id, startDate, endDate, paciente_id, patient_id } = req.query;

    const where = {};
    if (clinica_id) {
        where.clinica_id = clinica_id;
    }

    const pacienteIdRaw = paciente_id || patient_id;
    if (pacienteIdRaw) {
        let pacienteId = Number(pacienteIdRaw);
        if ((!Number.isFinite(pacienteId) || pacienteId <= 0) && Paciente) {
            const pacientePublicId = String(pacienteIdRaw).trim();
            const publicIds = pacientePublicId.startsWith('pat_') ? [pacientePublicId, `pac_${pacientePublicId.slice(4)}`] : [pacientePublicId];
            const paciente = await Paciente.findOne({
                where: { public_id: { [Op.in]: publicIds } },
                attributes: ['id_paciente'],
            });
            pacienteId = Number(paciente?.id_paciente);
        }
        if (!Number.isFinite(pacienteId) || pacienteId <= 0) {
            return res.status(400).json({ message: 'paciente_id inválido' });
        }
        where.paciente_id = pacienteId;
    }

    if (startDate && endDate) {
        where.inicio = { [Op.between]: [new Date(startDate), new Date(endDate)] };
    }

    const citas = await CitaPaciente.findAll({
        where,
        attributes: [
            'id_cita',
            'clinica_id',
            'paciente_id',
            'lead_intake_id',
            'doctor_id',
            'instalacion_id',
            'tratamiento_id',
            'titulo',
            'nota',
            'motivo',
            'tipo_cita',
            'estado',
            'inicio',
            'fin',
            'created_at',
            'updated_at',
        ],
        order: [['inicio', 'ASC']],
        include: [
            {
                model: Paciente,
                as: 'paciente',
                attributes: ['id_paciente', 'public_id', 'nombre', 'apellidos', 'telefono_movil', 'foto'],
            },
            {
                model: Instalacion,
                as: 'instalacion',
                required: false,
                attributes: ['id', 'nombre', 'color'],
            },
            {
                model: Tratamiento,
                as: 'tratamiento',
                required: false,
                attributes: ['id_tratamiento', 'nombre', 'duracion_min', 'color'],
            },
            db.Usuario ? {
                model: db.Usuario,
                as: 'doctor',
                required: false,
                attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar'],
            } : null,
        ].filter(Boolean),
    });

    await attachCalendarUnreadCountsToCitas(citas, req.userData?.userId || null);

    res.set('X-Agenda-Endpoint', 'calendar-lite');
    res.json(citas.map(mapCalendarCitaRow).filter(Boolean));
});

exports.getCitaById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const citaId = Number(id);

    if (!id || Number.isNaN(citaId)) {
        return res.status(400).json({ message: 'id_cita inválido' });
    }

    const cita = await CitaPaciente.findByPk(citaId, {
        include: [
            { model: Paciente, as: 'paciente' },
            { model: LeadIntake, as: 'lead' },
            { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica', ['grupoClinicaId', 'grupo_clinica_id']] },
            { model: Instalacion, as: 'instalacion', required: false },
            { model: Tratamiento, as: 'tratamiento', required: false },
            db.Usuario ? { model: db.Usuario, as: 'doctor', required: false } : null,
            Campana ? { model: Campana, as: 'campana' } : null
        ].filter(Boolean)
    });

    if (!cita) {
        return res.status(404).json({ message: 'cita_not_found' });
    }

    await attachFlowSummaryToCitas(cita);
    await attachUnreadCountsToCitas(cita, req.userData?.userId || null);
    await consentimientosService.attachConsentSummaryToCitas(cita);

    let conversation_id = null;
    try {
        if (db.Conversation && cita.paciente_id && cita.clinica_id) {
            const conv = await findCanonicalWhatsappConversation({
                clinicId: cita.clinica_id,
                contactId: cita?.paciente?.telefono_movil || null,
                patientId: cita.paciente_id,
                leadId: cita.lead_intake_id || null,
                createIfMissing: false,
            });
            conversation_id = conv ? conv.id : null;
        }
    } catch (e) {
        conversation_id = null;
    }

    return res.json({
        ...cita.toJSON(),
        conversation_id,
    });
});

exports.updateCitaNota = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const citaId = Number(id);
    if (!Number.isFinite(citaId) || citaId <= 0) {
        return res.status(400).json({ message: 'id inválido' });
    }

    const cita = await CitaPaciente.findByPk(citaId);
    if (!cita) {
        return res.status(404).json({ message: 'Cita no encontrada' });
    }

    cita.nota = req.body?.nota == null ? null : String(req.body.nota).trim() || null;
    cita.updated_by = req.userData?.userId || null;
    await cita.save();

    const citaActualizada = await CitaPaciente.findByPk(citaId, {
        include: [
            { model: Paciente, as: 'paciente' },
            { model: LeadIntake, as: 'lead' },
            { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica', ['grupoClinicaId', 'grupo_clinica_id']] },
            { model: Instalacion, as: 'instalacion', required: false },
            { model: Tratamiento, as: 'tratamiento', required: false },
            db.Usuario ? { model: db.Usuario, as: 'doctor', required: false } : null,
            Campana ? { model: Campana, as: 'campana' } : null
        ].filter(Boolean)
    });

    await attachFlowSummaryToCitas(citaActualizada);
    await attachUnreadCountsToCitas(citaActualizada, req.userData?.userId || null);
    await consentimientosService.attachConsentSummaryToCitas(citaActualizada);
    emitAppointmentSocketEvent('appointment:updated', citaActualizada?.toJSON ? citaActualizada.toJSON() : citaActualizada);
    return res.json(citaActualizada);
});

/**
 * Obtener la próxima cita de un paciente en una clínica
 */
exports.getNextCita = asyncHandler(async (req, res) => {
    const { clinica_id, paciente_id } = req.query;
    const clinicaId = Number(clinica_id);
    const pacienteId = Number(paciente_id);

    if (!clinica_id || !paciente_id || Number.isNaN(clinicaId) || Number.isNaN(pacienteId)) {
        return res.status(400).json({ message: 'clinica_id y paciente_id son obligatorios' });
    }

    const now = new Date();
    const where = {
        clinica_id: clinicaId,
        paciente_id: pacienteId,
        inicio: { [Op.gte]: now }
    };

    const cita = await CitaPaciente.findOne({
        where,
        order: [['inicio', 'ASC']],
        include: [
            { model: Paciente, as: 'paciente' },
            { model: LeadIntake, as: 'lead' },
            { model: Clinica, as: 'clinica' },
            { model: Instalacion, as: 'instalacion', required: false },
            { model: Tratamiento, as: 'tratamiento', required: false },
            db.Usuario ? { model: db.Usuario, as: 'doctor', required: false, attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar'] } : null
        ].filter(Boolean)
    });

    await attachFlowSummaryToCitas(cita);
    return res.json(cita || null);
});

/**
 * Actualizar estado de una cita y sincronizar su flujo asociado.
 */
exports.updateCitaEstado = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const citaId = Number(id);
    if (!Number.isFinite(citaId) || citaId <= 0) {
        return res.status(400).json({ message: 'id inválido' });
    }

    const estadoRaw = String(req.body?.estado || '').trim().toLowerCase();
    if (!CITA_ESTADOS_VALIDOS.has(estadoRaw)) {
        return res.status(400).json({
            message: 'estado inválido',
            allowed: Array.from(CITA_ESTADOS_VALIDOS)
        });
    }

    const cita = await CitaPaciente.findByPk(citaId);
    if (!cita) {
        return res.status(404).json({ message: 'Cita no encontrada' });
    }

    cita.estado = estadoRaw;
    cita.updated_by = req.userData?.userId || null;
    await cita.save();

    await syncLeadStatusFromAppointments(cita.lead_intake_id);

    try {
        const automationEvent = mapEstadoToAutomationV2Event(estadoRaw);
        if (CITA_ESTADOS_TERMINALES_AUTOMATION.has(estadoRaw)) {
            await appointmentAutomationV2Runtime.cancelActiveExecutionsForCita(cita, {
                reason: `appointment_status_${estadoRaw}_cancelled_active_flow`,
                exclude_trigger_types: automationEvent ? [automationEvent] : [],
            });
        }
        if (CITA_ESTADOS_RESUELVEN_NOTIFICACIONES.has(estadoRaw)) {
            await appointmentNotificationCleanup.markAutomationNotificationsReadForAppointment(cita.id_cita, {
                reason: `appointment_status_${estadoRaw}`,
            });
        }
        if (automationEvent) {
            await appointmentAutomationV2Runtime.enqueueExecutionForCita(cita, {
                event_name: automationEvent,
                user_id: req.userData?.userId || null,
                user_name: req.userData?.name || req.userData?.nombre || req.userData?.email || null,
                user_role: req.userData?.role || req.userData?.rol || 'admin',
            });
        }
        await appointmentAutomationV2Runtime.syncScheduledTriggersForCita(cita, {
            user_id: req.userData?.userId || null,
            user_name: req.userData?.name || req.userData?.nombre || req.userData?.email || null,
            user_role: req.userData?.role || req.userData?.rol || 'admin',
        });
    } catch (automationErr) {
        console.error('⚠️ [updateCitaEstado] Error disparando automation v2:', automationErr.message);
    }

    const citaActualizada = await CitaPaciente.findByPk(citaId, {
        include: [
            { model: Paciente, as: 'paciente' },
            { model: LeadIntake, as: 'lead' },
            { model: Clinica, as: 'clinica' },
            { model: Instalacion, as: 'instalacion', required: false },
            { model: Tratamiento, as: 'tratamiento', required: false },
            db.Usuario ? { model: db.Usuario, as: 'doctor', required: false, attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar'] } : null
        ].filter(Boolean)
    });

    await attachFlowSummaryToCitas(citaActualizada);
    await attachUnreadCountsToCitas(citaActualizada, req.userData?.userId || null);
    await consentimientosService.attachConsentSummaryToCitas(citaActualizada);
    emitAppointmentSocketEvent('appointment:updated', citaActualizada?.toJSON ? citaActualizada.toJSON() : citaActualizada);
    return res.json(citaActualizada);
});

/**
 * Eliminar una cita ya cancelada de la agenda.
 */
exports.deleteCita = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const citaId = Number(id);
    if (!Number.isFinite(citaId) || citaId <= 0) {
        return res.status(400).json({ message: 'id inválido' });
    }

    const cita = await CitaPaciente.findByPk(citaId);
    if (!cita) {
        return res.status(404).json({ message: 'Cita no encontrada' });
    }

    if (String(cita.estado || '').trim().toLowerCase() !== 'cancelada') {
        return res.status(409).json({ message: 'Solo se pueden eliminar citas canceladas' });
    }

    const deletedPayload = cita.toJSON ? cita.toJSON() : { ...cita };

    try {
        await appointmentAutomationV2Runtime.cancelActiveExecutionsForCita(cita, {
            reason: 'appointment_deleted_cancelled_active_flow',
        });
        await appointmentNotificationCleanup.markAutomationNotificationsReadForAppointment(cita.id_cita, {
            reason: 'appointment_deleted',
        });
    } catch (automationErr) {
        console.error('⚠️ [deleteCita] Error cerrando automation v2:', automationErr.message);
    }

    await db.sequelize.transaction(async (transaction) => {
        if (db.ConsentSignaturePackage) {
            await db.ConsentSignaturePackage.update(
                { cita_id: null },
                { where: { cita_id: citaId }, transaction }
            );
        }
        if (db.PatientConsentDocument) {
            await db.PatientConsentDocument.update(
                { cita_id: null },
                { where: { cita_id: citaId }, transaction }
            );
        }
        await CitaPaciente.destroy({ where: { id_cita: citaId }, transaction });
    });

    await syncLeadStatusFromAppointments(cita.lead_intake_id);
    emitAppointmentSocketEvent('appointment:deleted', deletedPayload);
    return res.json({ success: true, id_cita: citaId });
});

/**
 * Reagendar una cita (inicio/fin) y sincronizar su flujo asociado.
 */
exports.reagendarCita = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const citaId = Number(id);
    if (!Number.isFinite(citaId) || citaId <= 0) {
        return res.status(400).json({ message: 'id inválido' });
    }

    const cita = await CitaPaciente.findByPk(citaId);
    if (!cita) {
        return res.status(404).json({ message: 'Cita no encontrada' });
    }

    const inicio = req.body?.inicio ? new Date(req.body.inicio) : null;
    const fin = req.body?.fin ? new Date(req.body.fin) : null;
    if (!inicio || !fin || !Number.isFinite(inicio.getTime()) || !Number.isFinite(fin.getTime()) || fin <= inicio) {
        return res.status(400).json({ message: 'inicio/fin inválidos' });
    }

    const nextDoctorIdRaw = req.body?.doctor_id;
    const nextInstalacionIdRaw = req.body?.instalacion_id;
    const nextDoctorId = nextDoctorIdRaw !== undefined && nextDoctorIdRaw !== null && String(nextDoctorIdRaw).trim() !== ''
        ? Number(nextDoctorIdRaw)
        : cita.doctor_id;
    const nextInstalacionId = nextInstalacionIdRaw !== undefined && nextInstalacionIdRaw !== null && String(nextInstalacionIdRaw).trim() !== ''
        ? Number(nextInstalacionIdRaw)
        : cita.instalacion_id;

    if (nextDoctorIdRaw !== undefined && (!Number.isFinite(nextDoctorId) || nextDoctorId <= 0)) {
        return res.status(400).json({ message: 'doctor_id inválido' });
    }
    if (nextInstalacionIdRaw !== undefined && (!Number.isFinite(nextInstalacionId) || nextInstalacionId <= 0)) {
        return res.status(400).json({ message: 'instalacion_id inválido' });
    }

    const { resourceConflicts, legacyConflicts, canForce } = await checkDisponibilidadCanonica({
        clinica_id: cita.clinica_id,
        inicio,
        fin,
        doctor_id: nextDoctorId,
        instalacion_id: nextInstalacionId,
        ignore_cita_id: cita.id_cita
    });

    const wantsForce = parseBool(req.body?.force);
    if (resourceConflicts.length && (!wantsForce || !canForce)) {
        const firstLegacy = legacyConflicts[0];
        const reason = (firstLegacy && ['overlap', 'blocked', 'out_of_hours', 'doctor_unavailable'].includes(firstLegacy.type))
            ? firstLegacy.type
            : 'blocked';
        return res.status(409).json({
            reason,
            message: 'No hay disponibilidad para el rango solicitado.',
            can_force: canForce,
            resource_conflicts: resourceConflicts,
            conflicts: legacyConflicts
        });
    }

    cita.inicio = inicio;
    cita.fin = fin;
    if (nextDoctorIdRaw !== undefined) {
        cita.doctor_id = nextDoctorId;
    }
    if (nextInstalacionIdRaw !== undefined) {
        cita.instalacion_id = nextInstalacionId;
    }
    const estadoRaw = String(req.body?.estado || '').trim().toLowerCase();
    if (estadoRaw) {
        if (!CITA_ESTADOS_VALIDOS.has(estadoRaw)) {
            return res.status(400).json({
                message: 'estado inválido',
                allowed: Array.from(CITA_ESTADOS_VALIDOS),
            });
        }
        cita.estado = estadoRaw;
    } else {
        cita.estado = 'reprogramada';
    }
    cita.updated_by = req.userData?.userId || null;
    await cita.save();

    await syncLeadStatusFromAppointments(cita.lead_intake_id);

    try {
        await appointmentAutomationV2Runtime.cancelActiveExecutionsForCita(cita, {
            reason: 'appointment_rescheduled_cancelled_previous_active_flow',
            exclude_trigger_types: ['appointment_rescheduled'],
        });
        await appointmentNotificationCleanup.markAutomationNotificationsReadForAppointment(cita.id_cita, {
            reason: 'appointment_rescheduled',
        });
        await appointmentAutomationV2Runtime.enqueueExecutionForCita(cita, {
            event_name: 'appointment_rescheduled',
            user_id: req.userData?.userId || null,
            user_name: req.userData?.name || req.userData?.nombre || req.userData?.email || null,
            user_role: req.userData?.role || req.userData?.rol || 'admin',
        });
        await appointmentAutomationV2Runtime.syncScheduledTriggersForCita(cita, {
            user_id: req.userData?.userId || null,
            user_name: req.userData?.name || req.userData?.nombre || req.userData?.email || null,
            user_role: req.userData?.role || req.userData?.rol || 'admin',
        });
    } catch (automationErr) {
        console.error('⚠️ [reagendarCita] Error disparando automation v2:', automationErr.message);
    }

    await ensureConsentPackageAndAutomation(cita, req, 'appointment_rescheduled');

    const citaActualizada = await CitaPaciente.findByPk(citaId, {
        include: [
            { model: Paciente, as: 'paciente' },
            { model: LeadIntake, as: 'lead' },
            { model: Clinica, as: 'clinica' },
            { model: Instalacion, as: 'instalacion', required: false },
            { model: Tratamiento, as: 'tratamiento', required: false },
            db.Usuario ? { model: db.Usuario, as: 'doctor', required: false, attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar'] } : null
        ]
        .filter(Boolean)
    });

    await attachFlowSummaryToCitas(citaActualizada);
    await attachUnreadCountsToCitas(citaActualizada, req.userData?.userId || null);
    await consentimientosService.attachConsentSummaryToCitas(citaActualizada);
    emitAppointmentSocketEvent('appointment:updated', citaActualizada?.toJSON ? citaActualizada.toJSON() : citaActualizada);
    return res.json(citaActualizada);
});
