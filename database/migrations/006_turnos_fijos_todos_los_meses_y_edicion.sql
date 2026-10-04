-- ─────────────────────────────────────────────────────────────
--  006 · Turnos fijos: todos los meses (sin límite de 8 semanas) + edición
--  Correr en Supabase → SQL Editor DESPUÉS de la 005.
--  Se puede correr más de una vez.
-- ─────────────────────────────────────────────────────────────

-- ══ 1) GENERAR HASTA LA FECHA QUE SE ESTÉ MIRANDO ═══════════
-- Antes: solo 8 semanas. Ahora el panel pide "generá hasta tal fecha"
-- (el mes que estás viendo, o más adelante si navegás), con tope de 1 año.
-- Un turno fijo sigue para siempre hasta que se dé de baja.
drop function if exists public.generar_turnos_fijos(date, int, uuid);

create or replace function public.generar_turnos_fijos(
  p_hoy      date,
  p_hasta    date default null,
  p_turno_id uuid default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  t           record;
  d           date;
  primera     date;
  ultima      date;
  v_hasta     date := least(coalesce(p_hasta, p_hoy + 62), p_hoy + 366);
  creadas     int := 0;
  conflictos  jsonb := '[]'::jsonb;
begin
  if not public.es_empleado() then
    raise exception 'Sin permiso.' using errcode = '42501';
  end if;

  for t in
    select tf.*, c.nombre as cliente
      from turnos_fijos tf join clientes c on c.id = tf.cliente_id
     where tf.activo and (p_turno_id is null or tf.id = p_turno_id)
  loop
    primera := greatest(p_hoy, t.desde);
    primera := primera + ((t.dia_semana - extract(dow from primera)::int + 7) % 7);
    ultima  := least(v_hasta, coalesce(t.hasta, v_hasta));
    d := primera;
    while d <= ultima loop
      -- una repetición por semana: si ya hay una en los 6 días anteriores (por ej. del
      -- horario viejo, antes de editarlo) esa semana ya está cubierta
      if not exists (select 1 from reservas where turno_fijo_id = t.id
                                             and fecha_turno_fijo >  d - 7
                                             and fecha_turno_fijo <= d) then
        begin
          insert into reservas (cancha_id, cliente_id, fecha, hora_inicio, duracion, origen, notas,
                                turno_fijo_id, fecha_turno_fijo)
          values (t.cancha_id, t.cliente_id, d, t.hora_inicio, t.duracion, 'Turno fijo', t.notas, t.id, d);
          creadas := creadas + 1;
        exception
          when exclusion_violation then
            conflictos := conflictos || jsonb_build_object(
              'fecha', d, 'hora', to_char(t.hora_inicio, 'HH24:MI'), 'cancha', t.cancha_id, 'cliente', t.cliente);
          when unique_violation then null;
        end;
      end if;
      d := d + 7;
    end loop;
  end loop;

  return jsonb_build_object('creadas', creadas, 'conflictos', conflictos, 'hasta', v_hasta);
end;
$$;
grant execute on function public.generar_turnos_fijos(date, date, uuid) to authenticated;

-- ══ 2) AUDITORÍA: permitir que la edición mueva las repeticiones ══
create or replace function public.reservas_auditar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  quien text := public.usuario_actual();
begin
  if tg_op = 'INSERT' then
    new.creada_por := quien;
    new.modificada_por := null;
    new.sena_por := null; new.sena_at := null;
    new.asistencia_por := null; new.asistencia_at := null;
    new.cancelada_por := null; new.cancelada_at := null;
    if new.estado_sena = 'Recibida' then
      new.sena_por := quien; new.sena_at := now();
    end if;
    if new.estado = 'Asistida' then
      new.asistencia_por := quien; new.asistencia_at := now();
    end if;
    if new.estado in ('Cancelada', 'No vino') then
      new.cancelada_por := quien; new.cancelada_at := now();
    end if;
    return new;
  end if;

  -- UPDATE: los campos de auditoría no se pueden pisar desde afuera
  new.creada_por     := old.creada_por;
  new.sena_por       := old.sena_por;       new.sena_at       := old.sena_at;
  new.asistencia_por := old.asistencia_por; new.asistencia_at := old.asistencia_at;
  new.cancelada_por  := old.cancelada_por;  new.cancelada_at  := old.cancelada_at;
  -- La fecha de la repetición solo la cambia editar_turno_fijo()
  if coalesce(current_setting('app.editando_turno_fijo', true), '') <> 'on' then
    new.fecha_turno_fijo := old.fecha_turno_fijo;
  end if;
  if new.turno_fijo_id is not null then new.turno_fijo_id := old.turno_fijo_id; end if;
  new.modificada_por := quien;

  if new.estado_sena = 'Recibida' and old.estado_sena is distinct from 'Recibida' then
    new.sena_por := quien; new.sena_at := now();
  end if;
  if new.estado = 'Asistida' and old.estado is distinct from 'Asistida' then
    new.asistencia_por := quien; new.asistencia_at := now();
  end if;
  if new.estado in ('Cancelada', 'No vino') and old.estado not in ('Cancelada', 'No vino') then
    new.cancelada_por := quien; new.cancelada_at := now();
  end if;
  return new;
