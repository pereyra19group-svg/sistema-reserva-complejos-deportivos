-- ════════════════════════════════════════════════════════════════════
--  INSTALADOR — Sistema de Reservas para Complejos Deportivos
--  Crea la base completa (estado actual = migraciones 001 → 010) en un
--  proyecto NUEVO de Supabase, vacío. Sin reservas, clientes ni canchas.
--
--  Cómo usarlo: proyecto nuevo → SQL Editor → pegar TODO → Run.
--  Corre en una sola transacción: si algo falla, no queda nada a medias.
--  Después: ver "PASOS DESPUÉS DEL INSTALADOR" al final de este archivo.
-- ════════════════════════════════════════════════════════════════════

begin;

set local check_function_bodies = off;

-- ══ 0) EXTENSIÓN ═════════════════════════════════════════════════════
-- btree_gist: necesaria para que no se superpongan reservas ni turnos fijos
create extension if not exists btree_gist with schema public;

-- ══ 1) FUNCIONES ═════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.baja_turno_fijo(p_id uuid, p_hoy date)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare n int;
begin
  if not public.es_empleado() then
    raise exception 'Sin permiso.' using errcode = '42501';
  end if;
  update turnos_fijos set activo = false, hasta = p_hoy where id = p_id and activo;
  update reservas
     set estado = 'Cancelada', motivo_cancelacion = 'Baja del turno fijo'
   where turno_fijo_id = p_id and fecha > p_hoy and estado = 'Confirmada';
  get diagnostics n = row_count;
  return n;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.cambiar_estado_cancha(p_id text, p_activa boolean, p_hoy date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare uso jsonb;
begin
  if not es_jefe() then raise exception 'Solo un Admin puede modificar canchas.'; end if;
  if not p_activa then
    uso := uso_cancha(p_id, p_hoy);
    if (uso ->> 'reservas_futuras')::int > 0 or (uso ->> 'fijos_activos')::int > 0 then
      return jsonb_build_object('ok', false, 'uso', uso);
    end if;
  end if;
  update canchas set activa = p_activa where id = p_id;
  return jsonb_build_object('ok', true);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.crear_cancha(p_tipo text, p_etiqueta text, p_precio numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  n   int;
  nid text;
begin
  if not es_jefe() then raise exception 'Solo un Admin puede crear canchas.'; end if;
  if p_tipo not in ('F5', 'F6', 'F7', 'F8', 'F9', 'F11') then raise exception 'Tipo de cancha inválido.'; end if;
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
$function$
;

CREATE OR REPLACE FUNCTION public.dinero(v numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select '$' || replace(to_char(coalesce(v, 0), 'FM999G999G999'), ',', '.');
$function$
;

CREATE OR REPLACE FUNCTION public.editar_turno_fijo(p_id uuid, p_cancha text, p_cliente_id uuid, p_dia integer, p_hora time without time zone, p_duracion integer, p_notas text, p_desde date, p_hoy date, p_hasta date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.eliminar_cancha(p_id text, p_hoy date, p_forzar boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare uso jsonb;
begin
  if not es_jefe() then raise exception 'Solo un Admin puede eliminar canchas.'; end if;
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
$function$
;

CREATE OR REPLACE FUNCTION public.empleados_exigir_un_jefe()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if not exists (select 1 from public.empleados where rol = 'jefe' and activo) then
    raise exception 'Tiene que quedar al menos un Admin activo.' using errcode = 'P0001';
  end if;
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.es_empleado()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.empleados
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
      and activo
  );
$function$
;

CREATE OR REPLACE FUNCTION public.es_jefe()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.empleados
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
      and activo
      and rol = 'jefe'
  );
$function$
;

CREATE OR REPLACE FUNCTION public.generar_turnos_fijos(p_hoy date, p_hasta date DEFAULT NULL::date, p_turno_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.id_usuario_por_email(p_email text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.marcar_acceso()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update public.empleados set ultimo_acceso = now()
   where email = lower(auth.jwt() ->> 'email') and activo;
$function$
;

CREATE OR REPLACE FUNCTION public.registrar_actividad_cancha()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.registrar_actividad()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.reservas_auditar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.reservas_calcular_precio()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'INSERT'
     or new.cancha_id is distinct from old.cancha_id
     or new.duracion  is distinct from old.duracion then
    select c.precio_hora * new.duracion
      into new.precio
      from public.canchas c
     where c.id = new.cancha_id;
  end if;
  new.updated_at := now();
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_creado_por()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    new.creado_por := public.usuario_actual();
  else
    new.creado_por := old.creado_por;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.tocar_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.turnos_fijos_baja_auditar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if old.activo and not new.activo then
    new.dado_de_baja_por := public.usuario_actual();
    new.baja_at := now();
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.uso_cancha(p_id text, p_hoy date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'reservas_total',   (select count(*) from reservas where cancha_id = p_id),
    'reservas_futuras', (select count(*) from reservas
                          where cancha_id = p_id and fecha >= p_hoy and estado = 'Confirmada'),
    'fijos_total',      (select count(*) from turnos_fijos where cancha_id = p_id),
    'fijos_activos',    (select count(*) from turnos_fijos where cancha_id = p_id and activo)
  );
$function$
;

CREATE OR REPLACE FUNCTION public.usuario_actual()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    (select coalesce(nullif(trim(e.nombre), ''), e.email)
       from public.empleados e
      where e.email = lower(auth.jwt() ->> 'email')),
    nullif(lower(auth.jwt() ->> 'email'), ''),
    'Sistema'
  );
$function$
;

-- ══ 2) TABLAS ════════════════════════════════════════════════════════

create table public.actividad (
  id bigint generated always as identity,
  creado_at timestamp with time zone default now() not null,
  usuario text not null,
  email text,
  accion text not null,
  tabla text not null,
  registro_id text,
  detalle text,
  constraint actividad_pkey PRIMARY KEY (id)
);

create table public.canchas (
  id text not null,
  tipo text not null,
  etiqueta text not null,
  precio_hora numeric(12,2) not null,
  activa boolean default true not null,
  orden integer default 0 not null,
  eliminada boolean default false not null,
  constraint canchas_precio_hora_check CHECK ((precio_hora >= (0)::numeric)),
  constraint canchas_tipo_check CHECK ((tipo = ANY (ARRAY['F5'::text, 'F6'::text, 'F7'::text, 'F8'::text, 'F9'::text, 'F11'::text]))),
  constraint canchas_pkey PRIMARY KEY (id)
);

create table public.clientes (
  id uuid default gen_random_uuid() not null,
  nombre text not null,
  telefono text not null,
  notas text,
  created_at timestamp with time zone default now() not null,
  constraint clientes_pkey PRIMARY KEY (id),
  constraint clientes_telefono_key UNIQUE (telefono)
);

create table public.configuracion (
  hora_apertura integer default 9 not null,
  hora_cierre integer default 24 not null,
  id integer default 1 not null,
  constraint configuracion_check CHECK ((hora_apertura < hora_cierre)),
  constraint configuracion_hora_apertura_check CHECK (((hora_apertura >= 0) AND (hora_apertura <= 23))),
  constraint configuracion_hora_cierre_check CHECK (((hora_cierre >= 1) AND (hora_cierre <= 24))),
  constraint configuracion_id_check CHECK ((id = 1)),
  constraint configuracion_pkey PRIMARY KEY (id)
);

create table public.egresos (
  id uuid default gen_random_uuid() not null,
  fecha date not null,
  categoria text not null,
  descripcion text,
  monto numeric(12,2) not null,
  forma_pago text not null,
  notas text,
  created_at timestamp with time zone default now() not null,
  creado_por text,
  constraint egresos_categoria_check CHECK ((categoria = ANY (ARRAY['Luz'::text, 'Gas'::text, 'Agua'::text, 'Mantenimiento'::text, 'Limpieza'::text, 'Personal'::text, 'Buffet'::text, 'Alquiler'::text, 'Impuestos'::text, 'Otros'::text]))),
  constraint egresos_forma_pago_check CHECK ((forma_pago = ANY (ARRAY['Efectivo'::text, 'Transferencia'::text]))),
  constraint egresos_monto_check CHECK ((monto > (0)::numeric)),
  constraint egresos_pkey PRIMARY KEY (id)
);

create table public.empleados (
  email text not null,
  nombre text,
  activo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  rol text default 'empleado'::text not null,
  ultimo_acceso timestamp with time zone,
  constraint empleados_email_check CHECK ((email = lower(email))),
  constraint empleados_rol_check CHECK ((rol = ANY (ARRAY['jefe'::text, 'empleado'::text]))),
  constraint empleados_pkey PRIMARY KEY (email)
);

create table public.reservas (
  id uuid default gen_random_uuid() not null,
  cancha_id text not null,
  cliente_id uuid not null,
  fecha date not null,
  hora_inicio time without time zone not null,
  duracion integer default 1 not null,
  precio numeric(12,2) default 0 not null,
  sena numeric(12,2) default 0 not null,
  tipo_sena text default 'Sin seña'::text not null,
  estado_sena text default 'Pendiente'::text not null,
  estado text default 'Confirmada'::text not null,
  pago_restante numeric(12,2) default 0 not null,
  tipo_pago_restante text,
  notas text,
  origen text default 'Dashboard'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  rango tsrange generated always as (tsrange((fecha + hora_inicio), ((fecha + hora_inicio) + make_interval(hours => duracion)))) stored,
  creada_por text,
  modificada_por text,
  sena_por text,
  sena_at timestamp with time zone,
  asistencia_por text,
  asistencia_at timestamp with time zone,
  cancelada_por text,
  cancelada_at timestamp with time zone,
  motivo_cancelacion text,
  turno_fijo_id uuid,
  fecha_turno_fijo date,
  pago_restante_transf numeric(10,2) default 0 not null,
  constraint reservas_duracion_check CHECK (((duracion >= 1) AND (duracion <= 5))),
  constraint reservas_estado_check CHECK ((estado = ANY (ARRAY['Confirmada'::text, 'Asistida'::text, 'Cancelada'::text, 'No vino'::text]))),
  constraint reservas_estado_sena_check CHECK ((estado_sena = ANY (ARRAY['Pendiente'::text, 'Recibida'::text, 'Devuelta'::text]))),
  constraint reservas_pago_restante_check CHECK ((pago_restante >= (0)::numeric)),
  constraint reservas_pago_restante_transf_check CHECK (((pago_restante_transf >= (0)::numeric) AND (pago_restante_transf <= pago_restante))),
  constraint reservas_sena_check CHECK ((sena >= (0)::numeric)),
  constraint reservas_tipo_pago_restante_check CHECK ((tipo_pago_restante = ANY (ARRAY['Efectivo'::text, 'Transferencia'::text, 'Mixto'::text]))),
  constraint reservas_tipo_sena_check CHECK ((tipo_sena = ANY (ARRAY['Sin seña'::text, 'Efectivo'::text, 'Transferencia'::text]))),
  constraint reservas_pkey PRIMARY KEY (id),
  constraint reservas_sin_superposicion EXCLUDE USING gist (cancha_id WITH =, rango WITH &&) WHERE ((estado = ANY (ARRAY['Confirmada'::text, 'Asistida'::text])))
);

create table public.turnos_fijos (
  id uuid default gen_random_uuid() not null,
  cancha_id text not null,
  cliente_id uuid not null,
  dia_semana integer not null,
  hora_inicio time without time zone not null,
  duracion integer default 1 not null,
  desde date not null,
  hasta date,
  activo boolean default true not null,
  notas text,
  creado_por text,
  dado_de_baja_por text,
  baja_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  minutos int4range generated always as (int4range((((EXTRACT(hour FROM hora_inicio) * (60)::numeric) + EXTRACT(minute FROM hora_inicio)))::integer, ((((EXTRACT(hour FROM hora_inicio) * (60)::numeric) + EXTRACT(minute FROM hora_inicio)))::integer + (duracion * 60)))) stored,
  constraint turnos_fijos_dia_semana_check CHECK (((dia_semana >= 0) AND (dia_semana <= 6))),
  constraint turnos_fijos_duracion_check CHECK (((duracion >= 1) AND (duracion <= 5))),
  constraint turnos_fijos_pkey PRIMARY KEY (id),
  constraint turnos_fijos_sin_superposicion EXCLUDE USING gist (cancha_id WITH =, dia_semana WITH =, minutos WITH &&) WHERE (activo)
);

-- ══ 3) CLAVES FORÁNEAS ═══════════════════════════════════════════════

alter table public.reservas add constraint reservas_cancha_id_fkey FOREIGN KEY (cancha_id) REFERENCES public.canchas(id);
alter table public.reservas add constraint reservas_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id);
alter table public.reservas add constraint reservas_turno_fijo_id_fkey FOREIGN KEY (turno_fijo_id) REFERENCES public.turnos_fijos(id) ON DELETE SET NULL;
alter table public.turnos_fijos add constraint turnos_fijos_cancha_id_fkey FOREIGN KEY (cancha_id) REFERENCES public.canchas(id);
alter table public.turnos_fijos add constraint turnos_fijos_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id);

