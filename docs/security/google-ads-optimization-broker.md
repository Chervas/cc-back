# Optimiza Google Ads: escritor aislado

## Estado 2026-09-28

Motor y contratos preparados en fuente DEV, con pruebas ficticias de transporte,
HTTPS, firma, SQLite y auditoria. **No instalado ni conectado al ejecutor CRM.**
El bloqueo `workspace_optimization_service_pending` del ejecutor se conserva.
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

## Responsabilidades pendientes y limites

- Integrar el cliente escritor con identidad separada en el ejecutor actual;
  hoy `credentialsFor`/`mutateOptimizationChange` NO lo usan.
- Conservar grant original, mandato/ACL/seleccion, lease, recepcion, evidencia
  madura o recomendacion CPA/ROAS vigente y su relectura final. Un UUID y una
  huella no demuestran al broker que esa evidencia exista en el CRM.
- Mantener la contabilidad mensual de todas las campanas seleccionadas y su
  reserva transaccional antes de enviar. El limite diario del broker NO sustituye
  la previsibilidad mensual ni el presupuesto autorizado por el usuario.
- Persistir el mismo executionId y payload antes del envio CRM, conciliar los
  acuses y hacer readback tipado. Probar revocacion/rebind durante toda la ruta.
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

La construccion REST sigue los [ejemplos oficiales de Google Ads](https://developers.google.com/google-ads/api/rest/examples):
actualizaciones con mascara explicita y operaciones sin fallos parciales. La
version fijada conserva la v24 del transporte existente; este corte no cambia
la version de todos los consumidores ni ejecuta los ejemplos contra una cuenta.
