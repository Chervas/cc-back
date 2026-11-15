'use strict';

// Read projection only. An execution/job is never evidence that a patient
// received a message. Relations are explicit IDs, not phone/time heuristics.
const J = (alias, path) => `JSON_UNQUOTE(JSON_EXTRACT(${alias},'${path}'))`;
const windowOf = alias => `CASE WHEN LOCATE(':schedule:',${alias}.idempotency_key)>0 THEN SUBSTRING(${alias}.idempotency_key,LOCATE(':schedule:',${alias}.idempotency_key)+1) END`;
const parseInstant = sql => `STR_TO_DATE(REPLACE(REPLACE(${sql},'T',' '),'Z',''),'%Y-%m-%d %H:%i:%s.%f')`;
const templateScope = alias => `(${alias}.clinic_id= :clinic_id OR ${alias}.group_id IN (SELECT grupoClinicaId FROM Clinicas WHERE id_clinica= :clinic_id)
  OR ${alias}.is_system=1 OR (${alias}.clinic_id IS NULL AND ${alias}.group_id IS NULL AND ${alias}.created_by= :actor_id))`;

const rawColumns='id source_kind appointment_id patient_id scheduled_at created_at stage template_name template_version template_public_id template_clinic_id template_group_id template_is_system template_created_by job_id communication_id execution_id message_id conversation_id message_status sent_at job_status execution_status communication_status superseded runtime_namespace native_status execution_wait_until skipped skip_reason original_start'.split(' ');

