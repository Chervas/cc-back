# Metadatos Meta en el arranque de Marketing

Preparado el 19/09/2026 en los mismos worktrees DEV; sin publicar ni activar Meta.
Contrato canónico en [13-backend](../../src/Documentacion/13-backend.md#bootstrap-meta-sin-hidratación-de-credenciales-preparado-19092026).

## Diagnóstico y alcance

Abrir el asistente Google/Meta cargaba modelos completos de `MetaConnections` y
`ClinicMetaAssets`, aunque para dibujar cuentas solo necesitaba metadatos. La
selección incluía OAuth, token de página y `additionalData`. Además, una conexión
guardada podía mostrarse como disponible y provocar una consulta de píxeles que
iba a ser rechazada por la contención no WhatsApp ya existente.

Las consultas del bootstrap ahora usan listas cerradas de columnas; la lectura
compartida del inventario también. Los consumidores no adaptados conservan su
resolver legacy: no se afirma eliminación global de tokens en SQL. La pausa se
declara explícitamente en el DTO, CAPI y asistente; cuenta/píxel se conservan. El
usuario puede continuar solo con Google. No hay reconexión, descubrimiento de
píxeles ni apertura de mapping durante esa pausa. La API rechaza un inicio de
campañas existentes con Meta antes de escribir configuración/solicitudes.

No existe todavía una operación de broker Ads/CAPI habilitada por este cambio.
WhatsApp operativo usa su transporte separado y no autoriza Ads, páginas ni
conversiones. No cambia contención, credenciales, permisos, cohortes, DDL, jobs,
pausas clínicas, MFA o infraestructura. No se han probado tokens reales.

## Pruebas y límites

- `google_bootstrap_settings_mysql.integration.js` con
  `CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_BOOTSTRAP_METADATA_TEST=1
  GOOGLE_BOOTSTRAP_E2E_VISUAL=1`, Node 24: diez grupos correctos en MySQL propio,
  API/sesión SQL reales, broker HTTPS firmado/SQLite y proveedor ficticio.
- Desconexión y bloqueo durante I/O Google prevalecen sobre el inventario
  anterior; asociación, mapping y fallback de usuario inequívoco/ambiguo se
  resuelven sin columnas secretas. Consulta directa de píxeles e inicio mixto
  rechazados; configuración y `CampaignRequest` intactos.
- Asistente Angular y tarjeta Web exacta en Chromium, 1440/390 px: seis capturas,
  sin errores, escrituras desde navegador ni peticiones de píxeles; conserva el
  píxel y permite Google al desmarcar Meta. La captura móvil enfoca las tarjetas,
  no pretende documentar la página completa. No son MFA/Google/Meta públicos.
- Primera apertura: 104 sentencias/170 ms. Ocho simultáneas con 100 ms de latencia
  ficticia: 832 sentencias, mediana 619 ms, máximo 644 ms, pool final 0/0. Todo el
  ensayo: 2.651 consultas, 25 comandos firmados de Google, cero SELECT OAuth
  Google, OAuth Meta, tokens de página o `additionalData`; cero ingestas/acciones.
  No acredita cardinalidad real, carga sostenida o capacidad global de MySQL.
- Regresión dirigida: diez pruebas correctas (resolución de ámbito, inventario,
  multigrants, contención HTTP, onboarding y gate Enhanced). Compilación Angular
  `ngc --noEmit` correcta. El control global ES/CAT mantiene los cuatro textos
  ausentes y cinco observaciones de calidad del HEAD anterior; las tres claves
  añadidas no introducen defectos nuevos. No se declara ese control global verde.

No cambia código del broker; su suite anterior no se cuenta como una ejecución
nueva de este corte. Inventario acotado y huellas en
`meta-marketing-bootstrap-consumers.json`. Evidencia privada:
`qa-evidence/security-resume-20260917/meta-bootstrap-metadata-20260919/`.

## Publicación y recuperación

Push a DEV conserva el trabajo; no actualiza releases ni CRM. Antes de publicar,
revisar compatibilidad API/UI y el conjunto selectivo de dependencias: el estado
actual de DEV contiene otros cambios de seguridad todavía sin aceptación real.
No promover toda la rama. Mantener gates y cron clínicos apagados. No se puede
retirar la pausa solo porque el asistente compile o no lea credenciales.

Mientras no haya despliegue, las releases vigentes son la recuperación. Tras una
eventual publicación, una regresión visual puede requerir retirar el componente
selectivo conservando la contención HTTP/API; nunca reabrir transporte legacy,
borrar asignaciones/píxeles o restaurar credenciales para recuperar el verde.
La aceptación real del vault Meta y sus consumidores sigue pendiente.
