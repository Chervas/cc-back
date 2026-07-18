# Contrato Google Ads: objetivo por etapa y cohorte (v4)

> **Actualización 2026-07-18:** el mismo executor seguro sirve a Mejora y Piloto, pero no comparten aprobación: Mejora aplica QL al activar y reutiliza el mandato cliente para QL→Schedule; Piloto conserva aprobación de operador.

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

`config.google_ads.goal_policy` pertenece exclusivamente al runtime de optimización de `guided_improvement` y `managed_service`; `connect_only` no lo provisiona ni lo aplica. Marketing > Web, la verificación del snippet y el provisioning de acciones deben conservarlo byte a byte junto con cualquier campo futuro no reconocido. Los writers de `IntakeConfig` leen la fila más reciente bajo lock y superponen únicamente su patch; un normalizador de lectura nunca reemplaza el objeto persistido. La regresión `intake_config_write_merge.test.js` cubre explícitamente `google_ads.goal_policy`, Enhanced, valores y campos desconocidos.

El servicio no decide cuándo avanzar de `qualified_lead` a `schedule` o
`purchase`: recibe la etapa ya aprobada por el ciclo de optimización y limita
la mutación al goal exclusivo de esa etapa/cohorte.

## Mejora: activación y transición automática

`guidedCampaignOptimizationPolicy.service.js` conecta este contrato con una
estrategia `guided_improvement` activa sin conceder operación integral:

- el cliente debe haber aceptado la autorización v1 con los scopes exactos
  `landing_publish`, `campaign_destination` y `conversion_goal`;
- activar una estrategia Google Search/PMax que supera los gates de medición y
  conversiones crea la policy directamente en `qualified_lead`; la medición es
  un gate previo, no una etapa persistida que deba promocionarse después;
- la policy y el `JobRequest` de aplicación nacen en la misma transacción. El
  worker aplica cada cuenta por separado mediante preview, digest,
  `validateOnly`, comprobación de drift y readback saludable;
- el job diario evalúa las policies activas. Cuando `qualified_lead → schedule`
  supera dos evaluaciones separadas al menos 24 horas y todos los umbrales,
  encola una transición deduplicada por `evaluation_id` y reutiliza como
  aprobación cliente el mandato inicial persistido. No requiere otro clic ni
  aprobación de operador;
- la etapa local solo cambia después de que todas las cuentas confirmen el
  readback. Un fallo libera el lease, conserva la etapa anterior y deja la
  policy activa para poder reintentar de forma durable.

Schedule usa 12 semanas completas calculadas con la fecha efectiva
`CitasPacientes.inicio`. Si algún evento no resuelve una cita o su fecha, se
añade `SCHEDULE_EFFECTIVE_DATE_COVERAGE_INCOMPLETE` y la promoción queda
bloqueada. Las acciones globales continúan secundarias y cada custom goal
conserva una sola señal de puja.

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

La promoción posterior se distingue por modo:

- en `guided_improvement`, el writer/orquestador ya existe y aplica
  automáticamente una evaluación `ready`, sin blockers y con digest vigente,
  reutilizando el mandato inicial del cliente;
- en `managed_service`, las dos evaluaciones y la serie semanal ya pueden
  producir evidencia suficiente, pero la mutación del proveedor continúa
  exigiendo aprobación operativa persistida. El reconciliador automático no
  encola transiciones de Piloto.

En ambos modos el evaluador puro devuelve `provider_mutation=null`. La
mutación vive en un executor separado y fail-closed. Al cambiar de etapa se
crea/asigna el goal inmutable específico de Schedule; nunca se convierte la
acción en primaria global ni se reescribe el goal anterior como si fuera otra
señal.
