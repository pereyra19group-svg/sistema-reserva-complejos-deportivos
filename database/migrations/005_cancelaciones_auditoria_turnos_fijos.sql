-- ─────────────────────────────────────────────────────────────
--  005 · Cancelaciones, quién hizo qué, turnos fijos, precios/horarios
--        editables y "último acceso" del equipo.
--  Correr en Supabase → SQL Editor DESPUÉS de 001 a 004.
--  Se puede correr más de una vez.
-- ─────────────────────────────────────────────────────────────

-- ══ 1) USUARIO ACTUAL ═══════════════════════════════════════
-- Nombre (o email) de quien hace la operación, sacado del login.
-- Si la operación viene del servidor (n8n / service_role) devuelve 'Sistema'.
create or replace function public.usuario_actual()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select coalesce(nullif(trim(e.nombre), ''), e.email)
       from public.empleados e
      where e.email = lower(auth.jwt() ->> 'email')),
    nullif(lower(auth.jwt() ->> 'email'), ''),
    'Sistema'
  );
$$;
grant execute on function public.usuario_actual() to authenticated;

-- ══ 2) CONFIGURACIÓN (horarios) ═════════════════════════════
create table if not exists public.configuracion (
  id             int primary key default 1 check (id = 1),   -- una sola fila
  hora_apertura  int not null default 9  check (hora_apertura between 0 and 23),
  hora_cierre    int not null default 24 check (hora_cierre between 1 and 24),  -- 24 = último turno 23:00
  check (hora_apertura < hora_cierre)
);
insert into public.configuracion (id) values (1) on conflict (id) do nothing;

alter table public.configuracion enable row level security;
drop policy if exists "empleados leen configuracion" on public.configuracion;
create policy "empleados leen configuracion" on public.configuracion
  for select to authenticated using (public.es_empleado());
drop policy if exists "jefes editan configuracion" on public.configuracion;
create policy "jefes editan configuracion" on public.configuracion
  for update to authenticated using (public.es_jefe()) with check (public.es_jefe());

-- Precios: los jefes pueden cambiarlos desde el panel
drop policy if exists "jefes editan canchas" on public.canchas;
create policy "jefes editan canchas" on public.canchas
  for update to authenticated using (public.es_jefe()) with check (public.es_jefe());

-- ══ 3) TURNOS FIJOS ═════════════════════════════════════════
create table if not exists public.turnos_fijos (
  id               uuid primary key default gen_random_uuid(),
  cancha_id        text not null references public.canchas(id),
  cliente_id       uuid not null references public.clientes(id),
  dia_semana       int  not null check (dia_semana between 0 and 6),   -- 0 = domingo … 6 = sábado
  hora_inicio      time not null,
  duracion         int  not null default 1 check (duracion between 1 and 5),
  desde            date not null,
  hasta            date,
  activo           boolean not null default true,
  notas            text,
  creado_por       text,
  dado_de_baja_por text,
  baja_at          timestamptz,
  created_at       timestamptz not null default now(),
  minutos int4range generated always as (
    int4range((extract(hour from hora_inicio) * 60 + extract(minute from hora_inicio))::int,
              (extract(hour from hora_inicio) * 60 + extract(minute from hora_inicio))::int + duracion * 60)
  ) stored
);

-- Dos turnos fijos activos no pueden pisarse (misma cancha, mismo día y horario)
do $$ begin
  alter table public.turnos_fijos add constraint turnos_fijos_sin_superposicion
    exclude using gist (cancha_id with =, dia_semana with =, minutos with &&) where (activo);
exception when duplicate_object or duplicate_table then null; end $$;

alter table public.turnos_fijos enable row level security;
drop policy if exists "empleados gestionan turnos fijos" on public.turnos_fijos;
create policy "empleados gestionan turnos fijos" on public.turnos_fijos
  for select to authenticated using (public.es_empleado());
drop policy if exists "empleados crean turnos fijos" on public.turnos_fijos;
create policy "empleados crean turnos fijos" on public.turnos_fijos
  for insert to authenticated with check (public.es_empleado());
drop policy if exists "empleados modifican turnos fijos" on public.turnos_fijos;
create policy "empleados modifican turnos fijos" on public.turnos_fijos
  for update to authenticated using (public.es_empleado()) with check (public.es_empleado());

-- ══ 4) RESERVAS: estados nuevos + quién hizo cada cosa ══════
alter table public.reservas drop constraint if exists reservas_estado_check;
alter table public.reservas add constraint reservas_estado_check
  check (estado in ('Confirmada', 'Asistida', 'Cancelada', 'No vino'));

