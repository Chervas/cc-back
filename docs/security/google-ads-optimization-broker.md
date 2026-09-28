# Optimiza Google Ads: escritor aislado

## Estado 2026-09-28

Motor, cliente tipado y ejecutor CRM conectados en fuente DEV, con pruebas
ficticias de transporte, HTTPS, firma, SQLite y auditoria. **No instalado ni
habilitado para cuentas reales.** Sin configuracion/permiso escritor independiente
el ejecutor conserva `workspace_optimization_service_pending` antes de enviar.
No se han creado permisos/configuraciones reales, migrado credenciales, abierto
gates, reiniciado servicios ni llamado a Google, Meta o AWS.

Antecedentes: [lecturas tipadas](google-ads-read-broker.md) y
[estado de campanas](../campaign-workspace-implementation.md). Este documento
no habilita el Plan Gestionado, conversiones, anuncios nuevos ni exclusiones.

## Configuracion separada

Solo la nueva cohorte `google-ads-optimization-v1` del runtime `google-main.js`
registra `google.ads.optimization.apply.v1` y `google.ads.optimization.status.v1`.
Las cohortes existentes de lectura/conversiones rechazan este contrato. No hay
alta OAuth ni enrollment de cuentas en esta cohorte.

Cada binding requiere `googleAdsOptimization.accounts`: asset registrado, lista
explicita de campanas y tipos de ajuste permitidos. Por campana se fijan limites
absolutos `maxBidMicros`, `maxTargetRoas`, `maxDailyBudgetMicros` y el permiso
`allowBudgetIncrease`. Los limites no usados deben ser null. Un incremento de
presupuesto requiere ese permiso adicional; un mandato CRM no lo concede.
Cuenta, gestor, sujeto Google y referencias Secrets Manager provienen del binding.

El principal y la clave de firma de apply/status deben ser distintos de los de
lectura/control. No basta otro keyId con la misma clave. Los grants siguen siendo
por clinica, conexion, activo y operacion. Una cuenta nueva descubierta por el
lector nunca se incorpora automaticamente a esta lista de escritura.

El consumidor CRM carga el cliente escritor de forma diferida, exclusivamente
con `GOOGLE_ADS_OPTIMIZATION_BROKER_ENABLED=true` y las variables de prefijo
`GOOGLE_ADS_OPTIMIZATION_BROKER_`: `ORIGIN`, `AUDIENCE`, `KEY_ID`, `KEY_FILE`,
`CA_FILE`. Tambien exige la identidad configurada del lector
`GOOGLE_ADS_BROKER_KEY_ID/KEY_FILE` para rechazar la misma clave criptografica,
aunque tenga otro nombre/ruta. Ficheros privados y validacion TLS existentes;
ninguna variable contiene tokens del proveedor. Conserva los gates generales
`CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED` y `CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED`.
No se ha configurado ninguna de estas nuevas variables en runtime.

La identidad del escritor liga origen, audiencia, keyId, clave publica y CA.
Cambiarla no permite recuperar un intento anterior como si fuera el mismo
escritor. Un cambio de ficheros de clave requiere reinicio controlado, como el
lector actual; no hay rotacion implicita ni alternancia automatica de claves.

## Comando acotado

Apply admite exclusivamente `executionId`, `mandateId` (UUID v4),
`evidenceFingerprint` (SHA-256), `expiresAt`, `campaignId`, `kind`, `resourceId`,
`adGroupId`, `baselineAdId`, `before`, `after`. Los dos IDs de grupo/baseline son
null salvo pausa de anuncio. Status solo recibe `executionId` y exige tambien
el permiso apply actual sobre ese mismo activo.

| Tipo | Unico campo modificado | Restriccion |
|---|---|---|
| `pause_ad` | `adGroupAd.status` | ENABLED -> PAUSED; otro anuncio concreto debe seguir apto en el mismo grupo |
| `manual_cpc` | `adGroup.cpcBidMicros` | Solo bajar CPC manual existente |
| `target_cpa` | `campaign.targetCpa.targetCpaMicros` | Solo subir el objetivo existente |
| `maximize_conversions_cpa` | `campaign.maximizeConversions.targetCpaMicros` | Solo subir el objetivo existente |
| `target_roas` | `campaign.targetRoas.targetRoas` | Solo bajar el objetivo existente |
| `maximize_conversion_value_roas` | `campaign.maximizeConversionValue.targetRoas` | Solo bajar el objetivo existente |
| `daily_budget` | `campaignBudget.amountMicros` | Presupuesto diario exclusivo; incremento solo con permiso explicito |

Los ajustes numericos no superan el 10% y respetan el limite absoluto. Importes
en micros como cadenas exactas, ROAS con hasta seis decimales. No acepta query,
URL, metodo, cabeceras, token, manager, mask, create/remove o cuerpo del proveedor.
El broker fabrica una unica operacion update y un unico updateMask; transporte
TLS fijo v24, `partialFailure=false`, `RESOURCE_NAME_ONLY`, sin redirecciones
ni reintentos. El transporte de lectura mantiene la escritura deshabilitada.

Antes de reservar envio, consulta metadata cerrada: cuenta EUR/Madrid, campana
activa BASE Search/PMax, baseline exacta y recurso perteneciente a esa campana.
Pausa/CPC solo Search; pausa requiere ambos anuncios activos, ELIGIBLE y APPROVED.
CPA/ROAS rechazan portfolio, presupuesto compartido y overrides de grupo.
Presupuesto exige DAILY, una sola referencia y recurso coincidente. Paginas
incompletas, duplicadas o con cursor ciclico se rechazan; maximo 2.000 filas.
Relee metadata antes del marcador duradero. TTL maximo 60s con comprobaciones
antes/despues de lecturas; retroceso de reloj o retirada de acceso bloquean.

