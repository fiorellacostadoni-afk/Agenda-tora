-- Atomic, hashed payment capability for newly created online-payment bookings.
-- Existing reservations are intentionally left unchanged.
create schema if not exists private;
revoke all on schema private from PUBLIC, anon, authenticated;

create table if not exists private.turno_checkout_capabilities (
  turno_id uuid primary key references public.turnos(id) on delete cascade,
  negocio_id uuid not null references public.negocios(id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default statement_timestamp(),
  last_used_at timestamptz
);

alter table private.turno_checkout_capabilities enable row level security;
revoke all on private.turno_checkout_capabilities from PUBLIC, anon, authenticated;

create or replace function public.reservar_turno_con_checkout_publico(
  p_negocio_id uuid,
  p_profesional_id uuid,
  p_servicio_id uuid,
  p_inicio timestamptz,
  p_cliente_nombre text,
  p_cliente_telefono text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_modalidad text;
  v_turno_id uuid;
  v_token text;
begin
  select n.modalidad_pago into v_modalidad
  from public.negocios n
  where n.id = p_negocio_id;

  if not found or v_modalidad not in ('sena', 'total') then
    raise exception 'El negocio no tiene un cobro online habilitado.';
  end if;

  -- The existing reservation routine retains its current validation and availability rules.
  -- The reservation and capability insert share this transaction and roll back together.
  v_turno_id := public.reservar_turno_publico(
    p_negocio_id, p_profesional_id, p_servicio_id, p_inicio,
    p_cliente_nombre, p_cliente_telefono
  );

  v_token := replace(pg_catalog.gen_random_uuid()::text, '-', '')
      || replace(pg_catalog.gen_random_uuid()::text, '-', '')
      || replace(pg_catalog.gen_random_uuid()::text, '-', '');

  insert into private.turno_checkout_capabilities (
    turno_id, negocio_id, token_hash, expires_at
  )
  select t.id, t.negocio_id,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_token, 'UTF8')), 'hex'),
         least(statement_timestamp() + interval '30 minutes', t.inicio)
  from public.turnos t
  where t.id = v_turno_id;

  return pg_catalog.jsonb_build_object(
    'turno_id', v_turno_id,
    'checkout_token', v_token
  );
end;
$function$;

revoke all on function public.reservar_turno_con_checkout_publico(uuid, uuid, uuid, timestamptz, text, text)
  from PUBLIC, anon, authenticated;
grant execute on function public.reservar_turno_con_checkout_publico(uuid, uuid, uuid, timestamptz, text, text)
  to anon, authenticated;

create or replace function public.agenda_tora_validar_checkout_capacidad(
  p_turno_id uuid,
  p_checkout_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_hash text;
  v_updated integer;
begin
  if p_turno_id is null
     or p_checkout_token is null
     or p_checkout_token !~ '^[0-9a-f]{96}$' then
    return false;
  end if;

  v_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_checkout_token, 'UTF8')),
    'hex'
  );

  update private.turno_checkout_capabilities c
  set attempts = c.attempts + 1,
      last_used_at = statement_timestamp()
  from public.turnos t
  join public.negocios n on n.id = t.negocio_id
  where c.turno_id = p_turno_id
    and c.negocio_id = t.negocio_id
    and t.id = c.turno_id
    and t.estado = 'pendiente'
    and t.inicio > statement_timestamp()
    and n.modalidad_pago in ('sena', 'total')
    and c.token_hash = v_hash
    and c.expires_at > statement_timestamp()
    and c.attempts < 20;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

revoke all on function public.agenda_tora_validar_checkout_capacidad(uuid, text)
  from PUBLIC, anon, authenticated;
grant execute on function public.agenda_tora_validar_checkout_capacidad(uuid, text)
  to service_role;
