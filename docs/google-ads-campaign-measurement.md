# Diagnóstico de medición por campaña de Google Ads

## Objetivo

`Marketing > Informes` no debe afirmar que una campaña «gasta sin registrar
conversiones» observando únicamente `metrics.conversions`. El diagnóstico
combina la plataforma, la atribución CRM y la cobertura web sin mutar Google
Ads.

## Señales distintas

- `metrics.conversions`: acciones incluidas en la columna principal de Google
  Ads.
- `metrics.all_conversions`: todas las acciones, incluidas las secundarias.
- `LeadIntake.google_ads_customer_id/google_ads_campaign_id`: leads reales
  atribuidos por ClinicaClick.

`GoogleAdsInsightsDaily` persiste también `allConversions` y
`allConversionsValue`. La respuesta del informe mantiene `leads` y `cpl` como
aliases legacy, pero el frontend nuevo usa `crmLeads` y `crmCpl`; nunca llama
lead a un clic de llamada secundario.

## Destinos y cobertura

Cada sincronización de cuenta consulta `landing_page_view` una sola vez para
los últimos 30 días. Por campaña guarda en
`ExternalCampaignInventory.destination_detection`:

- URLs y dominios que recibieron tráfico;
- destino principal y fecha de comprobación;
- presencia del sufijo `cc_gads_customer_id` y `cc_gads_campaign_id`;
- expansión de URL de Performance Max y si alcanzó más de una ruta.

Los dominios se cruzan con `IntakeConfig.snippet_verification`, exigiendo
`verified=true`, `runtime_compatible=true` y dominio compatible. Si una PMax
expande tráfico dentro de un dominio cubierto, la expansión es una
recomendación; no se presenta como fallo de medición ni se modifica desde
Informes.

## Estados

| Estado | Significado |
|---|---|
| `healthy` | No hay evidencia de incidencia. |
| `secondary_conversions_only` | La columna principal está a cero, pero `all_conversions` contiene resultados. Es informativo. |
| `covered_no_conversions` | Destino, runtime y sufijo están cubiertos; no hubo conversiones reales en el periodo. Es informativo. |
| `provider_conversion_gap` | ClinicaClick tiene leads exactos, pero Google no muestra conversiones; revisar importación. |
| `cross_clinic_attribution` | La campaña produjo leads en otra clínica del grupo. |
| `destination_not_covered` | Algún dominio observado no tiene runtime verificado. |
| `attribution_suffix_missing` | Hay destino, pero falta confirmar el sufijo de campaña. |
| `destination_pending` | Aún no existe destino observado suficiente para diagnosticar. |

Los diagnósticos críticos o de advertencia usan `alert`; los estados
informativos usan `notice`. `recommendations[]` es independiente de ambos.

## Backfill selectivo

Tras añadir columnas o reparar un periodo, el job durable admite un filtro de
cuenta que evita leer las demás cuentas del grupo:

```http
POST /api/metasync/jobs/run/googleAdsBackfill
```

```json
{
  "runImmediately": true,
  "priority": "high",
  "payload": {
    "customerIds": ["1851215478"],
    "startDate": "2026-07-13",
    "endDate": "2026-07-16",
    "chunkDays": 4
  }
}
```

Este job solo lee Google y persiste métricas/inventario. No cambia pujas,
presupuestos, anuncios, objetivos ni destinos.

## Caso Hospitalet validado el 2026-07-17

- `21313059516`, **PROPDENTAL Búsqueda dental HOSPITALET**: cero en la
  columna principal, dos en `all_conversions`, ambas `Clics de llamada`.
- `21319497065`, **PROPDENTAL Pmax Local HOSPITALET**: cero en la columna
  principal, tres en `all_conversions`, todas `Clics de llamada`; expansión de
  URL activa dentro de `propdental.es`.
- Ambas conservan el sufijo ClinicaClick, el dominio tiene runtime verificado
  y no existe `LeadIntake` atribuido a esos IDs desde el 1 de julio.

El resultado correcto en UI es `0 Leads CC`, `2/3 conv. Ads totales`, estado
informativo de medición cubierta y una recomendación separada para la PMax.

## Verificación

```bash
node src/scripts/tests/google_ads_campaign_measurement_diagnosis.test.js
node src/scripts/tests/marketing_report_lead_attribution.test.js
node src/scripts/tests/access_policy.test.js
```
