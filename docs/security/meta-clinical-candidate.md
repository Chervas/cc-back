# Candidata selectiva CRM de consumidores Meta — 19/09/2026

Estado: candidata comprobada, **sin publicación de API/UI ni DDL operativa**.
Contrato canónico en [13](../../src/Documentacion/13-backend.md#candidata-selectiva-de-consumidores-meta-19092026).
Fuente y huellas en `meta-clinical-candidate.json`. El manifiesto enumera también
fixtures y dependencias necesarias para probar; no autoriza ejecutar todos sus
entrypoints ni sustituir los servicios AWS.

## Fuente y alcance

- Backend `ae49fedcbc0370511c518dbb71a59120d202542a`, desde staging `ac4703a3`, worktree
  `/home/ubuntu/wt/security-meta-back-candidate-20260919`.
- Frontend `a8331d0d29b6f9410974b4c61add6b8ea5b2f7a2`, desde staging `288ca987`, worktree
  `/home/ubuntu/wt/security-meta-front-candidate-20260919`.
- Ambos en `security/meta-clinical-candidate-20260919`, separados de los worktrees
  ejecutados. No se ha fusionado DEV ni actualizado el frontend público.
- Correcciones desarrolladas primero en DEV: `9929de20` permite seleccionar la
  fuente y estilos exactos de QA; `83c6c9dd` retira las afirmaciones de permisos
  legacy mientras Meta está pausado. El alta preparada solo permite lectura.

Incluye metadatos locales sin tokens, comprobación manual, retirada durable,
OAuth, descubrimiento, reserva/confirmación/retirada de selección, modelos,
DDL04–12, tres jobs cerrados y productor/visor compatible con auditoría v24.
Conserva las rutas y consumidores Google actuales y el contrato WhatsApp público.
El lector de auditoría entiende las versiones intermedias ya admitidas en AWS;
ello no publica las integraciones Google. La clausura de fixtures incluye módulos
compartidos del broker y su lock, sin activarlos como servicios del backend.

Las seis adaptaciones backend y cinco frontend frente a DEV están enumeradas en
el manifiesto (`exactDev=false`): montaje sin routers Google pendientes, catálogo
público de 39 jobs más tres Meta, pruebas correspondientes, desconexión Google
conservada y traducciones que incorporan solo claves Meta. Los helpers compartidos
incluyen proyecciones de metadatos, bloqueo persistente y primarias de grupos.

## Dependencias detectadas mediante pruebas

1. El router necesitaba el import canónico de `accessSession.service` antes de
   montar los controles Meta. La prueba del router completo lo detectó.
2. `enabledEnv` figuraba en el catálogo público pero su encolador no lo comprobaba.
   Se incluye el guard ya existente en DEV. Verificado con los tres jobs cerrados,
   delegación controlada y regresión del catálogo público. Los flags públicos de
   auditoría/expiración están explícitamente `true`; gateway los conserva `false`.
3. El resolver antiguo no entendía la proyección de metadatos ni los tombstones.
   La prueba SQL detectó una lectura 200 tras un bloqueo donde debía haber 409.
   Se incluye el resolver vigente y el guard de primarias/desconexión Meta;
   la función de desconexión Google conserva su implementación pública.

## QA y límites

- Build Angular completo `429dbde4e7388b0a`; advertencia CommonJS de `debug`
  preexistente. 156 archivos JS/CJS pasan sintaxis.
- Router HTTP completo: autenticación, callback, no-store y rechazo de parámetros
  ajenos. Catálogo/executor de jobs y desconexiones legacy pasan.
- Auditoría: 94/94. Contención dirigida: 2/2; el test del inventario completo de
  transportes DEV se excluye explícitamente porque esta publicación es selectiva.
- Metadatos: once grupos SQL, cero SELECT de tokens, pool sin espera. Cien activos
  de grupo/1.000 clínicas: 17 sentencias, 127 ms, 26.276 bytes en MySQL temporal.
- Diario/revisión/lectura: 7/10/9 grupos. Cada proceso termina en 0 y su MySQL queda
  apagado. El envoltorio de esa tanda se observó con 143 tras los tres resultados;
  se verificaron los informes completos y ausencia de sus tres PID, sin repetirla.
- Siete casos de ejecución con runtimes/slots nuevos e independientes:
  `selection_ui`, `uncertain`, `permission_race`, `foreign_primary`, `foreign_share`,
  `wa_grant`, `session_changed`. Sin borrar cuotas, marcas, claims ni historial.
- Selección visual: nueve capturas del frontend candidato y sus propios estilos,
  Chromium/HTTP/MySQL/TLS/SQLite reales. Selección, respuesta perdida, consulta de
  estado sin segunda activación y retirada tras nueva sesión/logout. Revisadas
  las capturas de conexión en escritorio y retirada en móvil; sin error JS,
  salida de red externa ni overflow. Graph/Secrets/S3 y entrega MFA ficticios.
- Consulta de trabajo: rango por `cc_meta_enroll_due`, sin filesort, 2 ms entre
  10.000 solicitudes terminales y 1.000 futuras. No es carga de proveedor real.

Comando visual desde el worktree backend candidato (Node24):

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_OAUTH_DISCOVERY_TEST=1 META_ENROLLMENT_RUNTIME_TEST=1 META_ENROLLMENT_RUNTIME_CASE=selection_ui META_QA_FRONT_ROOT=/home/ubuntu/wt/security-meta-front-candidate-20260919 node src/scripts/tests/meta_marketing_oauth_mysql.integration.js
```

Los enlaces locales a dependencias se usaron solo después de comparar manifest y
lock; no deben copiarse a la release aislada. Instalar/verificar las dependencias
propias requeridas por los contratos antes de arrancar la API.

## Antes de publicar

Lectura de metadata SQL a las 12:21 UTC: DEV y staging tienen **cero** de las siete
tablas Meta nuevas, cero columnas `credentials_external`/`broker_app_id` y ninguna
DDL04–12 registrada. Los gates Meta siguen sin configurar; MFA permanece enforce.
La sesión AWS se comprobó con STS; no se modificaron servicios ni secretos AWS.

1. Ampliar el preflight para cubrir estas DDL/modelos: el contrato actual de 18/34
   tablas no acredita Meta. Preparar y revisar el plan exacto04–12, dependencia,
   respaldo puntual y diario DDL; MySQL no ofrece rollback transaccional de DDL.
2. Componer DEV sobre su release aislada actual, conservando su perfil,
   credenciales, worker y restricciones. Esta candidata nace de CRM y no reemplaza
   directamente el runtime DEV. No encender cron/jobs clínicos DEV.
3. Fijar un único ejecutor de conciliación por entorno: cron/JobRequests de CRM;
   integrar explícitamente en el worker de seguridad DEV sin activar negocio.
   El catálogo preparado no demuestra planificación desplegada.
4. App/slots, cuatro identidades de firma, TLS, IAM/KMS exactos y ámbito de la
   primera clínica/grupo deben revisarse antes de habilitar el alta. Sigue
   pendiente que el titular indique ese ámbito y autorice un OAuth nuevo.
5. Publicación coordinada API/UI tras esquema compatible; comprobar permisos
   efectivos y recorrido autenticado público. No reutilizar tokens investigados,
   ampliar grants WhatsApp ni retirar pausas para hacer pasar una prueba.

## Recuperación y coste

Ahora basta conservar los runtimes actuales: no hubo cambio operativo. Tras
introducir datos nuevos, cerrar altas y preservar controles, lectores v24,
claims/marcas/diarios/revocaciones. No ejecutar inversas con datos, restaurar tokens
SQL, volver a auditoría v19 ni repetir canarios o activaciones inciertas.

Coste incremental facturado `null`; sin consulta CE nueva. Se conserva el snapshot
etiquetado estimado/Unblended de 4,6195124129 USD, recogido19/09 08:22 UTC para1–18/09.
No se crearon instancias, secretos o conexiones clínicas en este corte.
