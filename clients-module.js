(function () {
  'use strict';

  const runtime = () => window.tusturnaClientsRuntime?.();
  const $ = (id) => document.getElementById(id);
  let clients = [];
  let manualPayments = [];
  let reschedules = [];

  function tier() {
    const business = runtime()?.business;
    const value = String(business?.plan_actual ?? business?.plan ?? business?.plan_codigo ?? 'gratis').toLowerCase();
    if (value.includes('equipo') || value.includes('team')) return 'equipo';
    if (value.includes('inicial') || value.includes('initial')) return 'inicial';
    return 'gratis';
  }

  function normalize(value) {
    return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  }

  function escape(value) {
    return runtime()?.esc(value) ?? String(value ?? '');
  }

  function show(element, visible) {
    if (element) element.classList.toggle('hidden', !visible);
  }

  function turnsFor(clientId) {
    return (runtime()?.appointments || []).filter((turn) => turn.cliente_id === clientId);
  }

  function attendance(turn) {
    const status = String(turn.estado_asistencia || '').toLowerCase();
    if (['pendiente', 'completado', 'ausente', 'cancelado', 'reprogramado'].includes(status)) return status;
    if (['completado', 'realizado'].includes(String(turn.estado || '').toLowerCase())) return 'completado';
    if (['ausente', 'no_show', 'no-show'].includes(String(turn.estado || '').toLowerCase())) return 'ausente';
    return runtime()?.isCancelled(turn.estado) ? 'cancelado' : 'pendiente';
  }

  function statusLabel(status) {
    return ({ pendiente: 'Pendiente', completado: 'Completado', ausente: 'Ausencia', cancelado: 'Cancelado', reprogramado: 'Reprogramado' })[status] || 'Pendiente';
  }

  function dateTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    try {
      return new Intl.DateTimeFormat('es-AR', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: runtime()?.business?.zona_horaria || 'America/Argentina/Buenos_Aires',
      }).format(date);
    } catch {
      return date.toLocaleString('es-AR');
    }
  }

  function currency(value) {
    if (value == null || value === '') return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(number);
  }

  function statsFor(client) {
    const turns = turnsFor(client.id);
    const visits = turns.filter((turn) => attendance(turn) === 'completado').sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
    const next = turns
      .filter((turn) => new Date(turn.inicio) > new Date() && !runtime()?.isCancelled(turn.estado) && attendance(turn) !== 'cancelado')
      .sort((a, b) => new Date(a.inicio) - new Date(b.inicio))[0] || null;
    return {
      turns,
      visits,
      first: visits[0] || null,
      last: visits[visits.length - 1] || null,
      next,
      noShows: turns.filter((turn) => attendance(turn) === 'ausente').length,
    };
  }

  function paymentFor(turn) {
    const online = (runtime()?.appointmentPayments || []).find((payment) => payment.turno_id === turn.id) || null;
    const manual = manualPayments.filter((payment) => payment.turno_id === turn.id);
    const onlinePaid = online?.estado === 'aprobado' ? Number(online.monto_cobrar) || 0 : 0;
    const manualPaid = manual
      .filter((payment) => payment.estado === 'confirmado')
      .reduce((sum, payment) => sum + (Number(payment.monto) || 0), 0);
    const declared = manual
      .filter((payment) => payment.estado === 'declarado')
      .reduce((sum, payment) => sum + (Number(payment.monto) || 0), 0);
    const total = turn.precio_cobrado != null
      ? Number(turn.precio_cobrado)
      : (online?.monto_total != null ? Number(online.monto_total) : null);
    return {
      online, manual, onlinePaid, manualPaid, declared,
      paid: onlinePaid + manualPaid,
      total,
      balance: total == null ? null : Math.max(0, total - onlinePaid - manualPaid),
    };
  }

  async function loadClients() {
    const ctx = runtime();
    if (!ctx?.business) return;
    const rows = $('clientRows');
    const notice = $('clientModuleNotice');
    if (rows) rows.innerHTML = '<div class="client-empty">Cargando clientes…</div>';
    if (notice) {
      notice.textContent = '';
      show(notice, false);
    }

    const result = await ctx.db.from('clientes').select('*').eq('negocio_id', ctx.business.id).order('nombre', { ascending: true });
    if (result.error) {
      clients = [];
      if (rows) rows.innerHTML = '<div class="client-empty">No se pudieron cargar las fichas.</div>';
      if (notice) {
        notice.textContent = /clientes|schema cache/i.test(result.error.message || '')
          ? 'Aplicá la migración 20261030000800_clients_history.sql en Supabase para habilitar Clientes.'
          : 'No se pudieron cargar los clientes: ' + ctx.friendly(result.error.message);
        show(notice, true);
      }
      return;
    }

    clients = result.data || [];
    const [historyResult, paymentResult] = await Promise.all([
      ctx.db.from('turnos_reprogramaciones').select('*').eq('negocio_id', ctx.business.id).order('registrado_en', { ascending: false }),
      ctx.db.from('pagos_manuales_turnos').select('*').eq('negocio_id', ctx.business.id).order('creado_en', { ascending: false }),
    ]);
    reschedules = historyResult.error ? [] : (historyResult.data || []);
    manualPayments = paymentResult.error ? [] : (paymentResult.data || []);
    if (notice && (historyResult.error || paymentResult.error)) {
      notice.textContent = 'Las fichas están disponibles, pero no se pudo cargar parte del historial de reprogramaciones o pagos. Verificá la migración de Clientes.';
      show(notice, true);
    }
    renderClients();
  }

  function renderClients() {
    const currentTier = tier();
    show($('clientMetrics'), currentTier !== 'gratis');
    document.querySelectorAll('[data-client-plan="inicial"]').forEach((item) => show(item, currentTier !== 'gratis'));
    document.querySelectorAll('[data-client-plan="equipo"]').forEach((item) => show(item, currentTier === 'equipo'));
    $('clientPlanNote').textContent = currentTier === 'gratis'
      ? 'Plan Gratis: ficha y cronología básica. El historial se conserva si el negocio cambia de plan.'
      : currentTier === 'inicial'
        ? 'Plan Inicial: historial completo, indicadores de visitas y resumen de pagos registrados.'
        : 'Plan Equipo: historial por profesional y filtros avanzados para el equipo.';

    const ctx = runtime();
    const professionalFilter = $('clientProfessionalFilter');
    const previousProfessional = professionalFilter?.value || 'all';
    if (professionalFilter) {
      professionalFilter.innerHTML = '<option value="all">Todos</option>' +
        (ctx.professionals || []).map((person) => '<option value="' + escape(person.id) + '">' + escape(person.nombre || 'Profesional') + '</option>').join('');
      professionalFilter.value = [...professionalFilter.options].some((option) => option.value === previousProfessional) ? previousProfessional : 'all';
    }

    const counts = clients.map((client) => ({ client, stats: statsFor(client) }));
    $('clientMetricTotal').textContent = String(clients.length);
    $('clientMetricReturning').textContent = String(counts.filter((item) => item.stats.visits.length >= 2).length);
    $('clientMetricUpcoming').textContent = String(counts.filter((item) => item.stats.next).length);
    $('clientMetricNoShows').textContent = String(counts.reduce((sum, item) => sum + item.stats.noShows, 0));

    const query = normalize($('clientSearch').value);
    const recency = $('clientRecencyFilter').value;
    const frequency = $('clientFrequencyFilter').value;
    const professionalId = professionalFilter?.value || 'all';
    const filtered = counts.filter(({ client, stats }) => {
      const haystack = normalize([client.nombre, client.telefono, client.email].join(' '));
      if (query && !haystack.includes(query)) return false;
      if (currentTier === 'equipo' && professionalId !== 'all' && !stats.turns.some((turn) => turn.profesional_id === professionalId)) return false;
      if (currentTier !== 'gratis' && frequency === 'new' && stats.visits.length >= 2) return false;
      if (currentTier !== 'gratis' && frequency === 'recurrent' && stats.visits.length < 2) return false;
      if (currentTier !== 'gratis' && recency === 'none' && stats.last) return false;
      if (currentTier !== 'gratis' && ['30', '90'].includes(recency) &&
          (!stats.last || new Date(stats.last.inicio) < new Date(Date.now() - Number(recency) * 86400000))) return false;
      return true;
    }).sort((a, b) => String(a.client.nombre || '').localeCompare(String(b.client.nombre || ''), 'es'));

    $('clientResultCount').textContent = filtered.length + ' de ' + clients.length + ' clientes';
    $('clientRows').innerHTML = filtered.length ? filtered.map(({ client, stats }) => {
      const repeatedName = clients.some((other) => other.id !== client.id && normalize(other.nombre) === normalize(client.nombre));
      const badge = stats.visits.length >= 2
        ? '<span class="client-badge recurrent">Recurrente</span>'
        : '<span class="client-badge">Nuevo</span>';
      return '<button type="button" class="client-card" data-client-id="' + escape(client.id) + '">' +
        '<span class="client-card-main"><strong>' + escape(client.nombre) + '</strong>' +
        '<span class="client-subtle">' + escape(client.telefono || 'Sin teléfono') + ' · ' + escape(client.email || 'Sin correo') + '</span>' +
        (repeatedName ? '<span class="client-duplicate-hint">Nombre repetido · revisar posible duplicado</span>' : '') + '</span>' +
        '<span class="client-card-value"><small>Última visita</small><b>' + escape(stats.last ? dateTime(stats.last.inicio).split(' ').slice(0, 3).join(' ') : 'Sin visitas') + '</b></span>' +
        '<span class="client-card-value"><small>Próximo turno</small><b>' + escape(stats.next ? dateTime(stats.next.inicio) : 'Sin reserva') + '</b></span>' +
        badge + '</button>';
    }).join('') : '<div class="client-empty">No hay clientes con estos filtros. Agregá una ficha o cambiá la búsqueda.</div>';
  }

  function appointmentCard(client, turn, allowEdit) {
    const ctx = runtime();
    const service = (ctx.services || []).find((item) => item.id === turn.servicio_id);
    const professional = (ctx.professionals || []).find((item) => item.id === turn.profesional_id);
    const state = attendance(turn);
    const isPast = new Date(turn.inicio) <= new Date();
    const duration = Math.max(0, Math.round((new Date(turn.fin) - new Date(turn.inicio)) / 60000));
    const turnReschedules = reschedules.filter((item) => item.turno_id === turn.id);
    const currentTier = tier();
    const payment = paymentFor(turn);
    const rebookingHtml = turnReschedules.map((item) =>
      '<div class="client-reschedule-note"><b>Reprogramado</b> · antes: ' + escape(dateTime(item.inicio_anterior)) +
      ' · ' + escape((ctx.services || []).find((value) => value.id === item.servicio_anterior_id)?.nombre || 'Servicio') +
      ' con ' + escape((ctx.professionals || []).find((value) => value.id === item.profesional_anterior_id)?.nombre || 'Profesional') + '</div>'
    ).join('');
    let paymentHtml = '';

    if (currentTier !== 'gratis') {
      const onlineLabel = payment.online ? String(payment.online.estado).replace(/_/g, ' ') : 'sin pago online';
      const manualHtml = payment.manual.map((item) =>
        '<span>' + escape(item.metodo) + ' · ' + escape(currency(item.monto)) + ' · ' +
        escape(item.estado === 'confirmado' ? 'Confirmado' : item.estado === 'rechazado' ? 'Rechazado' : 'Declarado') + '</span>' +
        (item.estado === 'declarado'
          ? '<span class="client-inline-actions"><button class="outline small" type="button" data-manual-payment="' + escape(item.id) + '" data-payment-state="confirmado">Confirmar</button>' +
            '<button class="outline small" type="button" data-manual-payment="' + escape(item.id) + '" data-payment-state="rechazado">Rechazar</button></span>'
          : '')
      ).join('');
      paymentHtml = '<div class="client-payment-box"><div class="client-payment-lines">' +
        '<span>Precio registrado: ' + escape(currency(payment.total)) + '</span>' +
        (payment.online ? '<span>' + (payment.online.modalidad === 'sena' ? 'Seña online abonada: ' : 'Pago online abonado: ') + escape(currency(payment.onlinePaid)) + '</span>' : '') +
        (payment.online?.monto_cobrar != null ? '<span>Importe online solicitado: ' + escape(currency(payment.online.monto_cobrar)) + '</span>' : '') +
        '<span>Manual confirmado: ' + escape(currency(payment.manualPaid)) + '</span>' +
        '<span>Saldo registrado: ' + escape(currency(payment.balance)) + '</span>' +
        '<span>Online: ' + escape(onlineLabel) + '</span>' +
        (payment.declared ? '<span>Montos declarados (sin confirmar): ' + escape(currency(payment.declared)) + '</span>' : '') +
        '</div>' + (manualHtml ? '<div class="client-payment-lines">' + manualHtml + '</div>' : '') +
        (!ctx.isCancelled(turn.estado)
          ? '<button class="outline small" type="button" data-add-manual-payment="' + escape(client.id) + '" data-turn-id="' + escape(turn.id) + '">Registrar pago manual</button>'
          : '') + '</div>';
    }

    let attendanceHtml = '';
    if (allowEdit && isPast && !ctx.isCancelled(turn.estado)) {
      const options = ['pendiente', 'completado', 'ausente'].map((value) =>
        '<option value="' + value + '"' + (state === value ? ' selected' : '') + '>' + statusLabel(value) + '</option>'
      ).join('');
      attendanceHtml = '<form class="client-attendance-form" data-client-id="' + escape(client.id) + '" data-turn-id="' + escape(turn.id) + '">' +
        '<div class="field"><label>Asistencia</label><select name="estado_asistencia" class="client-status-select">' + options + '</select></div>' +
        '<div class="field"><label>Nota privada del servicio</label><textarea name="nota_servicio" maxlength="2000" rows="2" placeholder="Preferencias o detalles operativos">' +
        escape(turn.nota_servicio || '') + '</textarea><small class="client-private-note">No agregues diagnósticos ni información médica sensible.</small></div>' +
        '<button class="secondary small" type="submit">Guardar asistencia y nota</button></form>';
    }

    return '<article class="client-history-card" data-client-id="' + escape(client.id) + '">' +
      '<div class="client-history-heading"><div><h4>' + escape(service?.nombre || 'Servicio') + '</h4>' +
      '<div class="client-history-meta"><span>' + escape(dateTime(turn.inicio)) + '</span><span>' +
      escape(professional?.nombre || 'Profesional') + '</span><span>' + duration + ' min</span></div></div>' +
      '<span class="client-badge ' + (state === 'completado' ? 'recurrent' : '') + '">' + statusLabel(state) + '</span></div>' +
      rebookingHtml + '<div class="client-history-body">' +
      (currentTier !== 'gratis' && turn.precio_cobrado != null
        ? '<span class="client-subtle">Precio registrado: ' + escape(currency(turn.precio_cobrado)) + '</span>'
        : '') + paymentHtml + attendanceHtml + '</div></article>';
  }

  function openClientDetails(clientId) {
    const ctx = runtime();
    const client = clients.find((item) => item.id === clientId);
    if (!client || !ctx) return;
    const currentTier = tier();
    const stats = statsFor(client);
    const future = stats.turns.filter((turn) =>
      new Date(turn.inicio) > new Date() && !ctx.isCancelled(turn.estado) && attendance(turn) !== 'cancelado'
    ).sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
    const history = stats.turns.filter((turn) =>
      new Date(turn.inicio) <= new Date() || attendance(turn) === 'cancelado'
    ).sort((a, b) => new Date(b.inicio) - new Date(a.inicio));
    const paid = stats.turns.reduce((sum, turn) => sum + paymentFor(turn).paid, 0);
    const first = stats.first ? dateTime(stats.first.inicio) : '—';
    const last = stats.last ? dateTime(stats.last.inicio) : '—';
    const next = stats.next ? dateTime(stats.next.inicio) : 'Sin reserva';
    const serviceVisits = new Map();
    stats.visits.forEach((turn) => serviceVisits.set(turn.servicio_id, (serviceVisits.get(turn.servicio_id) || 0) + 1));
    const mostUsedServiceId = [...serviceVisits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const mostUsedServiceName = ctx.services.find((item) => item.id === mostUsedServiceId)?.nombre || '—';
    const averageDays = stats.visits.length >= 2
      ? Math.round((new Date(stats.visits[stats.visits.length - 1].inicio) - new Date(stats.visits[0].inicio)) / 86400000 / (stats.visits.length - 1))
      : null;
    const contact = client.preferencia_contacto === 'email' ? 'Correo' : client.preferencia_contacto === 'telefono' ? 'Teléfono' : 'WhatsApp';
    const metrics = currentTier !== 'gratis'
      ? '<div class="client-detail-metrics"><div class="client-stat-card"><span>Visitas completadas</span><strong>' + stats.visits.length + '</strong></div>' +
        '<div class="client-stat-card"><span>Primera visita</span><strong>' + escape(first) + '</strong></div>' +
        '<div class="client-stat-card"><span>Última visita</span><strong>' + escape(last) + '</strong></div>' +
        '<div class="client-stat-card"><span>Ausencias</span><strong>' + stats.noShows + '</strong></div>' +
        '<div class="client-stat-card"><span>Próximo turno</span><strong>' + escape(next) + '</strong></div>' +
        '<div class="client-stat-card"><span>Servicio más utilizado</span><strong>' + escape(mostUsedServiceName) + '</strong></div>' +
        '<div class="client-stat-card"><span>Frecuencia media</span><strong>' + escape(averageDays == null ? '—' : 'Cada ' + averageDays + ' días') + '</strong></div>' +
        '<div class="client-stat-card"><span>Total abonado confirmado</span><strong>' + escape(currency(paid)) + '</strong></div></div>'
      : '';
    const teamSummary = currentTier === 'equipo'
      ? '<div class="client-info-card"><h4>Atenciones por profesional</h4><p>' +
        (ctx.professionals || []).map((person) => {
          const count = stats.visits.filter((turn) => turn.profesional_id === person.id).length;
          return count ? '<span>' + escape(person.nombre) + ': ' + count + ' visitas · </span>' : '';
        }).join('') + '</p></div>'
      : '';
    const upcomingHtml = future.length
      ? future.map((turn) => appointmentCard(client, turn, false)).join('')
      : '<div class="client-empty">No tiene próximos turnos.</div>';
    const historyHtml = history.length
      ? history.map((turn) => appointmentCard(client, turn, true)).join('')
      : '<div class="client-empty">Todavía no hay historial de turnos.</div>';

    const html = '<div class="client-detail-actions">' +
      '<button class="secondary small" type="button" data-edit-client="' + escape(client.id) + '">Editar datos</button>' +
      '<button class="outline small" type="button" data-export-client="' + escape(client.id) + '">Exportar ficha</button>' +
      '<button class="outline small" type="button" data-delete-client="' + escape(client.id) + '">Eliminar datos</button></div>' +
      '<div class="client-profile-grid"><section class="client-info-card"><h3>Datos generales</h3>' +
      '<p><b>Teléfono / WhatsApp:</b> ' + escape(client.telefono || '—') + '</p>' +
      '<p><b>Correo:</b> ' + escape(client.email || '—') + '</p>' +
      '<p><b>Fecha de nacimiento:</b> ' + escape(client.fecha_nacimiento || '—') + '</p>' +
      '<p><b>Registrado:</b> ' + escape(dateTime(client.creado_en)) + '</p></section>' +
      '<section class="client-info-card"><h3>Preferencias y notas</h3><p><b>Contacto preferido:</b> ' + contact + '</p>' +
      '<p><b>Comunicaciones comerciales:</b> ' + (client.consentimiento_comercial ? 'Consentidas' : 'No consentidas') + '</p>' +
      '<p>' + escape(client.notas_generales || 'Sin notas generales.') + '</p></section></div>' +
      metrics + (teamSummary ? '<div style="margin-top:10px">' + teamSummary + '</div>' : '') +
      '<div class="client-section-title"><h3>Próximos turnos</h3><span class="client-subtle">' + future.length + '</span></div>' +
      '<div class="client-history-list">' + upcomingHtml + '</div>' +
      '<div class="client-section-title"><h3>Historial de atención</h3><span class="client-subtle">' + history.length + ' registros</span></div>' +
      '<p class="client-subtle">Las visitas se cuentan solo cuando el turno está marcado como completado. Los importes confirmados se separan de los declarados y pendientes.</p>' +
      '<div class="client-history-list">' + historyHtml + '</div>';
    ctx.openModal('Ficha de cliente', html);
    document.querySelector('#modalBack .modal')?.classList.add('client-modal-wide');
  }

  function openClientEditor(client) {
    const ctx = runtime();
    const value = client || {};
    const id = value.id || '';
    const html = '<form id="clientForm" data-client-id="' + escape(id) + '"><div class="client-form-grid">' +
      '<div class="field full"><label for="clientName">Nombre y apellido</label><input id="clientName" name="nombre" maxlength="160" required value="' + escape(value.nombre || '') + '"></div>' +
      '<div class="field"><label for="clientPhone">Teléfono / WhatsApp</label><input id="clientPhone" name="telefono" type="tel" maxlength="40" value="' + escape(value.telefono || '') + '"></div>' +
      '<div class="field"><label for="clientEmail">Correo electrónico</label><input id="clientEmail" name="email" type="email" maxlength="254" value="' + escape(value.email || '') + '"></div>' +
      '<div class="field"><label for="clientBirth">Fecha de nacimiento (opcional)</label><input id="clientBirth" name="fecha_nacimiento" type="date" value="' + escape(value.fecha_nacimiento || '') + '"></div>' +
      '<div class="field"><label for="clientContactPreference">Contacto preferido</label><select id="clientContactPreference" name="preferencia_contacto">' +
      '<option value="whatsapp"' + (value.preferencia_contacto === 'whatsapp' ? ' selected' : '') + '>WhatsApp</option>' +
      '<option value="telefono"' + (value.preferencia_contacto === 'telefono' ? ' selected' : '') + '>Teléfono</option>' +
      '<option value="email"' + (value.preferencia_contacto === 'email' ? ' selected' : '') + '>Correo</option></select></div>' +
      '<label class="field full" style="display:flex;align-items:center;gap:9px"><input name="consentimiento_comercial" type="checkbox"' +
      (value.consentimiento_comercial ? ' checked' : '') + '> Acepta recibir comunicaciones comerciales</label>' +
      '<div class="field full"><label for="clientGeneralNotes">Notas privadas</label><textarea id="clientGeneralNotes" name="notas_generales" maxlength="4000" rows="4" placeholder="Preferencias para futuras visitas">' +
      escape(value.notas_generales || '') + '</textarea><small class="client-private-note">No guardes diagnósticos ni información médica sensible.</small></div></div>' +
      '<div class="notice hidden" id="clientFormNotice" role="alert"></div><div class="client-inline-actions">' +
      '<button class="primary" type="submit">Guardar ficha</button><button class="outline" type="button" data-close-client-modal>Cancelar</button></div></form>';
    ctx.openModal(id ? 'Editar cliente' : 'Agregar cliente', html);
  }

  function openManualPaymentForm(clientId, turnId) {
    const ctx = runtime();
    const client = clients.find((item) => item.id === clientId);
    const turn = (ctx?.appointments || []).find((item) => item.id === turnId);
    if (!client || !turn) return;
    const suggested = paymentFor(turn).balance;
    const html = '<form id="manualPaymentForm" data-client-id="' + escape(clientId) + '" data-turn-id="' + escape(turnId) + '">' +
      '<p class="muted">' + escape(client.nombre) + ' · ' + escape(dateTime(turn.inicio)) + '</p>' +
      '<div class="field"><label for="manualPaymentAmount">Importe declarado</label><input id="manualPaymentAmount" name="monto" type="number" min="0.01" step="0.01" required value="' + escape(suggested == null ? '' : String(suggested)) + '"></div>' +
      '<div class="field"><label for="manualPaymentMethod">Medio</label><select id="manualPaymentMethod" name="metodo"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option><option value="tarjeta">Tarjeta</option><option value="otro">Otro</option></select></div>' +
      '<div class="field"><label for="manualPaymentNote">Nota opcional</label><input id="manualPaymentNote" name="nota" maxlength="1000" placeholder="Referencia o detalle"></div>' +
      '<p class="client-private-note">El importe queda como Declarado hasta que lo confirmes. Los valores declarados no se suman a lo abonado.</p>' +
      '<div class="notice hidden" id="manualPaymentNotice" role="alert"></div><button class="primary" type="submit">Registrar como declarado</button></form>';
    ctx.openModal('Registrar pago manual', html);
  }

  function exportClient(clientId) {
    const ctx = runtime();
    const client = clients.find((item) => item.id === clientId);
    if (!client || !ctx) return;
    const turns = turnsFor(clientId).map((turn) => ({
      fecha: turn.inicio,
      fin: turn.fin,
      servicio: ctx.services.find((item) => item.id === turn.servicio_id)?.nombre || null,
      profesional: ctx.professionals.find((item) => item.id === turn.profesional_id)?.nombre || null,
      estado: turn.estado,
      asistencia: attendance(turn),
      precio_registrado: turn.precio_cobrado,
      pagos_online: ctx.appointmentPayments.filter((item) => item.turno_id === turn.id),
      pagos_manuales: manualPayments.filter((item) => item.turno_id === turn.id),
      nota_servicio: turn.nota_servicio,
    }));
    const blob = new Blob([JSON.stringify({ cliente: client, turnos }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (client.nombre || 'cliente').replace(/[^a-z0-9-]+/gi, '-').toLowerCase() + '-tusturna.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function deleteClient(clientId) {
    const ctx = runtime();
    if (!confirm('Se eliminarán los datos personales y las notas del cliente. Los registros de turnos y pagos se conservarán anonimizados. ¿Continuar?')) return;
    const { error } = await ctx.db.rpc('agenda_tora_eliminar_cliente', { p_cliente_id: clientId });
    if (error) {
      ctx.note('appNotice', 'No se pudo eliminar la ficha: ' + ctx.friendly(error.message), true);
      return;
    }
    ctx.closeModal();
    await ctx.loadAppointments();
    await loadClients();
    ctx.note('appNotice', 'Datos personales eliminados y turnos conservados sin identificación.');
  }

  $('addClient')?.addEventListener('click', () => openClientEditor(null));
  ['clientSearch', 'clientRecencyFilter', 'clientFrequencyFilter', 'clientProfessionalFilter'].forEach((id) => {
    $(id)?.addEventListener('input', renderClients);
    $(id)?.addEventListener('change', renderClients);
  });
  $('clientRows')?.addEventListener('click', (event) => {
    const row = event.target.closest('.client-card[data-client-id]');
    if (row) openClientDetails(row.dataset.clientId);
  });
  document.querySelectorAll('[data-view="clients"]').forEach((button) =>
    button.addEventListener('click', () => setTimeout(loadClients, 0))
  );
  $('modalBody')?.addEventListener('submit', async (event) => {
    const form = event.target;
    const ctx = runtime();
    if (form.id === 'clientForm') {
      event.preventDefault();
      const data = new FormData(form);
      const id = form.dataset.clientId;
      const payload = {
        nombre: String(data.get('nombre') || '').trim(),
        telefono: String(data.get('telefono') || '').trim() || null,
        email: String(data.get('email') || '').trim() || null,
        fecha_nacimiento: String(data.get('fecha_nacimiento') || '') || null,
        preferencia_contacto: String(data.get('preferencia_contacto') || 'whatsapp'),
        consentimiento_comercial: data.get('consentimiento_comercial') === 'on',
        notas_generales: String(data.get('notas_generales') || '').trim() || null,
      };
      const result = id
        ? await ctx.db.from('clientes').update(payload).eq('id', id).eq('negocio_id', ctx.business.id)
        : await ctx.db.from('clientes').insert({ ...payload, negocio_id: ctx.business.id });
      if (result.error) {
        const notice = $('clientFormNotice');
        notice.textContent = 'No se pudo guardar la ficha: ' + ctx.friendly(result.error.message);
        show(notice, true);
        return;
      }
      ctx.closeModal();
      await loadClients();
      if (id) openClientDetails(id);
      ctx.note('appNotice', id ? 'Ficha de cliente actualizada.' : 'Cliente agregado.');
    } else if (form.classList.contains('client-attendance-form')) {
      event.preventDefault();
      const data = new FormData(form);
      const clientId = form.dataset.clientId;
      const { error } = await ctx.db.rpc('agenda_tora_actualizar_asistencia_turno', {
        p_turno_id: form.dataset.turnId,
        p_estado_asistencia: data.get('estado_asistencia'),
        p_nota_servicio: String(data.get('nota_servicio') || '').trim() || null,
      });
      if (error) {
        ctx.note('appNotice', 'No se pudo guardar la asistencia: ' + ctx.friendly(error.message), true);
        return;
      }
      await ctx.loadAppointments();
      await loadClients();
      openClientDetails(clientId);
    } else if (form.id === 'manualPaymentForm') {
      event.preventDefault();
      const data = new FormData(form);
      const amount = Number(data.get('monto'));
      if (!Number.isFinite(amount) || amount <= 0) {
        const notice = $('manualPaymentNotice');
        notice.textContent = 'Ingresá un importe válido.';
        show(notice, true);
        return;
      }
      const clientId = form.dataset.clientId;
      const { error } = await ctx.db.from('pagos_manuales_turnos').insert({
        negocio_id: ctx.business.id,
        turno_id: form.dataset.turnId,
        monto: amount,
        metodo: data.get('metodo'),
        estado: 'declarado',
        nota: String(data.get('nota') || '').trim() || null,
      });
      if (error) {
        const notice = $('manualPaymentNotice');
        notice.textContent = 'No se pudo registrar el pago: ' + ctx.friendly(error.message);
        show(notice, true);
        return;
      }
      ctx.closeModal();
      await loadClients();
      openClientDetails(clientId);
      ctx.note('appNotice', 'Pago registrado como declarado; todavía no se suma al total abonado.');
    }
  });

  $('modalBody')?.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit-client]');
    if (edit) {
      openClientEditor(clients.find((item) => item.id === edit.dataset.editClient));
      return;
    }
    if (event.target.closest('[data-close-client-modal]')) {
      runtime()?.closeModal();
      return;
    }
    const exportButton = event.target.closest('[data-export-client]');
    if (exportButton) {
      exportClient(exportButton.dataset.exportClient);
      return;
    }
    const deleteButton = event.target.closest('[data-delete-client]');
    if (deleteButton) {
      await deleteClient(deleteButton.dataset.deleteClient);
      return;
    }
    const addPayment = event.target.closest('[data-add-manual-payment]');
    if (addPayment) {
      openManualPaymentForm(addPayment.dataset.addManualPayment, addPayment.dataset.turnId);
      return;
    }
    const confirmPayment = event.target.closest('[data-manual-payment]');
    if (confirmPayment) {
      const state = confirmPayment.dataset.paymentState;
      if (state === 'confirmado' && !confirm('¿Confirmás que recibiste este pago?')) return;
      const ctx = runtime();
      const clientId = confirmPayment.closest('.client-history-card')?.dataset.clientId;
      const { error } = await ctx.db.rpc('agenda_tora_confirmar_pago_manual', {
        p_pago_id: confirmPayment.dataset.manualPayment,
        p_estado: state,
      });
      if (error) {
        ctx.note('appNotice', 'No se pudo actualizar el pago: ' + ctx.friendly(error.message), true);
        return;
      }
      await loadClients();
      if (clientId) openClientDetails(clientId);
    }
  });

  window.tusturnaClientRefresh = () => {
    if (runtime()?.currentView === 'clients') return loadClients();
  };
  if (runtime()?.currentView === 'clients') setTimeout(loadClients, 0);
})();