-- ══ 4) ÍNDICES ═══════════════════════════════════════════════════════

CREATE INDEX actividad_fecha_idx ON public.actividad USING btree (creado_at DESC);
CREATE INDEX egresos_fecha_idx ON public.egresos USING btree (fecha);
CREATE INDEX reservas_fecha_idx ON public.reservas USING btree (fecha);
CREATE UNIQUE INDEX reservas_turno_fijo_fecha_uq ON public.reservas USING btree (turno_fijo_id, fecha_turno_fijo) WHERE (turno_fijo_id IS NOT NULL);

-- ══ 5) TRIGGERS ══════════════════════════════════════════════════════

CREATE TRIGGER actividad_canchas AFTER INSERT OR DELETE OR UPDATE ON public.canchas FOR EACH ROW EXECUTE FUNCTION public.registrar_actividad_cancha();
CREATE TRIGGER actividad_configuracion AFTER UPDATE ON public.configuracion FOR EACH ROW EXECUTE FUNCTION public.registrar_actividad();
CREATE TRIGGER actividad_egresos AFTER INSERT OR DELETE OR UPDATE ON public.egresos FOR EACH ROW EXECUTE FUNCTION public.registrar_actividad();
CREATE TRIGGER egresos_creado_por BEFORE INSERT OR UPDATE ON public.egresos FOR EACH ROW EXECUTE FUNCTION public.set_creado_por();
CREATE TRIGGER actividad_empleados AFTER INSERT OR DELETE OR UPDATE ON public.empleados FOR EACH ROW EXECUTE FUNCTION public.registrar_actividad();
CREATE CONSTRAINT TRIGGER empleados_un_jefe AFTER DELETE OR UPDATE ON public.empleados DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.empleados_exigir_un_jefe();
CREATE TRIGGER actividad_reservas AFTER INSERT OR DELETE OR UPDATE ON public.reservas FOR EACH ROW EXECUTE FUNCTION public.registrar_actividad();
CREATE TRIGGER reservas_auditoria BEFORE INSERT OR UPDATE ON public.reservas FOR EACH ROW EXECUTE FUNCTION public.reservas_auditar();
CREATE TRIGGER reservas_precio BEFORE INSERT OR UPDATE OF cancha_id, duracion ON public.reservas FOR EACH ROW EXECUTE FUNCTION public.reservas_calcular_precio();
CREATE TRIGGER reservas_updated_at BEFORE UPDATE ON public.reservas FOR EACH ROW EXECUTE FUNCTION public.tocar_updated_at();
CREATE TRIGGER actividad_turnos_fijos AFTER INSERT OR DELETE OR UPDATE ON public.turnos_fijos FOR EACH ROW EXECUTE FUNCTION public.registrar_actividad();
CREATE TRIGGER turnos_fijos_baja BEFORE UPDATE ON public.turnos_fijos FOR EACH ROW EXECUTE FUNCTION public.turnos_fijos_baja_auditar();
CREATE TRIGGER turnos_fijos_creado_por BEFORE INSERT OR UPDATE ON public.turnos_fijos FOR EACH ROW EXECUTE FUNCTION public.set_creado_por();

