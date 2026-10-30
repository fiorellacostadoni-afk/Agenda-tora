import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { verifyWebhookSignature } from '../supabase/functions/_shared/webhook-signature.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

function loadBookingPayments() {
  const sandbox = { URL, Intl, Number, Promise, Error, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read('booking-payments.js'), sandbox, { filename: 'booking-payments.js' });
  return sandbox.TusTurnaBookingPayments;
}

test('does not call checkout when the booking capability is missing', async () => {
  const payments = loadBookingPayments();
  let invoked = 0;
  let state;
  const flow = payments.createCheckoutFlow({
    invoke: async () => { invoked++; return { data: {}, error: null }; },
    onChange: (next) => { state = next; },
  });

  await flow.prepare('d8b1a452-e3c7-4eaa-8ab2-6a1a2a9c6001');
  assert.equal(invoked, 0);
  assert.equal(state.status, 'failed');
});

test('sends the reservation ID and capability, then accepts only a Mercado Pago URL and sane amounts', async () => {
  const payments = loadBookingPayments();
  const turnoId = 'd8b1a452-e3c7-4eaa-8ab2-6a1a2a9c6001';
  const token = 'a'.repeat(96);
  let call;
  let state;
  const flow = payments.createCheckoutFlow({
    invoke: async (name, options) => {
      call = { name, body: options.body };
      return { data: {
        checkout_url: 'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=fixture',
        amount_total: 10000,
        amount_to_pay: 1500,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }, error: null };
    },
    onChange: (next) => { state = next; },
  });

  await flow.prepare(turnoId, token);
  assert.equal(call.name, 'mercadopago-create-checkout');
  assert.equal(call.body.turno_id, turnoId);
  assert.equal(call.body.checkout_token, token);
  assert.equal(state.status, 'ready');
  assert.equal(state.amount, 1500);
  assert.equal(state.balance, 8500);
});

test('creates a booking capability atomically and never grants it to public database roles', () => {
  const migration = read('supabase/migrations/20261030204941_checkout_capability_for_public_bookings.sql');
  assert.match(migration, /create schema if not exists private/i);
  assert.match(migration, /sha256\(/i);
  assert.match(migration, /public\.reservar_turno_publico\(/i);
  assert.match(migration, /insert into private\.turno_checkout_capabilities/i);
  assert.match(migration, /from PUBLIC, anon, authenticated;[\s\S]*grant execute on function public\.reservar_turno_con_checkout_publico[\s\S]*to anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.agenda_tora_validar_checkout_capacidad\(uuid, text\)[\s\S]*to service_role/i);
  assert.match(migration, /c\.attempts < 20/i);
  assert.doesNotMatch(migration, /update\s+public\.turnos/i);
});

test('checkout validates the capability before reading booking or seller data', () => {
  const edge = read('supabase/functions/mercadopago-create-checkout/index.ts');
  const validation = edge.indexOf('agenda_tora_validar_checkout_capacidad');
  const bookingRead = edge.indexOf('admin.from("turnos")');
  assert.ok(validation >= 0 && bookingRead > validation);
  assert.match(edge, /checkout_token/);
  assert.match(edge, /authorized !== true/);
});

test('webhook signature matches Mercado Pago HMAC manifest and rejects tampering', async () => {
  const secret = 'local-fixture-webhook-secret';
  const paymentId = '9988776655';
  const requestId = 'fixture-request-001';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const manifest = `id:${paymentId};request-id:${requestId};ts:${timestamp};`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signatureBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest)));
  const signature = [...signatureBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const request = new Request('https://example.test/webhook', {
    headers: { 'x-request-id': requestId, 'x-signature': `ts=${timestamp},v1=${signature}` },
  });

  assert.equal(await verifyWebhookSignature(request, paymentId, secret), true);
  assert.equal(await verifyWebhookSignature(request, '9988776656', secret), false);
});

test('webhook fetches the signed payment and applies only provider-verified state', () => {
  const webhook = read('supabase/functions/mercadopago-webhook/index.ts');
  const signatureCheck = webhook.indexOf('verifyWebhookSignature(request');
  const paymentFetch = webhook.indexOf('fetchPaymentDetails(dataId');
  const apply = webhook.indexOf('applyVerifiedPayment(admin, payment, connection)');
  assert.ok(signatureCheck >= 0 && paymentFetch > signatureCheck && apply > paymentFetch);
  const shared = read('supabase/functions/_shared/mercadopago.ts');
  assert.match(shared, /agenda_tora_aplicar_pago_mercado_pago/);
  assert.match(shared, /p_estado: String\(payment\.status/);
  assert.match(shared, /p_live_mode: Boolean\(payment\.live_mode/);
});

test('Vercel preview uses only the fixture and fails closed before creating a Supabase client', () => {
  const html = read('index.html');
  const guard = html.indexOf('__TUSTURNA_PREVIEW_FIXTURE_READY__');
  const client = html.indexOf('window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY)');
  assert.ok(guard >= 0 && client > guard);
  assert.match(html, /payment-fixture\.js/);
  assert.match(read('payment-fixture.js'), /__TUSTURNA_PREVIEW_FIXTURE_READY__=true/);
});

test('all inline application scripts parse as JavaScript', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length >= 2);
  scripts.forEach((script, index) => new vm.Script(script, { filename: `index-inline-${index + 1}.js` }));
});
