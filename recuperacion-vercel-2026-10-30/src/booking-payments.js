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
    let detail;
    try { detail = await result.error.context?.clone().json(); } catch { /* The browser may have blocked the response. */ }
    if (detail?.status === 'aprobado') return detail;
    throw new Error(detail?.error || 'No pudimos preparar el pago. Podés volver a intentarlo o comunicarte con el negocio.');
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
