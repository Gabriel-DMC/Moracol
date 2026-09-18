# Mercado Pago Argentina: pagos únicos

Plus: ARS 2.000 / 7 días. Pro: ARS 6.000 / 30 días. Anual: ARS 60.000 / 365 días.
No se crean suscripciones de Mercado Pago ni débitos automáticos. Se puede volver a pagar al vencer el plan. El importe, duración, moneda y usuario se establecen en el servidor. Se conserva el historial y los planes manuales existentes.

## Configuración (Cloudflare Pages → Settings → Variables and Secrets)

Nunca guardar credenciales en GitHub, el HTML ni un mensaje de chat.

| Nombre | Tipo | Valor |
| --- | --- | --- |
| `MP_ACCESS_TOKEN` | Secret | Access Token de la aplicación Checkout Pro |
| `MP_WEBHOOK_SECRET` | Secret | Clave secreta generada en Webhooks de esa aplicación |
| `MP_COLLECTOR_ID` | Variable | ID numérico de la cuenta vendedora utilizada por ese token |
| `APP_URL` | Variable | Origen HTTPS exacto, sin ruta, por ejemplo `https://moracol.pages.dev` |
| `MP_MODE` | Variable | `test` para pruebas; `live` para producción |
| `MP_TEST_UID` | Variable | UID Firebase de la cuenta de prueba autorizada; obligatorio en modo test |
| `PAYMENTS_ENABLED` | Variable | `false` hasta terminar las pruebas; después `true` |
| `PAYMENTS_LEGAL_READY` | Variable | `true` solo después de publicar términos y privacidad definitivos; obligatorio para cobros reales |

Con variables ausentes o incompletas, el sistema no permite iniciar pagos. Cambiar variables requiere un nuevo despliegue de Pages. Mantener el binding D1 `DB` existente; no ejecutar DROP ni borrar datos. La tabla adicional `billing_orders` se crea automáticamente de forma no destructiva cuando se usa el pago.

## Pruebas antes de habilitar cobros

1. Crear/configurar una aplicación Checkout Pro en [Mercado Pago Developers](https://www.mercadopago.com.ar/developers/panel/app).
2. Utilizar un despliegue de prueba con D1 y usuarios Firebase de prueba separados; configurar `APP_URL` con ese origen. No compartir el D1 de producción para pruebas.
3. Configurar las credenciales y cuentas de prueba conforme a la documentación actual de Mercado Pago. `MP_COLLECTOR_ID` debe coincidir con el vendedor de prueba. Autorizar únicamente su `MP_TEST_UID`.
4. En la aplicación de Mercado Pago, habilitar el evento **Pagos** y la URL HTTPS `APP_URL/api/payments/webhook`; guardar la clave secreta como `MP_WEBHOOK_SECRET`. El servidor exige `x-signature`, `x-request-id` y `data.id`.
5. Habilitar `PAYMENTS_ENABLED=true` únicamente en el entorno de prueba. Usar compradores y medios de pago de prueba, nunca tarjetas reales. Confirmar aprobación, rechazo, pendiente, reintentos, vencimiento y reversión. En test se utiliza `sandbox_init_point` y se exige `live_mode=false`.
6. Las pruebas locales son `node tests/measurement.mjs` y `node tests/billing.mjs` (Node 24). No verifican las credenciales reales, la entrega de Webhooks ni un pago de extremo a extremo: esas comprobaciones quedan pendientes hasta configurar Mercado Pago.

## Activación de producción

Publicar primero los documentos legales y datos del responsable, sin inventar condiciones comerciales o de devolución. Revisar las obligaciones aplicables. Cambiar a credenciales y vendedor reales, `APP_URL=https://moracol.pages.dev`, `MP_MODE=live`, `PAYMENTS_LEGAL_READY=true`. Habilitar `PAYMENTS_ENABLED=true` únicamente con autorización del titular después de probar la integración. Configurar el Webhook de producción y redesplegar.

La URL de retorno no acredita pagos. El servidor consulta `/v1/payments/{id}` y comprueba titular receptor, importe exacto, ARS, modo y orden. La activación se realiza mediante transacción D1 e identificador único por orden; repetir una notificación no agrega días. Una reversión completa o contracargo invalida solo el acceso correspondiente, sin emitir reembolsos ni modificar planes manuales. Conservar las credenciales para procesar pagos pendientes/reversiones aunque se deshabiliten nuevos cobros.

Fuentes: [Preferencias Checkout Pro](https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-pro-preferences/create-preference/post), [consulta de pagos](https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-pro-preferences/get-payment/get), [Webhooks](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/additional-content/notifications/webhooks), [secretos Pages Functions](https://developers.cloudflare.com/pages/functions/bindings/#environment-variables).
