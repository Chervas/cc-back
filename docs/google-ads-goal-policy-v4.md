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
