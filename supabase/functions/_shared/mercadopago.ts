import { createClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

export function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("Supabase no está configurado en la función.");
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function requestBookingNotification(turnoId: string, event: string) {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return false;
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/functions/v1/send-booking-notification`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ turno_id: turnoId, event }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getAuthenticatedUser(request: Request, admin: ReturnType<typeof adminClient>) {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const { data, error } = await admin.auth.getUser(authorization.slice(7));
  return error ? null : data.user;
}

export async function getSellerToken(admin: ReturnType<typeof adminClient>, connection: Record<string, unknown>) {
  const clientId = Deno.env.get("MP_CLIENT_ID");
  const clientSecret = Deno.env.get("MP_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Mercado Pago todavía no está configurado.");
  const expiry = Date.parse(String(connection.token_expires_at || ""));
  if (Number.isFinite(expiry) && expiry > Date.now() + 5 * 60_000) {
    return { accessToken: String(connection.access_token), connection };
  }
  const response = await fetch("https://api.mercadopago.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: connection.refresh_token,
    }),
  });
  if (!response.ok) throw new Error("No se pudo renovar la conexión de Mercado Pago.");
  const token = await response.json();
  if (!token.access_token || !token.refresh_token || !token.expires_in) {
    throw new Error("Mercado Pago devolvió una respuesta de renovación incompleta.");
  }
  const updated = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_expires_at: new Date(Date.now() + Number(token.expires_in) * 1000).toISOString(),
    mp_user_id: String(token.user_id || connection.mp_user_id),
    live_mode: typeof token.live_mode === "boolean" ? token.live_mode : connection.live_mode,
    actualizado_en: new Date().toISOString(),
  };
  const { error } = await admin.from("mercado_pago_cuentas")
    .update(updated).eq("negocio_id", connection.negocio_id);
  if (error) throw new Error("No se pudo guardar la renovación de Mercado Pago.");
  return { accessToken: String(token.access_token), connection: { ...connection, ...updated } };
}

export async function applyVerifiedPayment(
  admin: ReturnType<typeof adminClient>,
  payment: Record<string, unknown>,
  connection: Record<string, unknown>,
) {
  if (String(payment.collector_id) !== String(connection.mp_user_id)) {
    throw new Error("El pago pertenece a otra cuenta de Mercado Pago.");
  }
  if (Boolean(payment.live_mode) !== Boolean(connection.live_mode)) {
    throw new Error("El ambiente del pago no coincide con la cuenta conectada.");
  }
  const { data, error } = await admin.rpc("agenda_tora_aplicar_pago_mercado_pago", {
    p_external_reference: String(payment.external_reference || ""),
    p_pago_mp_id: String(payment.id || ""),
    p_estado: String(payment.status || ""),
    p_monto: Number(payment.transaction_amount),
    p_moneda: String(payment.currency_id || ""),
    p_mp_user_id: String(payment.collector_id),
    p_live_mode: Boolean(payment.live_mode),
  });
  if (error || !data) throw new Error("No se pudo conciliar el pago verificado.");
  return data as string;
}

export async function fetchPaymentDetails(paymentId: string, accessToken: string) {
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Mercado Pago no pudo verificar el estado del pago.");
  return await response.json() as Record<string, unknown>;
}

export { verifyWebhookSignature } from "./webhook-signature.mjs";

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export async function sha256Hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
