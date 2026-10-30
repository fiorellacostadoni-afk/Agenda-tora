import {
  adminClient,
  applyVerifiedPayment,
  fetchPaymentDetails,
  getSellerToken,
  json,
  requestBookingNotification,
  verifyWebhookSignature,
} from "../_shared/mercadopago.ts";

Deno.serve(async (request) => {
  if (request.method !== "POST" && request.method !== "GET") return json({ error: "Método no permitido." }, 405);
  const secret = Deno.env.get("MP_WEBHOOK_SECRET");
  if (!secret) return json({ error: "Webhook no configurado." }, 503);
  const url = new URL(request.url);
  const queryId = url.searchParams.get("data.id") || "";
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const bodyId = String(body?.data?.id || "");
  const dataId = queryId || bodyId;
  if (!dataId || (queryId && bodyId && queryId !== bodyId)) return json({ error: "Notificación inválida." }, 400);
  if (!await verifyWebhookSignature(request, dataId, secret)) return json({ error: "Firma inválida." }, 401);
  const eventType = String(body?.type || url.searchParams.get("type") || url.searchParams.get("topic") || "");
  if (eventType && eventType !== "payment") return json({ status: "ignored" });

  try {
    const admin = adminClient();
    const sellerUserId = String(body?.user_id || url.searchParams.get("user_id") || "");
    if (!sellerUserId) return json({ error: "Falta identificar la cuenta vendedora." }, 400);
    const { data: connection, error: connectionError } = await admin.from("mercado_pago_cuentas")
      .select("negocio_id,mp_user_id,access_token,refresh_token,token_expires_at,live_mode")
      .eq("mp_user_id", sellerUserId).limit(1).maybeSingle();
    if (connectionError || !connection) return json({ error: "No se encontró la cuenta conectada." }, 503);
    const { accessToken } = await getSellerToken(admin, connection);
    const payment = await fetchPaymentDetails(dataId, accessToken);
    const { data: bookingPayment, error: paymentError } = await admin.from("pagos_turnos")
      .select("turno_id").eq("external_reference", String(payment.external_reference || "")).maybeSingle();
    if (paymentError) return json({ error: "No se pudo consultar la operación de pago." }, 503);
    if (!bookingPayment) return json({ status: "ignored" });
    const status = await applyVerifiedPayment(admin, payment, connection);
    if (status === "aprobado" && !(await requestBookingNotification(bookingPayment.turno_id, "payment_approved"))) {
      console.error("El pago quedó aprobado, pero el aviso al negocio sigue en la cola de notificaciones.");
    }
    return json({ status: "processed", payment_status: status });
  } catch (error) {
    console.error("No se pudo procesar el webhook de Mercado Pago.", error instanceof Error ? error.message : "unknown");
    return json({ error: "No se pudo conciliar la notificación." }, 503);
  }
});