end;
$$;

create or replace function public.registrar_actividad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  accion  text;
  detalle text;
  cliente text;
  dias    text[] := array['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;

  if tg_table_name = 'reservas' then
    -- al editar un turno fijo se mueven muchas fechas: queda un solo registro "Editó turno fijo"
    if coalesce(current_setting('app.editando_turno_fijo', true), '') = 'on' then return null; end if;
    -- las repeticiones de turnos fijos se generan solas: no ensuciamos el historial
    if tg_op = 'INSERT' and new.turno_fijo_id is not null then return null; end if;
    select nombre into cliente from clientes where id = r.cliente_id;
    detalle := format('%s · %s %s hs · %s', r.cancha_id, to_char(r.fecha, 'DD/MM/YYYY'),
                      to_char(r.hora_inicio, 'HH24:MI'), coalesce(cliente, '—'));
    if tg_op = 'INSERT' then
      accion := 'Creó reserva';
      if new.estado_sena = 'Recibida' and new.sena > 0 then
        detalle := detalle || format(' · seña %s %s', dinero(new.sena), lower(new.tipo_sena));
      end if;
    elsif tg_op = 'DELETE' then
      accion := 'Eliminó reserva';
    elsif new.estado is distinct from old.estado and new.estado = 'Cancelada' then
      if new.motivo_cancelacion = 'Baja del turno fijo' then return null; end if;  -- ya queda "Dio de baja turno fijo"
      accion := 'Canceló reserva';
      if new.estado_sena = 'Devuelta' then detalle := detalle || ' · seña devuelta';
      elsif new.estado_sena = 'Recibida' then detalle := detalle || ' · seña retenida ' || dinero(new.sena); end if;
      if coalesce(new.motivo_cancelacion, '') <> '' then detalle := detalle || ' · ' || new.motivo_cancelacion; end if;
    elsif new.estado is distinct from old.estado and new.estado = 'No vino' then
      accion := 'Marcó que no vino';
    elsif new.estado is distinct from old.estado and new.estado = 'Asistida' then
      accion := 'Confirmó asistencia';
      if new.pago_restante > 0 then
        detalle := detalle || format(' · cobró %s %s', dinero(new.pago_restante), lower(coalesce(new.tipo_pago_restante, '')));
      end if;
    elsif new.estado_sena = 'Recibida' and old.estado_sena is distinct from 'Recibida' then
      accion := 'Registró seña';
      detalle := detalle || format(' · %s %s', dinero(new.sena), lower(new.tipo_sena));
    else
      accion := 'Editó reserva';
      -- qué cambió (horario, cancha o cliente)
      if (new.fecha, new.hora_inicio, new.cancha_id, new.duracion) is distinct from (old.fecha, old.hora_inicio, old.cancha_id, old.duracion) then
        detalle := detalle || format(' · antes: %s %s %s hs%s', old.cancha_id, to_char(old.fecha, 'DD/MM'),
                                     to_char(old.hora_inicio, 'HH24:MI'),
                                     case when new.duracion <> old.duracion then format(' (%s h)', old.duracion) else '' end);
      elsif new.cliente_id is distinct from old.cliente_id then
        detalle := detalle || ' · antes: ' || coalesce((select nombre from clientes where id = old.cliente_id), '—');
      elsif (new.sena, new.tipo_sena, new.estado_sena) is distinct from (old.sena, old.tipo_sena, old.estado_sena) then
        detalle := detalle || format(' · seña: %s %s (%s)', dinero(new.sena), lower(new.tipo_sena), lower(new.estado_sena));
      end if;
    end if;

  elsif tg_table_name = 'egresos' then
    detalle := format('%s · %s · %s', r.categoria, dinero(r.monto), coalesce(nullif(r.descripcion, ''), lower(r.forma_pago)));
    accion := case tg_op when 'INSERT' then 'Registró egreso' when 'DELETE' then 'Eliminó egreso' else 'Editó egreso' end;

  elsif tg_table_name = 'turnos_fijos' then
    select nombre into cliente from clientes where id = r.cliente_id;
    detalle := format('%s %s hs · %s · %s', dias[r.dia_semana + 1], to_char(r.hora_inicio, 'HH24:MI'), r.cancha_id, coalesce(cliente, '—'));
    if tg_op = 'INSERT' then accion := 'Creó turno fijo';
    elsif tg_op = 'UPDATE' and old.activo and not new.activo then accion := 'Dio de baja turno fijo';
    elsif tg_op = 'UPDATE' and (new.cancha_id, new.cliente_id, new.dia_semana, new.hora_inicio, new.duracion, coalesce(new.notas, ''))
                       is distinct from (old.cancha_id, old.cliente_id, old.dia_semana, old.hora_inicio, old.duracion, coalesce(old.notas, '')) then
      accion := 'Editó turno fijo';
      declare cliente_ant text; begin
        select nombre into cliente_ant from clientes where id = old.cliente_id;
        detalle := format('%s %s hs · %s · %s → %s', dias[old.dia_semana + 1], to_char(old.hora_inicio, 'HH24:MI'),
                          old.cancha_id, coalesce(cliente_ant, '—'), detalle);
      end;
    elsif tg_op = 'UPDATE' then return null;
    else accion := 'Eliminó turno fijo'; end if;

  elsif tg_table_name = 'empleados' then
    detalle := format('%s (%s)', r.email, r.rol);
    if tg_op = 'INSERT' then accion := 'Dio de alta a una persona';
    elsif tg_op = 'DELETE' then accion := 'Eliminó a una persona';
    elsif new.activo is distinct from old.activo then
      accion := case when new.activo then 'Reactivó a una persona' else 'Dio de baja a una persona' end;
    elsif new.rol is distinct from old.rol then
      accion := 'Cambió el rol'; detalle := format('%s: %s → %s', r.email, old.rol, new.rol);
    elsif new.nombre is distinct from old.nombre then
      accion := 'Cambió el nombre'; detalle := format('%s: %s', r.email, coalesce(new.nombre, '—'));
    else
      return null;   -- ej.: solo se actualizó el último acceso
    end if;

  elsif tg_table_name = 'canchas' then
    if new.precio_hora is not distinct from old.precio_hora then return null; end if;
    accion := 'Cambió precio';
    detalle := format('%s %s: %s → %s por hora', r.tipo, r.etiqueta, dinero(old.precio_hora), dinero(new.precio_hora));

  elsif tg_table_name = 'configuracion' then
    if new.hora_apertura = old.hora_apertura and new.hora_cierre = old.hora_cierre then return null; end if;
    accion := 'Cambió horarios';
    detalle := format('%s a %s hs → %s a %s hs', old.hora_apertura, old.hora_cierre, new.hora_apertura, new.hora_cierre);
  else
    return null;
  end if;

  insert into actividad (usuario, email, accion, tabla, registro_id, detalle)
  values (usuario_actual(), lower(auth.jwt() ->> 'email'), accion, tg_table_name,
          case when tg_table_name in ('configuracion') then null else (to_jsonb(r) ->> case when tg_table_name = 'empleados' then 'email' else 'id' end) end,
          detalle);
  return null;
end;
$$;

-- ══ 3) EDITAR UN TURNO FIJO ═════════════════════════════════
-- Cambia cancha, día, hora, duración, cliente o notas desde la fecha p_desde
-- (por defecto hoy). Las repeticiones ya cargadas desde esa fecha se mueven
-- al nuevo horario (conservan la seña si ya la pagaron). Las anteriores, las ya
-- jugadas, las canceladas y las que se movieron a mano no se tocan.
-- Si el nuevo horario está ocupado alguna semana, esa fecha queda como estaba
-- y se informa en "no_movidas".
create or replace function public.editar_turno_fijo(
  p_id         uuid,
  p_cancha     text,
  p_cliente_id uuid,
  p_dia        int,
  p_hora       time,
  p_duracion   int,
  p_notas      text,
  p_desde      date,
  p_hoy        date,
  p_hasta      date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t          public.turnos_fijos%rowtype;
  r          record;
  delta      int;
  v_desde    date := greatest(coalesce(p_desde, p_hoy), p_hoy);
  v_notas    text := nullif(trim(coalesce(p_notas, '')), '');
  movidas    int := 0;
  no_movidas jsonb := '[]'::jsonb;
  gen        jsonb;
begin
  if not public.es_empleado() then
    raise exception 'Sin permiso.' using errcode = '42501';
  end if;
  if p_dia not between 0 and 6 or p_duracion not between 1 and 5 then
    raise exception 'Datos inválidos.' using errcode = '22023';
  end if;

  select * into t from public.turnos_fijos where id = p_id and activo for update;
  if not found then
    raise exception 'El turno fijo no existe o ya fue dado de baja.' using errcode = 'P0002';
  end if;

  -- cuántos días se corre cada repetición (siempre hacia adelante, 0 a 6)
  delta := ((p_dia - t.dia_semana) + 7) % 7;

  -- 1) el turno en sí (si pisa otro turno fijo activo, falla con 23P01)
  update public.turnos_fijos
     set cancha_id = p_cancha, cliente_id = p_cliente_id, dia_semana = p_dia,
         hora_inicio = p_hora, duracion = p_duracion, notas = v_notas
   where id = p_id;

  perform set_config('app.editando_turno_fijo', 'on', true);

  -- 2) las repeticiones ya cargadas desde v_desde
  for r in
    select * from public.reservas
     where turno_fijo_id = p_id and fecha_turno_fijo >= v_desde
     order by fecha_turno_fijo desc
  loop
    -- la "semana" de la repetición se corre al nuevo día (así no se duplica)
    if delta <> 0 then
      update public.reservas set fecha_turno_fijo = r.fecha_turno_fijo + delta where id = r.id;
    end if;
    -- solo se mueven las pendientes que no se editaron a mano
    if r.estado = 'Confirmada' and r.fecha = r.fecha_turno_fijo then
      begin
        update public.reservas
           set cancha_id   = p_cancha,
               cliente_id  = p_cliente_id,
               fecha       = r.fecha + delta,
               hora_inicio = p_hora,
               duracion    = p_duracion,
               notas       = case when r.notas is not distinct from t.notas then v_notas else r.notas end
         where id = r.id;
        movidas := movidas + 1;
      exception when exclusion_violation then
        no_movidas := no_movidas || jsonb_build_object(
          'fecha', r.fecha + delta, 'hora', to_char(p_hora, 'HH24:MI'), 'cancha', p_cancha);
      end;
    end if;
  end loop;

  perform set_config('app.editando_turno_fijo', 'off', true);

  -- 3) completar semanas que falten con el horario nuevo
  gen := public.generar_turnos_fijos(p_hoy, p_hasta, p_id);

  return jsonb_build_object(
    'movidas',    movidas,
    'no_movidas', no_movidas,
    'creadas',    coalesce((gen ->> 'creadas')::int, 0),
    'conflictos', coalesce(gen -> 'conflictos', '[]'::jsonb)
  );
end;
$$;
grant execute on function public.editar_turno_fijo(uuid, text, uuid, int, time, int, text, date, date, date) to authenticated;

select 'ok' as migracion_006;