-- ══ 6) SEGURIDAD: RLS Y POLÍTICAS ════════════════════════════════════

alter table public.actividad enable row level security;
alter table public.canchas enable row level security;
alter table public.clientes enable row level security;
alter table public.configuracion enable row level security;
alter table public.egresos enable row level security;
alter table public.empleados enable row level security;
alter table public.reservas enable row level security;
alter table public.turnos_fijos enable row level security;

create policy "jefes ven actividad" on public.actividad as permissive for select to authenticated
  using (es_jefe());
create policy "empleados leen canchas" on public.canchas as permissive for select to authenticated
  using (es_empleado());
create policy "jefes crean canchas" on public.canchas as permissive for insert to authenticated
  with check (es_jefe());
create policy "jefes editan canchas" on public.canchas as permissive for update to authenticated
  using (es_jefe())
  with check (es_jefe());
create policy "jefes eliminan canchas" on public.canchas as permissive for delete to authenticated
  using (es_jefe());
create policy "empleados gestionan clientes" on public.clientes as permissive for all to authenticated
  using (es_empleado())
  with check (es_empleado());
create policy "empleados leen configuracion" on public.configuracion as permissive for select to authenticated
  using (es_empleado());
create policy "jefes editan configuracion" on public.configuracion as permissive for update to authenticated
  using (es_jefe())
  with check (es_jefe());
