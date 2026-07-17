# Visibilidad local en ChatGPT y Gemini

## Contrato de producto

`GET /api/marketing/reports/competition/ai-visibility?clinicId=<id>` es el
punto de entrada de Informes. El usuario no redacta prompts ni tiene que pulsar
un botón. En cada lectura, el backend construye y garantiza de forma
idempotente estas tres consultas locales:

1. `¿Cuál es la mejor <categoría> en <localidad>?`
2. `¿Qué <categoría> recomiendan en <localidad>?`
3. `¿Qué <categoría> tiene buenas reseñas en <localidad>?`

Categoría, localidad y provincia proceden de la clínica y, si esos campos
están vacíos, de `ClinicBusinessLocations.raw_payload.storefrontAddress`. Así
una clínica conectada a Perfil de Empresa no cae en el texto genérico `mi zona`
por tener incompleto el formulario interno.

La respuesta incluye:

- `status` y `message`: estado global utilizable por la UI;
- `providers.*`: `configured`, `status`, `message`, modelo y almacenamiento;
- `automatic`: si se encolaron, reutilizaron o aplazaron consultas;
- `typical_queries`: clave, etiqueta y texto de las tres consultas canónicas;
- `runs`: resultados recientes; cada uno expone `query_key` y
  `query_source=system|legacy`.

Si faltan ambos secretos, el GET responde `200`,
`status=configuration_required` y
`automatic.status=waiting_configuration`. No crea filas ni jobs y nunca debe
convertirse en el mensaje genérico «No se pudo cargar». Ese mensaje queda para
un fallo HTTP, de autorización, clínica o almacenamiento real. Si hay al menos
un proveedor configurado, el GET encola automáticamente lo que falte.

`POST` se conserva durante la transición del frontend, pero solo selecciona
una consulta canónica mediante `query_key`. Un `query` legacy únicamente se
respeta si coincide exactamente con una de las tres consultas generadas; otro
texto cae en `best_local`. No existe una ruta backend de prompt libre.

## Idempotencia, coste y ejecución

- Una consulta terminal se reutiliza durante 24 horas.
- Una consulta `queued|running` se reutiliza durante 15 minutos para que varias
  pestañas no creen trabajo duplicado.
- La cola usa `enqueueUniqueJobRequest` con scope
  `ai_visibility:<clinicId>:<queryHash>` como segunda barrera distribuida.
- El máximo predeterminado es de tres consultas distintas por clínica cada 24
  horas: exactamente el catálogo típico. Una consulta parcial puede repetir
  una vez tras 60 minutos; el máximo predeterminado son dos intentos por
  consulta/24 h. Esto permite recuperarse al corregir saldo o credenciales sin
  abrir un bucle de llamadas.
- El GET solo crea `JobRequest`; las llamadas externas se ejecutan en
  `marketing_ai_visibility_run` fuera del request Express.
- Los resultados vencen según la retención configurada, 30 días por defecto.

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
```

La prueba cubre parsers y citas, `store=false`, herramientas de búsqueda,
consulta local canónica, rechazo de texto libre, GET sin secretos y encolado
automático de las tres consultas con deduplicación.
