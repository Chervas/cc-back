# Visibilidad local en ChatGPT y Gemini

## Contrato de producto

`GET /api/marketing/reports/competition/ai-visibility?clinicId=<id>` es el
punto de entrada de Informes. El usuario no redacta prompts ni tiene que pulsar
un botón. Al entrar en Informes, ese GET es el **único disparador automático**:
no hay cron diario ni semanal de proveedores. El backend construye y garantiza
de forma idempotente estas cuatro consultas locales:

1. `¿Cuál es la mejor <categoría> en <localidad>?`
2. `¿Cuál es el mejor dentista en <localidad>?`
3. `¿Qué <categoría> recomiendan en <localidad>?`
4. `¿Qué <categoría> tiene buenas reseñas en <localidad>?`

Categoría, localidad y provincia proceden de la clínica y, si esos campos
están vacíos, de `ClinicBusinessLocations.raw_payload.storefrontAddress`. Así
una clínica conectada a Perfil de Empresa no cae en el texto genérico `mi zona`
por tener incompleto el formulario interno.

La respuesta incluye:

- `status` y `message`: estado global utilizable por la UI;
- `providers.*`: `configured`, `status`, `message`, modelo y almacenamiento;
- `automatic`: si se encolaron, reutilizaron o aplazaron consultas;
- `typical_queries`: clave, etiqueta y texto de las cuatro consultas canónicas;
- `refresh_interval_days=7`: próxima antigüedad mínima para volver a consultar
  proveedores;
- `runs`: resultados recientes; cada uno expone `query_key` y
  `query_source=system|legacy`.

Si faltan ambos secretos, el GET responde `200`,
`status=configuration_required` y
`automatic.status=waiting_configuration`. No crea filas ni jobs y nunca debe
convertirse en el mensaje genérico «No se pudo cargar». Ese mensaje queda para
un fallo HTTP, de autorización, clínica o almacenamiento real. Si hay al menos
un proveedor configurado, el GET de entrada encola solo las consultas que no
tengan una ejecución de los últimos siete días. Abrir otra pestaña, recargar o
volver durante esa semana devuelve los mismos textos, fuentes y citas.

`getOverview()` tiene `autoStart=false` por defecto. El controlador del GET de
Informes es el único que lo invoca explícitamente con `autoStart=true`. El
polling de `GET /:runId`, las tareas de limpieza y las lecturas técnicas no
crean ejecuciones. `marketing_ai_visibility_run` está catalogado como job de
integración dirigida porque ejecuta una solicitud ya creada, no como tarea
periódica; no aparece en `SCHEDULED_JOB_DEFINITIONS`.

`POST` se conserva durante la transición del frontend, pero solo selecciona
una consulta canónica mediante `query_key`. Un `query` legacy únicamente se
respeta si coincide exactamente con una de las cuatro consultas generadas; otro
texto cae en `best_local`. No existe una ruta backend de prompt libre.

## Idempotencia, coste y ejecución

- Una consulta terminal se reutiliza durante siete días desde su creación.
  Esto incluye `completed`, `completed_with_errors` y `failed`: corregir saldo,
  credenciales o configuración no provoca una llamada anticipada; la siguiente
  visita a Informes la renovará cuando se cumpla la semana.
- Una consulta `queued|running` se reutiliza durante 15 minutos para que varias
  pestañas no creen trabajo duplicado. Si sigue activa después, el rate limit
  semanal de la fila existente continúa impidiendo otra ejecución.
- La cola usa `enqueueUniqueJobRequest` con scope
  `ai_visibility:<clinicId>:<queryHash>` como segunda barrera distribuida.
- El máximo predeterminado es de cuatro consultas distintas por clínica en una
  ventana móvil de siete días: exactamente el catálogo canónico **actual**. El
  recuento global solo considera los cuatro hashes construidos con la categoría
  y localidad vigentes; si se corrige la ciudad/categoría, los hashes antiguos
  no bloquean las cuatro consultas nuevas. Sigue existiendo un máximo estricto
  de una ejecución por `clinicId + queryHash` en esa misma ventana.
- El GET solo crea `JobRequest`; las llamadas externas se ejecutan en
  `marketing_ai_visibility_run` fuera del request Express.
- Si falla la creación del `JobRequest`, la fila de run se elimina: no hubo
  proveedor ni ejecución y no debe consumir cuota siete días. Como defensa
  para filas legacy, un `failed` sin `job_request_id` ni `started_at` tampoco se
  reutiliza, se muestra ni entra en los recuentos semanales. Un fallo que sí
  llegó al worker conserva `job_request_id` o `started_at`, auditoría y bloqueo
  semanal.
