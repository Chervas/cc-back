# Recepción nativa Google Ads mediante broker

Estado 19/09/2026: preparada en DEV, no desplegada ni aceptada con Google real.
Contrato canónico: [13](../../src/Documentacion/13-backend.md#recepción-nativa-google-por-broker-preparada-19092026).
El alcance es el polling nativo `campaign_google_leads_sync`; no añade un webhook,
no cambia conversiones ni activa campañas, consentimiento o automatizaciones.

## Flujo y datos

JobRequest conserva solo setting/account y namespace del runtime. Resuelve sus
asignaciones actuales, selecciona el transporte sin hidratar OAuth local y llama
al broker firmado. Operación `google.ads.leads.read.v1`, payload exacto
`{sinceDate: YYYY-MM-DD, pageToken: string|null}`. Grant explícito por cuenta,
manager y clínica; los grants de informes existentes no se amplían por desplegar
el código. El reader solo devuelve el conjunto cuando todas las páginas pasan
validación, límite de filas/bytes, plazo y guards de autorización.

La proyección conserva las cinco clases de contacto ya admitidas por CRM:
FULL_NAME, FIRST_NAME, LAST_NAME, EMAIL y PHONE_NUMBER. Campos ajenos, respuestas
personalizadas y cabeceras/provider tokens no cruzan la proyección. Contacto
malformado queda explícitamente inválido y no impide tratar otros contactos
válidos. Identidad inconsistente o ID repetido en el conjunto gestionado invalida
la lectura completa; es más estricto que la deduplicación legacy por fila.

El contrato se contrastó con [recurso v24](https://developers.google.com/google-ads/api/reference/rpc/v24/LeadFormSubmissionData)
y [campos GAQL v24](https://developers.google.com/google-ads/api/fields/v24/lead_form_submission_data).
No se consulta `custom_lead_form_submission_fields`. La ventana de siete días y
el límite 10.000 conservan el polling existente; no son la retención del proveedor.

El broker almacena solo metadatos técnicos; `persistResult:false` deja NULL en
commands.result. El contacto proyectado tiene TTL de memoria 60 s, borrado al
consumo final, avance, revocación y cierre, con temporizador de expiración aun sin
tráfico. No se promete borrado físico de memoria JavaScript. Cache global máxima
64 MiB/16 entradas, respuesta 250 filas/780 kB; evicción o expiración falla cerrada.
Hay relectura completa después de un cursor perdido, nunca un resultado parcial
presentado como completo. El límite de 45 s cubre la lectura, no el tiempo total
de persistir 10.000 leads en CRM. No se mantiene transacción SQL mientras responde
Google.

## Activación y recuperación

1. Completar identidad/consumidores compartidos, preflight de esquema y releases
   compatibles de API/job/broker. Este tramo no añade DDL; el esquema compartido
   de seguridad de staging sigue necesitando su promoción selectiva.
2. Aceptar con titular/sesión Google reales el acceso de leadFormSubmissionData y
   la asignación de cada campaña. Probar con un lead nuevo expresamente acotado,
   preservando pausas clínicas; la autorización de lectura no permite enviar
   mensajes de prueba a contactos existentes.
3. Conservar `CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED`, gate Ads y permisos existentes.
   Instalar corte explícito `GOOGLE_ADS_LEADS_ACTIVE_SINCE` y abrir el gate nuevo
   solo para el corte revisado. Ambos permanecen sin instalar en los runtimes
   actuales. Gateway no puede ejecutarlo; DEV conserva jobs clínicos OFF.
4. Revisar `received`, `duplicates`, `excluded`, `pending`, `invalid_contacts` y
   `historical_skipped`. El corte es estable, no futuro, no se retrocede. Es global
   al runtime: incorporar otra cohorte con fecha distinta requiere resolver su
   propio corte, no reutilizar una fecha antigua y procesar su historia.
5. Ante fallo, cerrar el gate del polling gestionado y conservar leads, auditoría,
   JobRequests, bindings y revocaciones. No restaurar tokens locales ni bajar a
   una versión que omita los guards. Un fallo tras commit recupera el mismo lead
   y la auto-respuesta idempotente; no reenviar a mano ni activar flujos pausados.
   Una cuenta gestionada nunca cae al transporte legacy por faltar permiso.

## Verificación reproducible y límites

`google_native_leads_mysql.integration.js` utiliza MySQL 8.0.42 propio sin TCP,
modelos y transacciones reales, HTTPS firmado, SQLite y proveedores ficticios.
El dispatcher de automatizaciones está desconectado; persiste ejecución/job
real para probar su deduplicación, sin ejecutar nodos o enviar mensajes.
Solo se permiten sockets Unix del MySQL propio y servidores loopback registrados.

Ejecutar con Node 24 y `CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1`; añadir
`GOOGLE_NATIVE_LEADS_VISUAL=1` para Chromium. La fixture visual compila la tabla
exacta con métodos/servicio Angular de producción y Sass/Tailwind del repositorio,
usa el controlador/sesión SQL reales y un selector de clínicas de prueba. No
sustituye aceptación de toda la página, drawer, permisos no administrativos o MFA
público. Verifica carga, actualización, ausencia de duplicados y clínica A vacía
cuando la asignación pertenece a B, en 1440/390 px. No cambia código de frontend.

En la ejecución final aislada: primer lead 170 sentencias/233 ms (antes del ajuste,
296); lectura de 251 históricos 183/237 ms, una consulta al proveedor y dos slices;
20 leads nuevos 740/661 ms; reintento 20 duplicados 700/423 ms. Pool 0 ocupadas/0
esperando al terminar; cero SELECT de columnas OAuth, 19 comandos firmados,
18 lecturas ficticias de Google y cuatro capturas. Estos números no equivalen a
carga concurrente de producción ni acreditan la cardinalidad máxima; la mayoría
de consultas comprueban identidad/ámbito y se repiten antes de guardar.

Regresión completa broker: 628/628 con red externa bloqueada; después, ocho
pruebas específicas de leads, incluida expiración inactiva por temporizador.
Backend: 72/72 de recepción, ámbito, reader, lifecycle, routing y auto-respuesta.
Se corrigió una aserción textual antigua de routing web para el contrato vigente
que prioriza atribución verificada de landing; el código de routing web no cambia.

No añade servicio AWS, pero sí llamadas/recibos y trabajo MySQL al activarse.
Coste incremental facturado pendiente; no se anota cero ni el total de la cuenta.
Evidencia privada: `qa-evidence/security-resume-20260917/google-native-leads-20260919/`.