alter table public.reservas drop constraint if exists reservas_estado_sena_check;
alter table public.reservas add constraint reservas_estado_sena_check
  check (estado_sena in ('Pendiente', 'Recibida', 'Devuelta'));

alter table public.reservas
  add column if not exists creada_por         text,
  add column if not exists modificada_por     text,
  add column if not exists sena_por           text,
  add column if not exists sena_at            timestamptz,
  add column if not exists asistencia_por     text,
  add column if not exists asistencia_at      timestamptz,
  add column if not exists cancelada_por      text,
  add column if not exists cancelada_at       timestamptz,
  add column if not exists motivo_cancelacion text,
  add column if not exists turno_fijo_id      uuid references public.turnos_fijos(id) on delete set null,
  add column if not exists fecha_turno_fijo   date;   -- fecha original de la repetición (no cambia si se mueve)

-- Una sola reserva por turno fijo y por semana
create unique index if not exists reservas_turno_fijo_fecha_uq
  on public.reservas (turno_fijo_id, fecha_turno_fijo) where turno_fijo_id is not null;

-- Las canceladas y "no vino" liberan la cancha
alter table public.reservas drop constraint if exists reservas_sin_superposicion;
alter table public.reservas add constraint reservas_sin_superposicion
  exclude using gist (cancha_id with =, rango with &&) where (estado in ('Confirmada', 'Asistida'));

-- Precio: solo se recalcula si cambia la cancha o la duración
-- (así editar una reserva vieja no le cambia el precio si después subiste la tarifa)
create or replace function public.reservas_calcular_precio()
returns trigger
language plpgsql
as $$
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
$$;

-- Registra automáticamente quién crea, cobra, confirma o cancela.
-- Lo hace la base, así nadie lo puede falsear desde el navegador.
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
  new.fecha_turno_fijo := old.fecha_turno_fijo;
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

drop trigger if exists reservas_auditoria on public.reservas;
create trigger reservas_auditoria
  before insert or update on public.reservas
  for each row execute function public.reservas_auditar();

-- Egresos y turnos fijos: quién los cargó
alter table public.egresos add column if not exists creado_por text;

create or replace function public.set_creado_por()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.creado_por := public.usuario_actual();
  else
    new.creado_por := old.creado_por;
  end if;
  return new;
end;
$$;

drop trigger if exists egresos_creado_por on public.egresos;
create trigger egresos_creado_por before insert or update on public.egresos
  for each row execute function public.set_creado_por();

drop trigger if exists turnos_fijos_creado_por on public.turnos_fijos;
create trigger turnos_fijos_creado_por before insert or update on public.turnos_fijos
  for each row execute function public.set_creado_por();

create or replace function public.turnos_fijos_baja_auditar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.activo and not new.activo then
    new.dado_de_baja_por := public.usuario_actual();
    new.baja_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists turnos_fijos_baja on public.turnos_fijos;
create trigger turnos_fijos_baja before update on public.turnos_fijos
  for each row execute function public.turnos_fijos_baja_auditar();

-- Solo los jefes pueden ELIMINAR reservas; el resto las cancela (queda registro)
drop policy if exists "empleados gestionan reservas" on public.reservas;
drop policy if exists "empleados ven reservas"       on public.reservas;
drop policy if exists "empleados crean reservas"     on public.reservas;
drop policy if exists "empleados modifican reservas" on public.reservas;
drop policy if exists "jefes eliminan reservas"      on public.reservas;
create policy "empleados ven reservas" on public.reservas
  for select to authenticated using (public.es_empleado());
create policy "empleados crean reservas" on public.reservas
  for insert to authenticated with check (public.es_empleado());
create policy "empleados modifican reservas" on public.reservas
  for update to authenticated using (public.es_empleado()) with check (public.es_empleado());
create policy "jefes eliminan reservas" on public.reservas
  for delete to authenticated using (public.es_jefe());

-- ══ 5) HISTORIAL DE ACTIVIDAD ═══════════════════════════════
create table if not exists public.actividad (
  id          bigint generated always as identity primary key,
  creado_at   timestamptz not null default now(),
  usuario     text not null,
  email       text,
  accion      text not null,
  tabla       text not null,
  registro_id text,
  detalle     text
);
create index if not exists actividad_fecha_idx on public.actividad (creado_at desc);

alter table public.actividad enable row level security;
drop policy if exists "jefes ven actividad" on public.actividad;
create policy "jefes ven actividad" on public.actividad
  for select to authenticated using (public.es_jefe());

