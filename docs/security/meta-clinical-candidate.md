# Candidata selectiva CRM de consumidores Meta — 19/09/2026

Estado CRM: candidata comprobada, API/UI sin publicar. **DDL04–12, consumidores
backend e interfaz publicados solo en DEV**, con todos los gates Meta OFF; detalle en
[la publicación DEV](meta-dev-consumers.md).
Contrato canónico en [13](../../src/Documentacion/13-backend.md#candidata-selectiva-de-consumidores-meta-19092026).
Fuente y huellas en `meta-clinical-candidate.json`. El manifiesto enumera también
fixtures y dependencias necesarias para probar; no autoriza ejecutar todos sus
entrypoints ni sustituir los servicios AWS.

## Fuente y alcance

- Backend `1da9f5a74f9f1f718abdc762af56b3f71e853e4b`, desde staging `ac4703a3`, worktree
  `/home/ubuntu/wt/security-meta-back-candidate-20260919`.
- Frontend `27afa85ce45667091654f0c2a21cf5c9395d83b4`, desde staging `288ca987`, worktree
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

Las adaptaciones backend y frontend frente a DEV están enumeradas en
el manifiesto (`exactDev=false`): montaje sin routers Google pendientes, catálogo
público de 39 jobs más tres Meta, pruebas correspondientes, desconexión Google
conservada, contrato SQL selectivo y traducciones que incorporan solo claves Meta. Los helpers compartidos
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

## Esquema DEV aplicado y verificado — 19/09, 12:46 UTC

Las nueve migraciones04–12 se aplicaron una sola vez con `apply-dev` de la candidata
`07e37fc7`, plan fijado por hashes y diario fsync. Antes se comprobaron el contrato
actual y la ausencia de trabajos activos, se detuvieron exclusivamente API/worker
DEV y se respaldaron estructura, historial y metadata. Las tablas originales
`MetaConnections`/`ClinicMetaAssets` tenían cero filas también con ambos servicios
detenidos: no fue necesario exportar credenciales ni datos de pacientes.

Resultado: nueve DDL registradas, siete tablas nuevas y nueve tablas Meta vacías;
1,903 s entre el primer inicio de migración y la comprobación final del diario.
Las pruebas contra MySQL aislado conservan filas legacy ficticias, tokens, pausas,
Unicode y relaciones; rechazan mezclas de credenciales, claims duplicados y una
inversa con datos. El preflight detecta CHECK desactivado, expresión generada
alterada, cascada añadida y falta del índice de última selección. DEV: cinco tests
unitarios y dos MySQL; candidata: cinco unitarios y la cadena MySQL completa.

El contrato fuente DEV es de49 tablas (antes40), el candidato CRM de27 (antes18).
En ese corte el runtime DEV mantuvo su contrato34: **ambos contratos34/27 pasaron**
después del cambio. La publicación posterior DEV usa 43; ver su acta. No publicar
toda la fuente DEV ni aplicar DDL ajena para satisfacer 49.
Se reiniciaron los mismos servicios con el mismo enlace y configuración protegida;
MFA sigue enforce, cron/jobs clínicos false. PIDs y arranques de CRM/gateway intactos.
Las primeras lecturas de logs no contienen errores de esquema ni los marcadores
comprobados de fallo del worker; esto no acredita capacidad bajo carga real.

Chromium real verifica login anónimo en CRM/DEV,1440/390 px, sin mocks de API:
HTTP200, `/api/auth/me`401, formulario vacío sin POST, cero errores JS/5xx u overflow.
Se revisaron visualmente las capturas CRM escritorio y DEV móvil. No se usó una
sesión autenticada ni se envió MFA: el recorrido autenticado sigue pendiente.
Evidencia privada: `qa-evidence/security-resume-20260917/meta-schema-publication-20260919/`,
especialmente `dev-plan.json`, `dev-schema-point-backup.json`, `dev-journal.jsonl`,
`dev-operation-*.json`, `preflight-dev-after.json`, `current-dev-contract-after.json`
y `login-smoke.json`. No repetir ese plan ya aplicado.

## Antes de publicar API/UI y migrar staging

Staging conserva el digest SQL previo: mismo esquema, doce diferencias Meta y
nueve DDL pendientes. No se modificaron servicios, secretos o recursos AWS en
este corte. Los gates Meta siguen sin configurar; MFA permanece enforce.

1. Preparar un corte explícito de las nueve DDL en staging, con comprobación de
   datos existentes, respaldo privado de recuperación y diario. La herramienta
   compartida sigue admitiendo escritura **solo en DEV**; su comprobación pública
   es de lectura. MySQL no ofrece rollback transaccional de DDL.
2. DEV ejecuta su composición propia `d07e9c85`, conservando perfil/credenciales
   y jobs clínicos OFF. La candidata CRM ya incorpora los cierres desarrollados
   en DEV 9c54f261 y el aviso de pausa corregido; nueva QA HTTP/visual y build
   `354410eb1dba3209` pasan. No intercambiar ambos runtimes.
3. Un único ejecutor de conciliación por entorno: cron/JobRequests de CRM; DEV
   ya dispone de sus tres bucles en el worker de seguridad, todavía OFF. Faltan
   identidades/configuración y validación real para habilitarlos; publicar el
   catálogo no autoriza activar ni ejecutar trabajo histórico.
4. App/slots, cuatro identidades de firma, TLS, IAM/KMS exactos y ámbito de la
   primera clínica/grupo deben revisarse antes de habilitar el alta. Sigue
   pendiente que el titular indique ese ámbito y autorice un OAuth nuevo.
5. Publicación coordinada API/UI tras esquema compatible; comprobar permisos
   efectivos y recorrido autenticado público. No reutilizar tokens investigados,
   ampliar grants WhatsApp ni retirar pausas para hacer pasar una prueba.

## Recuperación y coste

Conservar los runtimes actuales y el esquema aditivo aplicado en DEV. No ejecutar
un `down` para volver a la versión de código anterior: ya se verificó compatible.
Si una DDL futura falla, mantener sus escritores detenidos e inspeccionar el último paso del
diario antes de decidir una reparación; no repetir automáticamente el plan. Tras
introducir datos nuevos, cerrar altas y preservar controles, lectores v24,
claims/marcas/diarios/revocaciones. No ejecutar inversas con datos, restaurar tokens
SQL, volver a auditoría v19 ni repetir canarios o activaciones inciertas.

Coste incremental facturado `null`; sin consulta CE nueva. Se conserva el snapshot
etiquetado estimado/Unblended de 4,6195124129 USD, recogido19/09 08:22 UTC para1–18/09.
No se crearon instancias, secretos o conexiones clínicas en este corte.


## Preparación clínica y corte cancelado a las14:30 UTC

La candidata incorpora el operador explícito de las nueve DDL, respaldo cifrado
con persistencia previa a DDL, prueba real de restauración aislada y recuperación
selectiva de participantes. Datos clínicos observados: una conexión y42 activos,
con dependencia WhatsApp compartida. No se han copiado sus tokens a evidencia.

El intento se canceló al empezar un job de reseñas mientras se detenían las dos
unidades independientes WhatsApp. La recuperación reinició indebidamente las API;
el job terminó con dos intentos. Corregido ese comportamiento y probado con cuatro
casos en DEV/candidata. No se ejecutó DDL ni respaldo clínico. Contratos públicos,
huellas de filas, histórico gateway y login anónimo real comprobados después;
MFA/gates/configuración intactos. Revisar coordinación de admisión/parada antes de
otro intento; no reusar planes históricos ni repetir el coordinador ya cancelado.
Detalles, límites y evidencias en [corte clínico](meta-clinical-schema.md).