## Recibos, incertidumbre y recuperacion

SQLite crea de forma aditiva `google_optimization_mutations` y
`google_optimization_locks` solo al construir este motor. Antes de HTTP guarda
el executionId, hash de payload/alcance, principal y bloqueo por cuenta/campana,
con transaccion IMMEDIATE y persistencia FULL. Dos instancias usando el mismo
fichero no pueden reservar simultaneamente esa campana.

El acuse debe identificar exactamente el recurso esperado. Recibo aplicado,
liberacion del bloqueo y auditoria se confirman en la misma transaccion que el
resultado del comando firmado. No se guardan tokens ni el payload completo.
Status no recupera secretos ni llama al proveedor. Un recibo representa un acuse
historico, no garantiza que el estado actual siga coincidiendo.

Timeout, respuesta perdida/no valida, revocacion posterior o fallo de auditoria
dejan el intento como desconocido y mantienen el bloqueo, incluso tras reinicio.
No se reenvia con el mismo executionId ni creando otro. Un UUID aplicado devuelve
el recibo original, sin repetir HTTP de escritura. Rebind de sujeto, referencias,
politica de cuenta o clave no permite reutilizar/exponer recibos anteriores.
Cooldown duradero de 24h por grupo para pausa y 336h por campana/accion para
puja/presupuesto; cambiar UUID, principal o binding no evita esos plazos.

No hay desbloqueo automatico ni herramienta de conciliacion instalada en este
corte. No borrar filas/locks para reintentar. El futuro reconciliador debera
contrastar estado/historial, conservar el executionId original y auditar una
resolucion autorizada. Una lectura coincidente por si sola no atribuye autoria.

## Integracion con el ejecutor CRM

`googleAdsOptimizationBrokerClient.service` acepta solo apply/status y proyecta
recibos acotados. `campaignWorkspaceOptimizationBrokerExecution.service` crea
una capacidad privada ligada a un run y a su grant opaco original. Antes de
preparar envio consulta status sin secretos; una identidad ya utilizada exige
revision, no se reutiliza como un nuevo intento.

Se conservan ACL, clinica, seleccion, mandato, lease, recepcion comprobada,
evidencia madura y baseline especifica CPA/ROAS mediante lectores tipados.
Presupuestos siguen recopilando todas las campanas seleccionadas y reservando
contabilidad mensual en transaccion. El cap diario del broker no la sustituye.

La misma transaccion CRM confirma `submitted_at`, la reserva mensual cuando
corresponde y `outcome.broker_submission`: version 1, huella de autoridad y
payload inmutable (incluido executionId original y caducidad). Reutiliza el JSON
existente, sin nueva migracion SQL. No contiene secretos ni se publica en el DTO
del historial. El cliente exige commit confirmado antes de enviar apply y
comprueba grant/mandato/lease/autoridad antes y despues del transporte y en la
transaccion final. Un marcador broker no puede cargar tokens legacy aunque
durante la recuperacion cambie el modo de conexion.

Perdida del acuse SQL: no se envia. Perdida del acuse del consumidor: status
puede recuperar el recibo aplicado, y solo con readback coincidente se confirma
verified. Status unknown/not_found nunca repite apply ni acredita autoria,
aunque el valor deseado pueda leerse. El marcador se conserva ante errores,
revocacion y recuperacion denegada. El cierre manual antiguo del CRM esta
bloqueado para estos intentos: no puede liberar el lock desconocido del broker.

## Responsabilidades pendientes y limites

- Implementar conciliacion autorizada de intentos desconocidos, con trazabilidad
  CRM/broker; no resolverlos borrando filas ni usando otra clave/UUID.
- Publicacion compatible y QA real siguen pendientes. No basta instalar este
  codigo: hacen falta principal/clave/grants propios expresamente autorizados.
- La evidencia de negocio se verifica en CRM. Un UUID y una huella no demuestran
  por si solos al broker que esa evidencia exista; no abrir un proxy generico
  ni permitir que la interfaz construya comandos arbitrarios.
- La metadata releida no es un compare-and-swap del proveedor: terceros pueden
  editar en el intervalo entre lectura y escritura. No se promete exclusion
  atomica frente a Ads Manager u otras aplicaciones.
- Exclusiones requieren politica de relevancia; Meta publicitario sigue cerrado.
  Publicacion y activacion reales necesitan un corte autorizado, no este push.

QA enfocada: 49 pruebas, incluidas siete clases de ajuste, inyecciones, caps,
preflight, TTL, revocacion, error/acuse perdido, SQLite reabierto, concurrencia
entre conexiones, precision decimal sin redondeo, cooldown, firma y runtime HTTPS local. Google/AWS ficticios;
no es validacion con la cuenta Dental - Parallel Campaign. Evidencia y regresion
completa en el corte correspondiente de `campaign-workspace-implementation.md`.

El corte de integracion CRM anade pruebas de las siete clases con el ejecutor,
reserva mensual, grants, firma y SQLite; modelos CRM/proveedores ficticios. La
regresion final suma 1.279 pruebas backend y 866 broker correctas. HTTPS local confirma que
conflicto, caducidad y cooldown llegan al CRM como codigos acotados, sin detalle
del proveedor. Los controles nuevos no cambian permisos ni configuracion activa.

La construccion REST sigue los [ejemplos oficiales de Google Ads](https://developers.google.com/google-ads/api/rest/examples):
actualizaciones con mascara explicita y operaciones sin fallos parciales. La
version fijada conserva la v24 del transporte existente; este corte no cambia
la version de todos los consumidores ni ejecuta los ejemplos contra una cuenta.
