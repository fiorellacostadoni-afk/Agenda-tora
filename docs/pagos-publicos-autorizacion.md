# TusTurna — autorización segura de pagos públicos (pendiente de implementación)

## Hallazgo confirmado (30/10/2026)
- `reservar_turno_publico(...)` devuelve únicamente un UUID de turno y no autentica al cliente.
- `agenda_tora_preparar_pago_turno(uuid)` y `agenda_tora_guardar_preferencia_pago(...)` son RPC privilegiados: anon y authenticated no tienen EXECUTE.
- `mercadopago-create-checkout` no está desplegada en Supabase.
- No debe publicarse una Edge Function con service_role que acepte cualquier `turno_id` sin comprobar que la solicitud pertenece al solicitante.
- Tampoco se debe permitir fijar el importe desde el navegador ni publicar tokens de vendedor.

## Diseño seguro para implementar en una rama y entorno de prueba
1. Crear una tabla privada para capacidades de pago, con `turno_id`, `token_hash`, fecha de caducidad, intentos y restricciones de uso. Mantener el token original solo en el cliente que creó el turno; almacenar el hash en la base.
2. Crear una nueva RPC de reserva pública que reutilice la validación y creación actuales dentro de una transacción y devuelva `turno_id` más un secreto aleatorio de un solo uso destinado únicamente a preparar ese pago. La función existente debe mantenerse para flujos que no requieren pago.
3. En el flujo móvil/web con seña, llamar a esa RPC y enviar a `mercadopago-create-checkout` el token de pago junto con el identificador del turno. No transportar nombres ni teléfonos a la función de checkout.
4. En la función Edge, verificar el hash, coincidencia del turno, vigencia, estado pendiente y cantidad de intentos. Rechazar tokens inválidos, expirados o ya consumidos sin dar información del turno.
5. Usar la service role exclusivamente en la función Edge, nunca en el navegador. El servidor invoca `agenda_tora_preparar_pago_turno`, recupera el vendedor asociado a *ese* negocio y calcula el importe desde la BD.
6. Crear una preferencia Checkout Pro con idempotencia y `external_reference` de la operación de pago; guardar el enlace mediante `agenda_tora_guardar_preferencia_pago`.
7. El webhook existente debe verificar firma, vendedor, importe, ambiente y estado antes de confirmar el turno. No confiar en parámetros de regreso del navegador.
8. Revisar la configuración CORS de los orígenes publicados, OAuth, variables secretas, políticas de privacidad y eventos de error. Probar cancelaciones, duplicados, expiración y pagos tardíos en sandbox.
9. No implementar ni modificar en producción hasta comprobar pruebas y contar con aprobación de despliegue.

## Estado
Documento técnico solamente: no habilita pagos, no modifica la base de datos y no sustituye la función que falta.
