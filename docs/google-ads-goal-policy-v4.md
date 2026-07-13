# Contrato Google Ads: objetivo por etapa y cohorte (v4)

`googleAdsClinicaclickGoalPolicy.service.js` aplica una regla deliberadamente
estrecha: cada policy de una cohorte de campañas puede pujar por **una sola** de
estas señales canónicas:

- `qualified_lead` → `Qualified Lead - ClinicaClick`
- `schedule` → `Schedule - ClinicaClick`
- `purchase` → `Purchase - ClinicaClick`

`lead` y `contact` se conservan como medición/observación. Las cinco acciones
canónicas deben existir, pertenecer a la cuenta, ser `UPLOAD_CLICKS`, estar
`ENABLED`, usar `MANY_PER_CLICK` y seguir globalmente como secundarias
(`primary_for_goal=false`). La policy no muta `ConversionAction` ni
`customer_conversion_goal`.

## Configuración v4

```json
{
  "customer_id": "1851215478",
  "strategy_ref": "strategy:new-patients:group-5",
  "campaign_ids": ["101", "102"],
  "canonical_action_ids": {
    "lead": "1",
    "contact": "2",
    "qualified_lead": "3",
    "schedule": "4",
    "purchase": "5"
  },
  "bidding_action_key": "qualified_lead",
  "owned_custom_goal_resource_name": null
}
```

El nombre del custom goal contiene la etapa y un hash estable de
`strategy_ref + campaign_ids`, por ejemplo:

`Clinicaclick · Nuevos pacientes · Lead cualificado · cohorte 32390e4da6`

Así, una etapa o cohorte distinta nunca comparte un goal mutable. Cambiar de
etapa requiere crear/asignar el goal específico de la etapa nueva; no se
reescribe el goal anterior.

## Compatibilidad fail-closed

La configuración v3 se puede leer y auditar, pero nunca se aplica de forma
silenciosa. El preview queda bloqueado con `GOAL_POLICY_MIGRATION_REQUIRED` si:

- omite la selección y hereda `lead + contact + schedule`;
- usa `lead` o `contact` para puja;
- elige varias señales a la vez;
- conserva `supplemental_action_ids` (incluido `AD_CALL`);
- apunta al goal genérico `Clinicaclick · Captar nuevos pacientes`.

Las campañas `SMART` quedan `observe_only` y bloquean `apply`. No se intenta
cambiar su configuración de objetivos.

## Garantías de ejecución

- `preview` solo lee y genera digests deterministas.
- `apply` exige confirmación, digest vigente y una sola cuenta.
- todas las mutaciones pasan primero por `validateOnly` y por una segunda
  lectura contra drift;
- el readback verifica que goal, campañas y objetivos queden estables;
- el plan conserva los datos anteriores necesarios para rollback manual;
- la auditoría diaria detecta drift, pero no autorepara.

El servicio no decide cuándo avanzar de `qualified_lead` a `schedule` o
`purchase`: recibe la etapa ya aprobada por el ciclo de optimización y limita
la mutación al goal exclusivo de esa etapa/cohorte.

## Piloto automático: provisioning y ejecución

`managedCampaignOptimizationPolicy.service.js` conecta este contrato con
`ManagedCampaign` sin ampliar su radio de impacto:

- al entrar una campaña Google Search/PMax gestionada en `launching` o
  `active`, exige `account_id`, `campaign_ids` y los cinco IDs canónicos
  resueltos desde el `IntakeConfig` del scope;
- crea idempotentemente una única `CampaignOptimizationPolicy` por
  `ManagedCampaign`, comenzando en `qualified_lead`, y persiste la
  cuenta/cohorte en `google_ads.goal_policy` v4. La policy queda `paused`
  durante el apply y solo pasa a `active` junto al CAS final de status;
- una misma cuenta puede tener varias cohortes con `strategy_ref` distinto,
  pero sus `campaign_ids` deben ser disjuntos. Ownership se identifica por
  `customer_id + strategy_ref + cohort`;
- `connect_only`, `operation_mode=observe` y Google Smart nunca llegan al
  executor ni cambian pujas.

La entrada en `launching` usa tres fases. Primero, una transacción DB corta
provisiona policy/config, adquiere un lease durable de 30 minutos sobre esa
`ManagedCampaign` y hace commit. Un segundo POST concurrente queda bloqueado
antes de llamar a Google. Después, fuera de cualquier transacción DB, el
executor obtiene un preview y su digest y llama a
`applyClinicaclickGoalPolicy` para ejecutar, por una sola cuenta/cohorte,
`validateOnly`, comprobación de drift, apply y readback. Solo con readback
healthy una segunda transacción corta cambia el status de la campaña. Si
Google falla, la campaña no entra en `launching`; la policy local y cualquier
`owned_custom_goal_resource_name` ya creado quedan durables para un retry sin
duplicar goals. Al crear un custom goal nuevo, su ownership se persiste
inmediatamente después de obtener y verificar el `resource_name`, antes de
validar o mutar asociaciones de campañas. El lease se consume en el CAS final
o se libera al fallar; si el proceso muere, caduca sin autorizar mutaciones por
sí mismo.

El evaluador diario no reemplaza `lifecycleState` mientras haya un lease
vigente: registra la policy como omitida y espera al siguiente ciclo. Si una
evaluación empezó antes de adquirir el lease, el CAS por `version` impide que
su escritura posterior borre la reserva.

El consentimiento para esta ejecución procede exclusivamente del gate admin
persistido del Piloto automático (`approved_by_user_id`, `approved_at` y
`operation_mode=managed`). No existe ruta GET de apply. Los POST operativos
`/:id/goal-policy/preview` y `/:id/goal-policy/apply` permiten revisar/reintentar;
el segundo exige el digest obtenido por preview.

La promoción `qualified_lead → schedule` permanece fail-closed. Además del
contrato existente de dos evaluaciones consecutivas y sus umbrales, el
executor exige evidencia persistida de ambas evaluaciones y aprobación de
operador. Hoy faltan dos piezas para completar el recorrido end-to-end:

- el agregador no dispone de la serie semanal por fecha real de cita
  (`SCHEDULE_WEEKLY_HISTORY_UNAVAILABLE`), por lo que no se inventa un reparto
  desde `attempted_at`;
- existe `applyApprovedLifecycleTransition` como helper puro y el executor sabe
  validar un `approved_transition` ya persistido, pero ninguna ruta actual
  materializa esa aprobación ni invoca el helper para escribir el cambio de
  etapa.

Por tanto, el soporte del planner/executor para Schedule no equivale todavía a
una transición operativa automática. Cuando se integren el agregador y el
writer/orquestador de aprobación, la nueva etapa eliminará el ownership de QL
y creará/asignará el goal inmutable específico de Schedule; nunca reescribirá
el goal de QL.
