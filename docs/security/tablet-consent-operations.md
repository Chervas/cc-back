# Operación de tablet y firma

Contrato vigente desde el 20/09/2026. Manual funcional canónico en frontend
`src/Documentacion/18.15-consentimientos.md`; presupuestos en `18.21`, topología
en `30`/`31`, estado en `19` y evidencia histórica en `99`.

## Entornos y rutas

| Superficie | Frontend | API / datos |
| --- | --- | --- |
| Tablet pública | `https://tablet.clinicaclick.com/tablet`, release de CRM en `/home/ubuntu/www/front-staging` | API staging `3001` |
| Tablet DEV | `http://localhost:4203/tablet`, preview DEV | API aislada `3004`, BD ficticia |

`ops/nginx/tablet.clinicaclick.com.conf` es la configuración publicada. Solo
expone `/api/consentimientos/public/`, `/api/consentimientos/tablet/` y
`/api/economics/public/budget-signatures/`. El resto de `/api/` y Socket.IO
responden 404. Los enlaces con token no se registran en el access log de esas
rutas; sus respuestas no se almacenan en caché y usan `no-referrer`.
El login público tiene límite Nginx de 5 peticiones/minuto/IP, ráfaga de 5 y
rechazo 429. Este límite por IP afecta también a dispositivos tras la misma NAT.

La cola de firmas es una lectura acotada de SQL por clínica (o grupo autorizado
expresamente para consentimientos), actualizada por la
tablet cada 10 segundos. No es una cola BullMQ ni un transporte por el broker.
Consentimientos y presupuestos comparten la pantalla, pero conservan tablas,
estados y evidencias propios. No se acredita una prueba de carga masiva.

## Configuración y PDF

Configurar en el proceso efectivo de cada API:

- CRM: `CONSENT_TABLET_BASE_URL` y `BUDGET_SIGNATURE_PUBLIC_BASE_URL` con
  `https://tablet.clinicaclick.com`.
- DEV: ambas con `http://localhost:4203`. Su sesión humana usa ese origen exacto.
- DEV: `CHROME_PATH=/opt/clinicaclick-browsers/chrome-headless-shell-148/chrome-headless-shell`.
  El servicio conserva `ProtectHome`; no usar un binario bajo `/home/ubuntu`.

El PDF incorpora el logo desde `src/assets/nutrition/brand/clinicaclick-logo-text.svg`
del backend. Conservar ese asset en la release. Probar un PDF real: comprobar que
el proceso existe no demuestra que Chromium pueda generar el documento.
El binario bajo `/opt` es una dependencia del host, no queda instalado por un
push a Git. Mantenerlo actualizado mediante una publicación compatible y repetir
la prueba del PDF al sustituirlo.

## Credenciales y firma

Desde la clínica, editar → tablets → añadir tablet. Entregar la contraseña
generada únicamente al responsable del dispositivo; se muestra una vez.
No regenerar claves existentes para una prueba. Por defecto cada dispositivo
queda limitado a su clínica; su token no concede una sesión del personal ni cruza DEV/CRM.

«Mostrar consentimientos de todo el grupo» se activa por dispositivo desde esa
misma sección, inicialmente desmarcado. Requiere `consents.manage` en todas las
clínicas del grupo. El servidor resuelve la pertenencia y conserva el ID de grupo
autorizado en `ClinicTabletKiosks.consent_group_id`, nullable; no acepta un grupo
arbitrario del cliente. Cola y apertura consultan el alcance vigente en cada
petición. Si la clínica cambia de grupo, el permiso anterior no se transfiere.
Los presupuestos permanecen en la clínica base. Desactivar no revoca enlaces
de firma ya emitidos: conservan su caducidad y el estado de su paquete.

Esquema aditivo: `20260921080000-add-tablet-consent-group-scope.js`, probado primero
en DEV. Operador acotado `src/scripts/cliniccloud-tablet-scope-schema.js`: exige
target explícito, hash revisado de esta única migración, checkout DEV limpio,
diario privado y backup CRM completo/verificado para el target público. No
ejecuta otras migraciones ni amplía ningún acceso. Publicar esquema antes del
modelo; ante rollback de código, conservar la columna aditiva y no restaurar
la BD. La API de alcance solo está en rutas autenticadas de personal, no se
amplía la allowlist Nginx de tablet.

La firma requiere declaración explícita (checkbox inicialmente desmarcado),
nombre, rol y firma PNG. Para menores exige representación y relación. El
backend valida todos los documentos seleccionados antes de iniciar las
escrituras; rechaza paquetes cancelados/caducados, documentos caducados y una
segunda firma cuando no quedan pendientes. Esto no certifica la validez legal
de plantillas ni una transacción global frente a todas las carreras posibles.

Los eventos SQL del documento/presupuesto son evidencia funcional. No confundir
su presencia con cobertura completa del visor de auditoría o recibos externos
S3. La cobertura general mantiene su propio pendiente de seguridad.

## Publicación y aceptación

1. Leer el handoff y confirmar runtime, BD, flags, pausas y revisión publicada.
   Publicar solo los commits aceptados: no reemplazar staging con todo DEV.
2. Preservar assets con hash anteriores e instalar el índice frontend al final.
   La tablet pública y CRM usan la misma raíz; un despliegue frontend afecta a ambos.
3. Validar `nginx -t`, guardar recuperación de la configuración concreta y
   recargar. Esperar a que los nuevos workers sirvan la ruta: con token inválido,
   presupuesto público debe responder 401, no el 404 de ruta ausente.
4. Verificar `/tablet` y assets 200; APIs internas 404. No relajar `ProtectHome`,
   MFA ni aislamiento DEV; no abrir jobs o proveedores para pasar la prueba.
5. Con sesión humana y paciente ficticio sin contacto, enviar dos consentimientos
   desde la ficha, comprobar cola, declaración, trazo de prueba, firma, retorno
   automático al estado firmado y PDF. Repetir con presupuesto de 0 €, sin cobros,
   bonos, documentos fiscales ni envío por email/WhatsApp.
6. Comprobar alta/login/logout de dispositivo propio, aislamiento de clínica y
   entorno, rechazo sin declaración, de caducidad y de reenvío ya firmado. Revisar
   interfaz en horizontal y móvil, incluidas superposiciones de avisos/diálogos.
7. Verificar SQL y retirar solo fixtures propios por ID más identificador público.
   Eliminar primero las dependencias de presupuesto, luego las de consentimiento,
   dispositivos de prueba y paciente. No borrar auditoría general ni reiniciar
   secuencias. Comprobar que enlaces y credenciales retirados dejan de funcionar.

Aceptación del 20/09: recorridos reales en DEV y CRM, creación de dispositivo en
ambos y revisión visual Chromium 1180/390 px; no se usó una tablet física. Pruebas
de regresión: `consent_signature_boundaries.test.js` (19), eventos de firma y
ejecutor de esquema de presupuestos (10). La DDL aditiva ya existía en ambas
bases; se promovió el código de eventos a CRM sin volver a ejecutar DDL.
Evidencia privada en `/home/ubuntu/qa-evidence/tablet-acceptance-20260920`.
No versionar tokens, contraseñas, capturas clínicas ni informes privados.
