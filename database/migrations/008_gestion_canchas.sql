-- ─────────────────────────────────────────────────────────────
--  008 · Gestión de canchas (solo jefes)
--  Agregar, renombrar, cambiar tipo/precio, desactivar y eliminar canchas.
--  Una cancha con reservas o turnos fijos NO se puede eliminar (se perdería
--  el historial y la caja): se la desactiva y desaparece de la grilla.
--  Correr una sola vez en Supabase → SQL Editor → New query → Run.
-- ─────────────────────────────────────────────────────────────

-- ══ 1) PERMISOS ═════════════════════════════════════════════
drop policy if exists "jefes crean canchas" on public.canchas;
create policy "jefes crean canchas" on public.canchas
  for insert to authenticated with check (public.es_jefe());

drop policy if exists "jefes eliminan canchas" on public.canchas;
create policy "jefes eliminan canchas" on public.canchas
  for delete to authenticated using (public.es_jefe());

-- ══ 2) HISTORIAL DE ACTIVIDAD ═══════════════════════════════
-- Las canchas dejan el trigger genérico (no contemplaba alta ni baja)
-- y pasan a uno propio que registra todos los cambios.
drop trigger if exists actividad_canchas on public.canchas;

create or replace function public.registrar_actividad_cancha()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  accion  text;
  detalle text;
  r       record;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  detalle := format('%s %s (%s)', r.tipo, r.etiqueta, r.id);

  if tg_op = 'INSERT' then
    accion := 'Creó cancha';
    detalle := detalle || ' · ' || dinero(r.precio_hora) || ' por hora';
  elsif tg_op = 'DELETE' then
    accion := 'Eliminó cancha';
  elsif new.eliminada and not old.eliminada then
    accion := 'Eliminó cancha';
    detalle := detalle || ' · con historial, se conserva en la caja';
  elsif new.activa is distinct from old.activa then
    accion := case when new.activa then 'Reactivó cancha' else 'Desactivó cancha' end;
  elsif new.precio_hora is distinct from old.precio_hora then
    accion := 'Cambió precio';
    detalle := format('%s %s: %s → %s por hora', new.tipo, new.etiqueta, dinero(old.precio_hora), dinero(new.precio_hora));
  elsif (new.etiqueta, new.tipo) is distinct from (old.etiqueta, old.tipo) then
    accion := 'Editó cancha';
    detalle := format('%s %s → %s %s (%s)', old.tipo, old.etiqueta, new.tipo, new.etiqueta, new.id);
  else
    return null;
  end if;

  insert into actividad (usuario, email, accion, tabla, registro_id, detalle)
  values (usuario_actual(), lower(auth.jwt() ->> 'email'), accion, 'canchas', r.id, detalle);
  return null;
end;
$$;

create trigger actividad_canchas after insert or update or delete on public.canchas
  for each row execute function public.registrar_actividad_cancha();

-- ══ 3) CREAR CANCHA ═════════════════════════════════════════
-- Genera el id ('F5-7') y el orden solos.
create or replace function public.crear_cancha(p_tipo text, p_etiqueta text, p_precio numeric)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  n   int;
  nid text;
begin
  if not es_jefe() then raise exception 'Solo los jefes pueden crear canchas.'; end if;
  if p_tipo not in ('F5', 'F7') then raise exception 'Tipo de cancha inválido.'; end if;
  if coalesce(trim(p_etiqueta), '') = '' then raise exception 'Ingresá el nombre de la cancha.'; end if;
  if p_precio is null or p_precio < 0 then raise exception 'Precio inválido.'; end if;

  lock table public.canchas in share row exclusive mode;   -- evita ids repetidos si dos jefes crean a la vez
  select coalesce(max(substring(id from '-(\d+)$')::int), 0) + 1 into n
    from canchas where tipo = p_tipo;
  nid := p_tipo || '-' || n;

  insert into canchas (id, tipo, etiqueta, precio_hora, orden)
  values (nid, p_tipo, trim(p_etiqueta), p_precio, (select coalesce(max(orden), 0) + 1 from canchas));
  return jsonb_build_object('id', nid);
end;
$$;
grant execute on function public.crear_cancha(text, text, numeric) to authenticated;

-- ══ 4) QUÉ TIENE ATADO UNA CANCHA ═══════════════════════════
-- Para avisar antes de desactivar/eliminar.
create or replace function public.uso_cancha(p_id text, p_hoy date)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'reservas_total',   (select count(*) from reservas where cancha_id = p_id),
    'reservas_futuras', (select count(*) from reservas
                          where cancha_id = p_id and fecha >= p_hoy and estado = 'Confirmada'),
    'fijos_total',      (select count(*) from turnos_fijos where cancha_id = p_id),
    'fijos_activos',    (select count(*) from turnos_fijos where cancha_id = p_id and activo)
  );
$$;
grant execute on function public.uso_cancha(text, date) to authenticated;

-- ══ 5) DESACTIVAR / REACTIVAR ═══════════════════════════════
-- No deja desactivar si quedan reservas futuras o turnos fijos activos:
-- desaparecerían de la grilla con el cliente esperando.
create or replace function public.cambiar_estado_cancha(p_id text, p_activa boolean, p_hoy date)
returns jsonb
language plpgsql
set search_path = public
as $$
declare uso jsonb;
begin
  if not es_jefe() then raise exception 'Solo los jefes pueden modificar canchas.'; end if;
  if not p_activa then
    uso := uso_cancha(p_id, p_hoy);
    if (uso ->> 'reservas_futuras')::int > 0 or (uso ->> 'fijos_activos')::int > 0 then
      return jsonb_build_object('ok', false, 'uso', uso);
    end if;
  end if;
  update canchas set activa = p_activa where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.cambiar_estado_cancha(text, boolean, date) to authenticated;

-- ══ 6) ELIMINAR ═════════════════════════════════════════════
-- Sin historial → se borra de verdad.
-- Con historial (aunque sean reservas ya jugadas) → queda "eliminada": desaparece
-- del panel, pero sus reservas pasadas siguen en la caja y los reportes.
-- Si tiene reservas futuras o turnos fijos activos, primero devuelve el conteo
-- para que el panel pida confirmación; con p_forzar las cancela y da de baja los fijos.
alter table public.canchas add column if not exists eliminada boolean not null default false;

drop function if exists public.eliminar_cancha(text, date);
create or replace function public.eliminar_cancha(p_id text, p_hoy date, p_forzar boolean default false)
returns jsonb
language plpgsql
set search_path = public
as $$
declare uso jsonb;
begin
  if not es_jefe() then raise exception 'Solo los jefes pueden eliminar canchas.'; end if;
  uso := uso_cancha(p_id, p_hoy);

  if (uso ->> 'reservas_total')::int = 0 and (uso ->> 'fijos_total')::int = 0 then
    delete from canchas where id = p_id;
    return jsonb_build_object('ok', true, 'borrada', true);
  end if;

  if ((uso ->> 'reservas_futuras')::int > 0 or (uso ->> 'fijos_activos')::int > 0) and not p_forzar then
    return jsonb_build_object('ok', false, 'uso', uso);
  end if;

  update turnos_fijos set activo = false, hasta = p_hoy where cancha_id = p_id and activo;
  update reservas set estado = 'Cancelada', motivo_cancelacion = 'Cancha eliminada'
   where cancha_id = p_id and fecha >= p_hoy and estado = 'Confirmada';
  update canchas set activa = false, eliminada = true where id = p_id;
  return jsonb_build_object('ok', true, 'borrada', false);
end;
$$;
grant execute on function public.eliminar_cancha(text, date, boolean) to authenticated;
