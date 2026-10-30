# TusTurna — autorización segura de pagos públicos

## Implementación preparada en `feature/tusturna-pwa`

El checkout público usa una capacidad temporal asociada a la reserva:

- `reservar_turno_con_checkout_publico(...)` reutiliza la reserva pública existente y, dentro de la misma transacción, guarda un hash SHA-256 de un secreto aleatorio en el esquema privado.
- El secreto original vuelve una sola vez al navegador que acaba de reservar. No se guardan datos personales adicionales en la función de checkout.
- `mercadopago-create-checkout` exige el token, valida su formato y lo verifica en la base antes de leer la reserva o preparar el pago.
- La capacidad vence a los 30 minutos o al comenzar el turno, lo que ocurra primero, y acepta como máximo 20 verificaciones.
- Las reservas anteriores no se actualizan ni reciben tokens retroactivos. No se puede iniciar un checkout público para ellas con solo el ID.
- Los flujos de reserva local y transferencia conservan sus RPC existentes.

El webhook conserva la verificación de firma de Mercado Pago y consulta los detalles del pago al servidor del proveedor antes de invocar la conciliación idempotente existente.

## Pruebas y despliegue

La rama incluye pruebas automatizadas de autorización del frontend, firma del webhook y condiciones de seguridad de la migración. La vista de Vercel Preview carga el fixture local, no Supabase ni Mercado Pago.

La función y la migración todavía no se aplicaron a Supabase. El proyecto conectado no permite crear ramas de desarrollo en su plan actual; por eso no se usó el proyecto compartido para evitar cambiar el backend de producción. El vendedor conectado informa `live_mode=true`, así que no se iniciaron pagos ni se generaron preferencias reales.