- Los resultados, fuentes y citas se sirven desde `provider_results` sin volver
  a llamar al proveedor durante siete días. Vencen físicamente según la
  retención configurada, 30 días por defecto y nunca inferior al intervalo de
  actualización.

Variables de coste:

- `AI_VISIBILITY_REFRESH_INTERVAL_DAYS=7`: admite 7-30, nunca menos de una
  semana;
- `AI_VISIBILITY_MAX_RUNS_PER_CLINIC_7D=4`: guardarraíl de consultas distintas;
- `AI_VISIBILITY_RETENTION_DAYS=30`: conservación local, mínimo igual al
  intervalo de refresco;
- `AI_VISIBILITY_PROVIDER_TIMEOUT_MS=90000`: timeout independiente por
  proveedor.

Las antiguas `AI_VISIBILITY_CACHE_HOURS`,
`AI_VISIBILITY_MAX_RUNS_PER_CLINIC_24H` y
`AI_VISIBILITY_MAX_ATTEMPTS_PER_QUERY_24H` ya no gobiernan esta funcionalidad:
permitirían una cadencia diaria incompatible con el contrato semanal.

## Integración con Conseguir reseñas

La tarjeta canónica `trusted_reviews` puede ofrecer el enlace a la campaña
**Conseguir reseñas** solo cuando aún no está activa. Para decidirlo no debe
llamar al resumen pesado de candidatos y métricas. Usa:

`GET /api/marketing/review-requests/automation-status?clinicId=<id>`

La ruta hereda el `authMiddleware`, el mismo resolvedor de scope y los mismos
permisos que `GET /review-requests/summary`, exige una clínica concreta y lee
únicamente `getReviewAutomationTemplate(scope, { includeInactive: true })`.
Devuelve:

```json
{
  "success": true,
  "clinic_id": 66,
  "automation_enabled": true,
  "scope": {
    "type": "clinic",
    "clinicIds": [66],
    "groupId": null,
    "original": "66"
  }
}
```

No construye candidatos, tratamientos, disponibilidad de WhatsApp, métricas ni
estado de Perfil Google. Un scope `group:*`, `all`, vacío o multiclínica devuelve
`400 REVIEW_AUTOMATION_SINGLE_CLINIC_REQUIRED`.

## Proveedores

OpenAI se invoca exclusivamente desde backend mediante
`POST /v1/responses`, `tools=[{type:web_search}]`,
`tool_choice=required`, fuentes completas y `store=false`. La búsqueda recibe
ubicación aproximada de ciudad/provincia cuando existe. Las citas URL se
normalizan para que el frontend pueda mostrarlas como enlaces visibles. Véase
la [guía oficial de Web search](https://developers.openai.com/api/docs/guides/tools-web-search).

Gemini se invoca exclusivamente desde backend mediante Interactions API,
`google_search` y `store=false`. Se preservan citas y el HTML de
`search_suggestions` exigido por Google. Véanse
[Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search?hl=es-419)
y [Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview).

El prompt identifica la clínica solo después de formular la consulta neutral y
ordena no introducirla ni favorecerla si no aparece de forma natural en las
fuentes. No se envían pacientes, teléfonos, emails, notas ni tratamientos de
personas.

Secretos admitidos, siempre fuera de Git:

- `OPENAI_API_KEY`, `OPENAI_PROJECT_ID`, `OPENAI_ORGANIZATION_ID`;
- `GEMINI_API_KEY`, `GOOGLE_CLOUD_PROJECT`,
  `GOOGLE_CLOUD_PROJECT_NUMBER`.

La ausencia de un secreto es un estado operativo parcial, no una excepción. Un
proveedor configurado puede completar sus resultados aunque el otro esté
pendiente.

## Verificación

```bash
node -c src/services/marketingAiVisibility.service.js
node -c src/controllers/marketingAiVisibility.controller.js
node src/scripts/tests/marketing_ai_visibility.test.js
node src/scripts/tests/marketing_review_automation_status.test.js
```

La prueba cubre parsers y citas, `store=false`, herramientas de búsqueda, las
cuatro consultas canónicas, rechazo de texto libre, GET sin secretos, default
sin autoarranque, encolado desde Informes, reutilización de texto/fuentes/citas
durante seis días, reutilización de parciales y fallos, y bloqueo de un segundo
intento antes de siete días.
`marketing_review_automation_status.test.js` cubre activo/inactivo/ausente,
rechazo de scope ambiguo, reutilización del scope del summary y registro GET.