function buildProjection({ native = false, attention = false, claims = false, sequence = false, appointmentMetadata = false } = {}) {
  const nativeCte = native ? `
    SELECT n.id,n.owner_appointment_id appointment_id,n.patient_id,n.purpose,n.status,n.template_version_id,
      n.execution_id,n.message_id,n.window_starts_at scheduled_at,n.created_at,n.cancellation_reason,
      v.communication_revision current_revision,n.communication_revision,
      t.template_key,CASE WHEN ${templateScope('t')} THEN t.name END template_name,
      CASE WHEN ${templateScope('t')} THEN t.version END template_version,t.public_id template_public_id,
      t.clinic_id template_clinic_id,t.group_id template_group_id,t.is_system template_is_system,t.created_by template_created_by
    FROM AppointmentVisitCommunications n
    JOIN scoped_appointments a ON a.id_cita=n.owner_appointment_id AND a.paciente_id=n.patient_id
    JOIN AppointmentVisits v ON v.id=n.visit_id AND v.clinic_id= :clinic_id AND v.patient_id=n.patient_id
    LEFT JOIN AutomationFlowTemplatesV2 t ON t.id=n.template_version_id
    WHERE n.clinic_id= :clinic_id AND n.purpose IN ('reminder_day_before','reminder_same_day')`
    : `SELECT CAST(NULL AS CHAR(36)) id,NULL appointment_id,NULL patient_id,NULL purpose,NULL status,NULL template_version_id,
      NULL execution_id,NULL message_id,CAST(NULL AS DATETIME) scheduled_at,CAST(NULL AS DATETIME) created_at,NULL cancellation_reason,
      NULL current_revision,NULL communication_revision,NULL template_key,NULL template_name,NULL template_version,NULL template_public_id,
      NULL template_clinic_id,NULL template_group_id,NULL template_is_system,NULL template_created_by WHERE FALSE`;
  return `WITH
  scoped_appointments AS (
    SELECT a.id_cita,a.paciente_id,a.estado,a.inicio,a.titulo,${appointmentMetadata ? 'a.import_metadata' : 'NULL'} import_metadata,p.public_id patient_public_id,
      TRIM(CONCAT_WS(' ',p.nombre,p.apellidos)) patient_name
    FROM CitasPacientes a JOIN Pacientes p ON p.id_paciente=a.paciente_id
    WHERE a.clinica_id= :clinic_id AND (:limit_appointments = 0 OR (a.inicio >= :appointment_from AND a.inicio < :appointment_to)) AND (p.clinica_id= :clinic_id OR EXISTS (
      SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id=p.id_paciente AND pc.clinica_id= :clinic_id))
  ), native_intents AS (${nativeCte}),
  executions AS (
    SELECT e.id,e.trigger_entity_id appointment_id,e.status,e.wait_until,e.created_at,e.template_version_id,
      ${parseInstant(J('e.context','$.appointment.inicio'))} original_start,
      JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(e.context,'$.outputs.*.error_message'),'$[0]')) failure_code,
      ${windowOf('e')} window_identifier,${J('e.context','$.trigger.schedule_moment')} stage,
      t.template_key,CASE WHEN ${templateScope('t')} THEN t.name END template_name,
      CASE WHEN ${templateScope('t')} THEN t.version END template_version,t.public_id template_public_id,
      t.clinic_id template_clinic_id,t.group_id template_group_id,t.is_system template_is_system,t.created_by template_created_by
    FROM FlowExecutionsV2 e JOIN scoped_appointments a ON a.id_cita=e.trigger_entity_id
    JOIN AutomationFlowTemplatesV2 t ON t.id=e.template_version_id
    WHERE e.clinic_id= :clinic_id AND e.trigger_entity_type='appointment' AND e.trigger_type='appointment_reminder_window'
  ), jobs_ranked AS (
    SELECT j.id,CAST(${J('j.payload','$.appointment_id')} AS UNSIGNED) appointment_id,j.status,j.next_run_at,j.created_at,
      ${J('j.payload','$.template_key')} template_key,${J('j.payload','$.window_identifier')} window_identifier,
      ${parseInstant(J('j.payload','$.scheduled_for'))} scheduled_at,
      ${J('j.payload','$.__runtime_namespace')} runtime_namespace,
      ${J('j.result_summary','$.skipped')} skipped,
      ${J('j.result_summary','$.reason')} skip_reason,
      ROW_NUMBER() OVER(PARTITION BY CAST(${J('j.payload','$.appointment_id')} AS UNSIGNED),
        ${J('j.payload','$.template_key')},${J('j.payload','$.window_identifier')}
        ORDER BY j.id DESC) ranking
    FROM JobRequests j JOIN scoped_appointments a ON a.id_cita=CAST(${J('j.payload','$.appointment_id')} AS UNSIGNED)
    WHERE j.type='appointment_automation_schedule_fire' AND ${J('j.payload','$.trigger_type')}='appointment_reminder_window'
  ), jobs AS (SELECT * FROM jobs_ranked WHERE ranking=1),
  templates_ranked AS (
    SELECT t.*,ROW_NUMBER() OVER(PARTITION BY t.template_key ORDER BY (t.is_active=1 AND t.published_at IS NOT NULL) DESC,t.version DESC,t.id DESC) ranking
    FROM AutomationFlowTemplatesV2 t JOIN Clinicas c ON c.id_clinica= :clinic_id
    WHERE ${templateScope('t')}
  ), valid_messages AS (
    SELECT DISTINCT m.id,m.status,m.sent_at,m.createdAt,m.conversation_id,
      CAST(${J('m.metadata','$.execution_id')} AS UNSIGNED) execution_id,c.patient_id,
      ${J('m.metadata','$.delivery_outcome')} delivery_outcome,
      ${J('m.metadata','$.node_id')} node_id
    FROM Conversations c JOIN Messages m ON m.conversation_id=c.id
    WHERE c.clinic_id= :clinic_id AND c.patient_id IS NOT NULL AND c.channel='whatsapp'
      AND m.direction='outbound' AND m.message_type<>'event'
      AND (EXISTS(SELECT 1 FROM executions e JOIN scoped_appointments a ON a.id_cita=e.appointment_id
        WHERE e.id=CAST(${J('m.metadata','$.execution_id')} AS UNSIGNED) AND a.paciente_id=c.patient_id)
        OR EXISTS(SELECT 1 FROM native_intents n WHERE n.message_id=m.id AND n.patient_id=c.patient_id))
  ), message_nodes AS (
    SELECT m.*,FIRST_VALUE(id) OVER(PARTITION BY execution_id ORDER BY id) first_id,
      FIRST_VALUE(node_id) OVER(PARTITION BY execution_id ORDER BY id) first_node
    FROM valid_messages m WHERE execution_id IS NOT NULL
  ), notice_attempts AS (
    SELECT m.*,ROW_NUMBER() OVER(PARTITION BY execution_id ORDER BY id DESC) notice_rank
    FROM message_nodes m WHERE node_id=first_node OR (node_id IS NULL AND id=first_id)
  ), notice_messages AS (SELECT * FROM notice_attempts WHERE notice_rank=1), raw_rows AS (
    SELECT CONCAT('visit:',n.id) id,'visit' source_kind,n.appointment_id,n.patient_id,n.scheduled_at,n.created_at,
      CASE n.purpose WHEN 'reminder_day_before' THEN 'day_before' ELSE 'same_day' END stage,
      n.template_name,n.template_version,n.template_public_id,n.template_clinic_id,n.template_group_id,n.template_is_system,n.template_created_by,
      NULL job_id,n.id communication_id,n.execution_id,m.id message_id,m.conversation_id,m.status message_status,m.sent_at,
      NULL job_status,e.status execution_status,n.status communication_status,
      CASE WHEN n.communication_revision<>n.current_revision THEN 1 ELSE 0 END superseded,
      NULL runtime_namespace,n.status native_status,NULL execution_wait_until,NULL skipped,NULL skip_reason,e.original_start
    FROM native_intents n LEFT JOIN valid_messages m ON m.id=n.message_id AND m.patient_id=n.patient_id
    LEFT JOIN executions e ON e.id=n.execution_id AND e.appointment_id=n.appointment_id
    UNION ALL
    SELECT CASE WHEN m.id IS NOT NULL THEN CONCAT('message:',m.id) ELSE CONCAT('execution:',e.id) END,
      'automation',e.appointment_id,a.paciente_id,COALESCE(j.scheduled_at,e.wait_until,e.created_at),e.created_at,e.stage,
      e.template_name,e.template_version,e.template_public_id,e.template_clinic_id,e.template_group_id,e.template_is_system,e.template_created_by,
      j.id,NULL,e.id,m.id,m.conversation_id,m.status,m.sent_at,j.status,e.status,NULL,CASE WHEN e.original_start IS NOT NULL AND e.original_start<>a.inicio THEN 1 ELSE 0 END,j.runtime_namespace,NULL,e.wait_until,j.skipped,COALESCE(j.skip_reason,e.failure_code),e.original_start
    FROM executions e JOIN scoped_appointments a ON a.id_cita=e.appointment_id
    LEFT JOIN jobs j ON j.appointment_id=e.appointment_id AND j.template_key=e.template_key AND j.window_identifier=e.window_identifier
    LEFT JOIN notice_messages m ON m.execution_id=e.id AND m.patient_id=a.paciente_id
    WHERE NOT EXISTS(SELECT 1 FROM native_intents n WHERE n.execution_id=e.id OR (n.message_id=m.id AND m.id IS NOT NULL)
      OR (m.id IS NULL AND n.appointment_id=e.appointment_id AND n.template_key=e.template_key AND n.scheduled_at=j.scheduled_at))
    UNION ALL
    SELECT CONCAT('scheduled:',j.id),'automation',j.appointment_id,a.paciente_id,COALESCE(j.scheduled_at,j.next_run_at),j.created_at,
      SUBSTRING_INDEX(SUBSTRING_INDEX(j.window_identifier,':',3),':',-1),
      t.name,t.version,t.public_id,t.clinic_id,t.group_id,t.is_system,t.created_by,
      j.id,NULL,NULL,NULL,NULL,NULL,NULL,j.status,NULL,NULL,0,j.runtime_namespace,NULL,NULL,j.skipped,j.skip_reason,NULL
    FROM jobs j JOIN scoped_appointments a ON a.id_cita=j.appointment_id
    LEFT JOIN templates_ranked t ON t.template_key=j.template_key AND t.ranking=1
    WHERE NOT EXISTS(SELECT 1 FROM executions e WHERE e.appointment_id=j.appointment_id AND e.template_key=j.template_key AND e.window_identifier=j.window_identifier)
      AND NOT EXISTS(SELECT 1 FROM native_intents n WHERE n.appointment_id=j.appointment_id AND n.template_key=j.template_key AND n.scheduled_at=j.scheduled_at)
  ), delivery_rows AS (
    SELECT r.*,a.patient_public_id,a.patient_name,a.titulo appointment_title,a.inicio appointment_start,a.estado appointment_status,a.import_metadata,
      CASE WHEN r.stage='same_day' AND r.scheduled_at<DATE_SUB(a.inicio,INTERVAL 26 HOUR) THEN 1 ELSE 0 END historical_schedule,
    CASE
      WHEN r.message_status IN ('read','delivered','sent') THEN r.message_status
      WHEN r.communication_status='unknown' THEN 'unknown'
      WHEN r.superseded=1 OR r.communication_status='cancelled' OR r.execution_status='cancelled' OR r.job_status='cancelled' THEN 'cancelled'
      WHEN r.message_status='failed' THEN 'failed'
      WHEN r.communication_status='failed' OR r.execution_status IN ('failed','dead_letter') OR r.job_status='failed' THEN 'failed'
      WHEN r.job_status='completed' AND r.execution_id IS NULL AND r.skipped IN ('true','1') THEN 'skipped'
      WHEN r.communication_status='accepted' OR (r.execution_status='completed' AND r.message_id IS NULL) OR (r.job_status='completed' AND r.execution_id IS NULL) THEN 'unknown'
      WHEN a.estado IN ('cancelada','no_asistio','cambio_solicitado','ha_acudido','en_atencion','completada') THEN 'blocked'
      WHEN r.source_kind='visit' AND :native_enabled = 0 THEN 'blocked'
      WHEN r.job_id IS NOT NULL AND ((r.runtime_namespace IS NULL AND :claim_unscoped = 0)
        OR (r.runtime_namespace IS NOT NULL AND r.runtime_namespace NOT IN (:runtime_namespaces))) THEN 'blocked'
      WHEN r.execution_status='paused' THEN 'blocked'
      WHEN r.message_status='sending' THEN 'processing'
      WHEN r.message_status='pending' THEN 'queued'
      WHEN r.communication_status='dispatching' OR r.execution_status='running' OR r.job_status='running' THEN 'processing'
      WHEN r.scheduled_at> :now THEN 'scheduled'
      ELSE 'queued' END status
    FROM raw_rows r JOIN scoped_appointments a ON a.id_cita=r.appointment_id AND a.paciente_id=r.patient_id
  ), appointment_coverage AS (
    SELECT a.*,${sequence ? `(SELECT s.anchor_appointment_id FROM AppointmentReminderSequences s
      WHERE s.clinic_id= :clinic_id AND s.patient_id=a.paciente_id AND s.time_zone= :timezone
      AND s.arrival_at>= :coverage_from AND s.arrival_at< :coverage_to
      AND EXISTS(SELECT 1 FROM JSON_TABLE(:clinic_days,'$[*]' COLUMNS(day DATE PATH '$.day',from_at DATETIME PATH '$.from',to_at DATETIME PATH '$.to')) d WHERE d.day=s.local_date AND a.inicio>=d.from_at AND a.inicio<d.to_at) LIMIT 1)` : 'NULL'} anchor_id
    FROM scoped_appointments a WHERE :include_unplanned = 1 AND a.inicio>= :coverage_from AND a.inicio< :coverage_to
      AND NOT EXISTS(SELECT 1 FROM delivery_rows r WHERE r.appointment_id=a.id_cita AND r.status<>'cancelled')
  ), coverage_rows AS (
    SELECT r.* FROM delivery_rows r
    UNION ALL
    SELECT ${rawColumns.map(key=>({id:"CONCAT('appointment:',a.id_cita)",source_kind:"'appointment'",appointment_id:'a.id_cita',patient_id:'a.paciente_id',superseded:'0'})[key]||'NULL').join(',')},
      a.patient_public_id,a.patient_name,a.titulo,a.inicio,a.estado,a.import_metadata,0,
      CASE WHEN a.estado IN ('cancelada','no_asistio','ha_acudido','en_atencion','completada') THEN 'skipped' ELSE 'unplanned' END
    FROM appointment_coverage a WHERE NOT EXISTS(
      SELECT 1 FROM delivery_rows r WHERE r.appointment_id=a.anchor_id AND r.patient_id=a.paciente_id AND r.status<>'cancelled')
  ), scoped_conversations AS (
    SELECT c.id,c.patient_id FROM Conversations c WHERE c.clinic_id= :clinic_id AND c.channel='whatsapp'
      AND EXISTS(SELECT 1 FROM coverage_rows r WHERE r.patient_id=c.patient_id)
  ), response_candidates AS (
    SELECT c.id conversation_id,c.patient_id,m.id message_id,m.createdAt received_at,
      ${attention ? 's.status state_status,s.stage state_stage,s.appointment_id state_appointment_id,s.source_message_id state_message_id,s.manual_action_required,s.needs_response' : 'NULL state_status,NULL state_stage,NULL state_appointment_id,NULL state_message_id,0 manual_action_required,0 needs_response'},
      ${claims ? "CASE WHEN claim.owner_type='unclaimed' AND JSON_UNQUOTE(JSON_EXTRACT(claim.metadata,'$.reason'))='no_active_message_received_automation' THEN 1 ELSE 0 END" : '0'} unclaimed,
      ROW_NUMBER() OVER(PARTITION BY c.patient_id ORDER BY m.id DESC) response_rank
    FROM scoped_conversations c JOIN Messages m ON m.conversation_id=c.id AND m.direction='inbound' AND m.message_type<>'event'
      AND COALESCE(${J('m.metadata','$.qa_cleanup')},'false')<>'true'
      AND COALESCE(${J('m.metadata','$.hide_from_quickchat')},'false')<>'true'
    ${attention ? 'LEFT JOIN ConversationAutomationStates s ON s.conversation_id=c.id AND s.clinic_id= :clinic_id' : ''}
    ${claims ? 'LEFT JOIN AutomationInboundMessageClaims claim ON claim.message_id=m.id AND claim.conversation_id=c.id AND claim.clinic_id= :clinic_id' : ''}
    WHERE m.createdAt>= :response_since AND m.createdAt<= :now
      AND NOT EXISTS(SELECT 1 FROM Messages h WHERE h.conversation_id=c.id AND h.id>m.id
        AND h.direction='outbound' AND h.message_type<>'event' AND h.status<>'failed'
        AND COALESCE(${J('h.metadata','$.kind')},'')<>'manual_appointment_notice'
        AND (${attention || claims ? 'h.sender_id IS NOT NULL OR' : ''} COALESCE(${J('h.metadata','$.source_event')},'')='smb_message_echoes'
          OR COALESCE(${J('h.metadata','$.coexistence.source_event')},'')='smb_message_echoes'))
  ), classified AS (
    SELECT r.*,p.message_id response_message_id,p.conversation_id response_conversation_id,p.received_at response_received_at,
      CASE
        WHEN p.state_status IN ('review','failed') AND p.state_message_id=p.message_id
          AND (p.state_appointment_id IS NULL OR p.state_appointment_id=r.appointment_id)
          AND (p.manual_action_required=1 OR p.needs_response=1 OR p.state_status='failed') THEN 'review'
        WHEN p.state_status='active' AND p.state_message_id=p.message_id AND p.state_stage IN ('collecting','analyzing','applying')
          AND (p.state_appointment_id IS NULL OR p.state_appointment_id=r.appointment_id) THEN 'analyzing'
        WHEN p.unclaimed=1 AND NOT (COALESCE(p.state_status,'')='completed' AND COALESCE(p.state_message_id,0)>=p.message_id) THEN 'unclaimed'
        ELSE NULL END attention_status
    FROM coverage_rows r LEFT JOIN response_candidates p ON p.patient_id=r.patient_id AND p.response_rank=1
  )`;
}

module.exports = { buildProjection };