create or replace function public.dinero(v numeric)
returns text language sql immutable as $$
  select '$' || replace(to_char(coalesce(v, 0), 'FM999G999G999'), ',', '.');
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
    end if;

  elsif tg_table_name = 'egresos' then
    detalle := format('%s · %s · %s', r.categoria, dinero(r.monto), coalesce(nullif(r.descripcion, ''), lower(r.forma_pago)));
    accion := case tg_op when 'INSERT' then 'Registró egreso' when 'DELETE' then 'Eliminó egreso' else 'Editó egreso' end;

  elsif tg_table_name = 'turnos_fijos' then
    select nombre into cliente from clientes where id = r.cliente_id;
    detalle := format('%s %s hs · %s · %s', dias[r.dia_semana + 1], to_char(r.hora_inicio, 'HH24:MI'), r.cancha_id, coalesce(cliente, '—'));
    if tg_op = 'INSERT' then accion := 'Creó turno fijo';
    elsif tg_op = 'UPDATE' and old.activo and not new.activo then accion := 'Dio de baja turno fijo';
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

drop trigger if exists actividad_reservas on public.reservas;
create trigger actividad_reservas after insert or update or delete on public.reservas
  for each row execute function public.registrar_actividad();
drop trigger if exists actividad_egresos on public.egresos;
create trigger actividad_egresos after insert or update or delete on public.egresos
  for each row execute function public.registrar_actividad();
drop trigger if exists actividad_turnos_fijos on public.turnos_fijos;
create trigger actividad_turnos_fijos after insert or update or delete on public.turnos_fijos
  for each row execute function public.registrar_actividad();
drop trigger if exists actividad_empleados on public.empleados;
create trigger actividad_empleados after insert or update or delete on public.empleados
  for each row execute function public.registrar_actividad();
drop trigger if exists actividad_canchas on public.canchas;
create trigger actividad_canchas after update on public.canchas
  for each row execute function public.registrar_actividad();
drop trigger if exists actividad_configuracion on public.configuracion;
create trigger actividad_configuracion after update on public.configuracion
  for each row execute function public.registrar_actividad();

-- ══ 6) GENERAR LAS REPETICIONES DE LOS TURNOS FIJOS ═════════
-- Crea las reservas de las próximas semanas. Lo llama el panel al abrir
-- y al crear un turno fijo. No duplica: si ya existe esa semana, la saltea.
-- Si la cancha ya está ocupada ese día, la informa como conflicto.
create or replace function public.generar_turnos_fijos(
  p_hoy      date,
  p_semanas  int  default 8,
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
    ultima  := least(p_hoy + p_semanas * 7, coalesce(t.hasta, p_hoy + p_semanas * 7));
    d := primera;
    while d <= ultima loop
      if not exists (select 1 from reservas where turno_fijo_id = t.id and fecha_turno_fijo = d) then
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

  return jsonb_build_object('creadas', creadas, 'conflictos', conflictos);
end;
$$;
grant execute on function public.generar_turnos_fijos(date, int, uuid) to authenticated;

-- Dar de baja un turno fijo: deja de repetirse y se cancelan las próximas
-- semanas que todavía no se jugaron (las de hoy y anteriores no se tocan).
create or replace function public.baja_turno_fijo(p_id uuid, p_hoy date)
returns int
language plpgsql
set search_path = public
as $$
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
$$;
grant execute on function public.baja_turno_fijo(uuid, date) to authenticated;

-- ══ 7) ÚLTIMO ACCESO DEL EQUIPO ═════════════════════════════
alter table public.empleados add column if not exists ultimo_acceso timestamptz;

create or replace function public.marcar_acceso()
returns void
language sql
security definer
set search_path = public
as $$
  update public.empleados set ultimo_acceso = now()
   where email = lower(auth.jwt() ->> 'email') and activo;
$$;
grant execute on function public.marcar_acceso() to authenticated;

-- Para la Edge Function "alta-empleado" (solo la usa el servidor con service_role)
create or replace function public.id_usuario_por_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;
revoke execute on function public.id_usuario_por_email(text) from public, anon, authenticated;
grant  execute on function public.id_usuario_por_email(text) to service_role;

-- ══ 8) PERMISOS DE LA API ═══════════════════════════════════
grant select, insert, update, delete on public.turnos_fijos  to authenticated;
grant select, update                 on public.configuracion to authenticated;
grant select                         on public.actividad     to authenticated;

-- Verificación
select 'ok' as migracion_005,
       (select count(*) from public.turnos_fijos) as turnos_fijos,
       (select hora_apertura || ' a ' || hora_cierre from public.configuracion) as horario;