create policy "jefes gestionan egresos" on public.egresos as permissive for all to authenticated
  using (es_jefe())
  with check (es_jefe());
create policy "empleado ve su propio registro" on public.empleados as permissive for select to authenticated
  using ((email = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))));
create policy "jefes modifican empleados" on public.empleados as permissive for all to authenticated
  using (es_jefe())
  with check (es_jefe());
create policy "jefes ven empleados" on public.empleados as permissive for select to authenticated
  using (es_jefe());
create policy "empleados crean reservas" on public.reservas as permissive for insert to authenticated
  with check (es_empleado());
create policy "empleados modifican reservas" on public.reservas as permissive for update to authenticated
  using (es_empleado())
  with check (es_empleado());
create policy "empleados ven reservas" on public.reservas as permissive for select to authenticated
  using (es_empleado());
create policy "jefes eliminan reservas" on public.reservas as permissive for delete to authenticated
  using (es_jefe());
create policy "empleados crean turnos fijos" on public.turnos_fijos as permissive for insert to authenticated
  with check (es_empleado());
create policy "empleados gestionan turnos fijos" on public.turnos_fijos as permissive for select to authenticated
  using (es_empleado());
create policy "empleados modifican turnos fijos" on public.turnos_fijos as permissive for update to authenticated
  using (es_empleado())
  with check (es_empleado());

