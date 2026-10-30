-- TusTurna: pagos por transferencia, migración aditiva, revisar en staging antes de aplicar.
alter table public.negocios
  add column if not exists transferencia_alias text,
  add column if not exists transferencia_cbu text,
  add column if not exists transferencia_titular text;
create table if not exists public.transferencias_turnos (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references public.negocios(id),
  turno_id uuid not null unique references public.turnos(id),
  monto numeric(12,2) not null check (monto > 0),
  monto_total numeric(12,2) not null check (monto_total >= monto),
  estado text not null default 'pendiente' check (estado in ('pendiente','informado','confirmado','rechazado','vencido')),
  token_hash text not null,
  expira_en timestamptz not null,
  creado_en timestamptz not null default now(),
  informado_en timestamptz,
  confirmado_en timestamptz,
  unique(negocio_id, turno_id)
);
alter table public.transferencias_turnos enable row level security;
revoke all on public.transferencias_turnos from public, anon, authenticated;
grant select on public.transferencias_turnos to authenticated;
create policy transferencias_solo_propietario on public.transferencias_turnos for select to authenticated
using (exists(select 1 from public.negocios n where n.id=negocio_id and n.propietario_id=(select auth.uid())));
create or replace function public.reservar_turno_transferencia_publico(
 p_negocio_id uuid,p_profesional_id uuid,p_servicio_id uuid,p_inicio timestamptz,p_cliente_nombre text,p_cliente_telefono text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_n public.negocios%rowtype;
 v_precio numeric; v_monto numeric; v_turno uuid; v_token text;
begin
 select * into v_n from public.negocios where id=p_negocio_id;
 if not found or not ('transferencia'=any(v_n.metodos_pago))
    or nullif(btrim(v_n.transferencia_alias),'') is null
    or nullif(btrim(v_n.transferencia_titular),'') is null
    or v_n.transferencia_cbu !~ '^[0-9]{22}$' then
   raise exception 'La transferencia bancaria no está configurada.';
 end if;
 select precio into v_precio from public.servicios where negocio_id=p_negocio_id and id=p_servicio_id and activo;
 if not found then raise exception 'Servicio no disponible'; end if;
 v_monto:=case when v_n.modalidad_pago='total' then round(v_precio,2)
    when v_n.modalidad_pago='sena' and v_n.tipo_senia='fijo' then round(v_n.monto_senia,2)
    when v_n.modalidad_pago='sena' then round(v_precio * v_n.porcentaje_senia / 100,2)
    else 0 end;
 if v_monto<=0 or v_monto>v_precio then raise exception 'Monto de transferencia inválido'; end if;
 v_turno:=public.reservar_turno_publico(p_negocio_id,p_profesional_id,p_servicio_id,p_inicio,p_cliente_nombre,p_cliente_telefono);
 v_token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 insert into public.transferencias_turnos(negocio_id,turno_id,monto,monto_total,token_hash,expira_en)
 values(p_negocio_id,v_turno,v_monto,v_precio,md5(v_token),least(statement_timestamp()+interval '24 hours',p_inicio));
 return jsonb_build_object('turno_id',v_turno,'token',v_token,'monto',v_monto,'total',v_precio);
end; $$;
revoke all on function public.reservar_turno_transferencia_publico(uuid,uuid,uuid,timestamptz,text,text) from public;
grant execute on function public.reservar_turno_transferencia_publico(uuid,uuid,uuid,timestamptz,text,text) to anon,authenticated;

create or replace function public.informar_transferencia_publica(p_turno_id uuid,p_token text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_changed int;
begin
 update public.transferencias_turnos set estado='informado',informado_en=statement_timestamp()
 where turno_id=p_turno_id and token_hash=md5(coalesce(p_token,''))
 and estado in ('pendiente','informado') and expira_en>statement_timestamp();
 get diagnostics v_changed=row_count;
 return v_changed>0;
end; $$;
revoke all on function public.informar_transferencia_publica(uuid,text) from public;
grant execute on function public.informar_transferencia_publica(uuid,text) to anon,authenticated;

create or replace function public.resolver_transferencia_negocio(p_transferencia_id uuid,p_aprobar boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_reg public.transferencias_turnos%rowtype;
begin
 select t.* into v_reg from public.transferencias_turnos t
 join public.negocios n on n.id=t.negocio_id
 where t.id=p_transferencia_id and n.propietario_id=auth.uid() for update of t;
 if not found or v_reg.estado not in ('pendiente','informado') or v_reg.expira_en<=statement_timestamp() then return false; end if;
 update public.transferencias_turnos set estado=case when p_aprobar then 'confirmado' else 'rechazado' end,
 confirmado_en=case when p_aprobar then statement_timestamp() else null end where id=v_reg.id;
 update public.turnos set estado=case when p_aprobar then 'confirmado' else 'cancelado' end
 where id=v_reg.turno_id and estado='pendiente';
 return true;
end; $$;
revoke all on function public.resolver_transferencia_negocio(uuid,boolean) from public;
grant execute on function public.resolver_transferencia_negocio(uuid,boolean) to authenticated;

create or replace function public.expirar_transferencias_pendientes()
returns integer language plpgsql security definer set search_path='' as $$
declare v_count int;
begin
 with vencidas as (
 update public.transferencias_turnos set estado='vencido'
 where estado in ('pendiente','informado') and expira_en<=statement_timestamp()
 returning turno_id
 ) update public.turnos set estado='cancelado'
 where id in (select turno_id from vencidas) and estado='pendiente';
 get diagnostics v_count=row_count;
 return v_count;
end; $$;
revoke all on function public.expirar_transferencias_pendientes() from public,anon,authenticated;
