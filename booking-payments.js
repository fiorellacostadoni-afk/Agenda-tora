(function (root) {
  'use strict';

  const money = value => new Intl.NumberFormat('es-AR', {
    style: 'currency', currency: 'ARS', maximumFractionDigits: 2,
  }).format(Number(value) || 0);

  function paymentTerms(catalog, service) {
    const mode = catalog?.modalidad_pago || 'local';
    const total = Math.round(Number(service?.precio || 0) * 100) / 100;
    const percent = Number(catalog?.porcentaje_senia ?? 15);
    const fixed = catalog?.tipo_senia === 'fijo';
    const requested = mode === 'total' ? total : fixed
      ? Number(catalog?.monto_senia || 0) : total * percent / 100;
    const amount = Math.round((requested + Number.EPSILON) * 100) / 100;
    const required = mode === 'sena' || mode === 'total';
    const online = required && catalog?.cobro_online_disponible === true;
    const valid = Number.isFinite(total) && Number.isFinite(amount) && amount > 0 && amount <= total;
    return {
      mode, total, amount, percent, fixed, required, online, valid,
      balance: Math.max(0, Math.round((total - amount) * 100) / 100),
      label: mode === 'sena' ? 'Seña requerida' : 'Pago completo',
      submitLabel: online ? (mode === 'sena' ? 'Solicitar turno y pagar seña' : 'Solicitar turno y pagar') : 'Solicitar turno',
      payLabel: mode === 'sena' ? 'Pagar seña con Mercado Pago' : 'Pagar con Mercado Pago',
    };
  }

  function isCheckoutUrl(value) {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && /(^|\.)mercadopago\.com(\.ar)?$/i.test(url.hostname);
    } catch { return false; }
  }

  async function responseData(result) {
    if (!result.error) return result.data;
    const context = result.error.context;
    const status = Number(context?.status || 0);
    let detail = null;
    try {
      if (typeof context?.clone === 'function') {
        const response = context.clone();
        const contentType = response.headers?.get?.('content-type') || '';
        if (contentType.includes('json')) detail = await response.json();
      }
    } catch { /* Use safe fallback below. */ }
    if (detail?.status === 'aprobado') return detail;
    // Never reveal tokens, raw backend traces or private payment data in client error messages.
    if (status === 404) throw new Error('El sistema de pagos todavía no está disponible (función del servidor no encontrada). El negocio debe revisar la configuración de Mercado Pago.');
    if (status === 401 || status === 403) throw new Error('El servidor de pagos rechazó la autorización. El administrador debe revisar la configuración de Supabase.');
    if (status >= 500) throw new Error('El servidor de pagos tuvo un problema temporal. No realices otra reserva: consultá con el negocio.');
    if (!status && /fetch|network|failed to send/i.test(result.error.message || '')) throw new Error('No pudimos conectarnos al servidor de pagos. Revisá tu conexión y volvé a intentar.');
    const serverMessage = typeof detail?.error === 'string' ? detail.error : '';
    const safeMessages = ['El negocio todavía no habilitó el pago online.', 'El pago online no está configurado.', 'Mercado Pago no está conectado.'];
    throw new Error(safeMessages.includes(serverMessage) ? serverMessage : 'No pudimos preparar el pago (servidor de pagos). El negocio debe revisar la integración con Mercado Pago.');
  }

  function createCheckoutFlow({ invoke, onChange }) {
    let inFlight = null;
    return {
      async checkAvailability() {
        const data = await responseData(await invoke('mercadopago-create-checkout', { body: { action: 'availability' } }));
        if (data?.available !== true) throw new Error(data?.message || 'El negocio todavía no habilitó el pago online. Comunicate para coordinar la seña.');
      },
      prepare(turnoId) {
        if (inFlight) return inFlight;
        onChange({ status: 'loading' });
        inFlight = Promise.resolve().then(async () => {
          try {
            const data = await responseData(await invoke('mercadopago-create-checkout', { body: { turno_id: turnoId } }));
            if (data?.status === 'aprobado') {
              onChange({ status: 'approved', data });
              return;
            }
            if (!isCheckoutUrl(data?.checkout_url)) throw new Error('El enlace de pago todavía no está disponible. Volvé a intentarlo en unos segundos.');
            const total = Number(data.amount_total), amount = Number(data.amount_to_pay);
            if (!Number.isFinite(total) || !Number.isFinite(amount) || amount <= 0 || amount > total) {
              throw new Error('No pudimos verificar el importe del pago. Comunicate con el negocio.');
            }
            onChange({ status: 'ready', url: data.checkout_url, total, amount,
              balance: Math.max(0, Math.round((total - amount) * 100) / 100), expiresAt: data.expires_at });
          } catch (error) {
            onChange({ status: 'failed', message: error.message || 'No pudimos preparar el pago.' });
          }
        }).finally(() => { inFlight = null; });
        return inFlight;
      },
    };
  }

  root.TusTurnaBookingPayments = { money, paymentTerms, isCheckoutUrl, createCheckoutFlow };
})(typeof window === 'undefined' ? globalThis : window);