-- Solo la Edge Function (service_role) puede buscar usuarios de login por email
revoke all on function public.id_usuario_por_email(text) from public, anon, authenticated, service_role;
grant execute on function public.id_usuario_por_email(text) to service_role;

-- ══ 7) DATOS INICIALES ═══════════════════════════════════════════════
-- Horario del complejo (se cambia después desde Equipo → Precios y horarios)
insert into public.configuracion (id, hora_apertura, hora_cierre) values (1, 16, 24);

commit;

-- ════════════════════════════════════════════════════════════════════
--  PASOS DESPUÉS DEL INSTALADOR (en el proyecto nuevo de Supabase)
--
--  1. Authentication → Sign In / Providers → desactivar "Allow new users to sign up".
--
--  2. Primer Admin: Authentication → Users → Add user → email + contraseña,
--     marcar "Auto confirm". Después, en el SQL Editor, correr (con sus datos):
--
--       insert into public.empleados (email, nombre, rol)
--       values (lower('email@del-admin.com'), 'Nombre', 'jefe');
--
--     El resto del equipo se da de alta desde el panel (Equipo).
--
--  3. Edge Functions → Deploy a new function → Via Editor → nombre "alta-empleado"
--     → pegar supabase/functions/alta-empleado/index.ts → Deploy
--     → en Details desactivar "Verify JWT".
--
--  4. Project Settings → API → copiar Project URL y anon public key en
--     app/frontend/js/supabase-config.js de la copia del panel del cliente.
-- ════════════════════════════════════════════════════════════════════
