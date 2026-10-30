import { adminClient, getSellerToken, isUuid, json } from "../_shared/mercadopago.ts";

const isCheckoutUrl = (value: unknown) => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)mercadopago\.com(\.ar)?$/i.test(url.hostname);
  } catch { return false; }
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  } });
  if (request.method !== "POST") return json({ error: "Método no permitido." }, 405);
  const baseUrl = Deno.env.get("TUSTURNA_PUBLIC_URL");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const configured = !!(baseUrl && supabaseUrl && Deno.env.get("MP_CLIENT_ID")
    && Deno.env.get("MP_CLIENT_SECRET") && Deno.env.get("MP_WEBHOOK_SECRET"));
  let preparedId: string | null = null;
  let admin: ReturnType<typeof adminClient> | null = null;

  try {
    const body = await request.json().catch(() => ({}));
    if (body.action === "availability") return json({
      available: configured,
      ...(!configured ? { message: "El negocio todavía no habilitó el pago online. Comunicate para coordinar la seña." } : {}),
    });
    const turnoId = body.turno_id;
    if (!isUuid(turnoId)) return json({ error: "Identificador de turno inválido." }, 400);
    const checkoutToken = body.checkout_token;
    if (typeof checkoutToken !== "string" || !/^[0-9a-f]{96}$/i.test(checkoutToken)) {
      return json({ error: "No se pudo autorizar el pago de la reserva." }, 403);
    }
    if (!configured) return json({ error: "El pago online todavía no está habilitado. Comunicate con el negocio." }, 503);
    admin = adminClient();
    const { data: authorized, error: authorizationError } = await admin.rpc("agenda_tora_validar_checkout_capacidad", {
      p_turno_id: turnoId,
      p_checkout_token: checkoutToken,
    });
    if (authorizationError || authorized !== true) {
      return json({ error: "No se pudo autorizar el pago de la reserva." }, 403);
    }
    const { data: appointment, error: appointmentError } = await admin.from("turnos")
      .select("id,negocio_id,servicio:servicios!turnos_servicio_mismo_negocio_fkey(nombre)")
      .eq("id", turnoId).maybeSingle();
    if (appointmentError || !appointment) return json({ error: "No existe esa reserva." }, 404);
    const { data: connection, error: connectionError } = await admin.from("mercado_pago_cuentas")
      .select("negocio_id,mp_user_id,access_token,refresh_token,token_expires_at,live_mode")
      .eq("negocio_id", appointment.negocio_id).maybeSingle();
    if (connectionError || !connection) return json({ error: "Este negocio todavía no conectó Mercado Pago." }, 409);
    const { accessToken, connection: currentConnection } = await getSellerToken(admin, connection);

    // The database reads the current service price and deposit settings; client amounts are ignored.
    const { data: prepared, error: prepareError } = await admin.rpc("agenda_tora_preparar_pago_turno", {
      p_turno_id: turnoId,
    });
    if (prepareError || !prepared) return json({ error: "No se pudo preparar el pago de la reserva." }, 409);
    const amounts = {
      amount_total: prepared.monto_total, amount_to_pay: prepared.monto_cobrar,
      amount_due: prepared.monto_cobrar, expires_at: prepared.expira_en,
    };
    if (prepared.estado === "pendiente" && prepared.init_point && isCheckoutUrl(prepared.init_point)) {
      return json({ status: "pending", checkout_url: prepared.init_point, pago_turno_id: prepared.pago_turno_id, ...amounts });
    }
    if (prepared.estado !== "creando" || prepared.nuevo !== true) {
      return json({
        status: prepared.estado,
        amount_total: prepared.monto_total,
        amount_due: prepared.monto_cobrar,
        pago_turno_id: prepared.pago_turno_id,
      }, prepared.estado === "creando" ? 202 : 409);
    }
    preparedId = String(prepared.pago_turno_id);

    const publicUrl = new URL(baseUrl!);
    if (publicUrl.protocol !== "https:") throw new Error("El dominio público debe usar HTTPS.");
    const paymentReturn = new URL(publicUrl.toString());
    paymentReturn.searchParams.set("pago", String(prepared.pago_turno_id));
    paymentReturn.searchParams.set("reservar", String(appointment.negocio_id));
    const webhookUrl = `${supabaseUrl!.replace(/\/$/, "")}/functions/v1/mercadopago-webhook`;
    const service = Array.isArray(appointment.servicio) ? appointment.servicio[0] : appointment.servicio;
    const amount = Number(prepared.monto_cobrar);
    if (!Number.isFinite(amount) || amount <= 0 || amount > Number(prepared.monto_total)) {
      throw new Error("El importe preparado no es válido.");
    }
    const preferenceResponse = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{
          id: String(prepared.pago_turno_id),
          title: `${prepared.modalidad === "sena" ? "Seña de reserva" : "Pago de reserva"} · ${String(service?.nombre || "Servicio").slice(0, 100)}`,
          quantity: 1,
          currency_id: "ARS",
          unit_price: amount,
        }],
        external_reference: String(prepared.external_reference),
        notification_url: webhookUrl,
        back_urls: {
          success: paymentReturn.toString(),
          pending: paymentReturn.toString(),
          failure: paymentReturn.toString(),
        },
        auto_return: "approved",
        // Cash vouchers can settle after the short appointment hold has expired.
        payment_methods: { excluded_payment_types: [{ id: "ticket" }] },
        expires: true,
        expiration_date_from: new Date().toISOString(),
        expiration_date_to: String(prepared.expira_en),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!preferenceResponse.ok) {
      await admin.from("pagos_turnos").update({ estado: "fallido", actualizado_en: new Date().toISOString() })
        .eq("id", prepared.pago_turno_id).eq("estado", "creando");
      console.error("Mercado Pago no creó la preferencia.", preferenceResponse.status);
      return json({ error: "Mercado Pago no pudo iniciar el cobro. La solicitud de turno quedó guardada." }, 502);
    }
    const preference = await preferenceResponse.json();
    const checkoutUrl = currentConnection.live_mode
      ? preference.init_point
      : (preference.sandbox_init_point || preference.init_point);
    if (!preference.id || !isCheckoutUrl(checkoutUrl)) {
      await admin.from("pagos_turnos").update({ estado: "fallido", actualizado_en: new Date().toISOString() })
        .eq("id", prepared.pago_turno_id).eq("estado", "creando");
      return json({ error: "Mercado Pago devolvió un enlace de pago inválido." }, 502);
    }
    const { data: saved, error: saveError } = await admin.rpc("agenda_tora_guardar_preferencia_pago", {
      p_pago_turno_id: prepared.pago_turno_id,
      p_preferencia_id: String(preference.id),
      p_init_point: checkoutUrl,
    });
    if (saveError || saved !== true) return json({ error: "No se pudo guardar el checkout de forma segura." }, 502);

    return json({
      status: "pending",
      checkout_url: checkoutUrl,
      pago_turno_id: prepared.pago_turno_id,
      amount_total: prepared.monto_total,
      amount_to_pay: prepared.monto_cobrar,
      amount_due: prepared.monto_cobrar,
      expires_at: prepared.expira_en,
    });
  } catch (error) {
    if (admin && preparedId) {
      await admin.from("pagos_turnos").update({ estado: "fallido", actualizado_en: new Date().toISOString() })
        .eq("id", preparedId).eq("estado", "creando");
    }
    console.error("Falló la preparación del checkout.", error instanceof Error ? error.message : "unknown");
    return json({ error: "No se pudo iniciar el pago." }, 500);
  }
});
