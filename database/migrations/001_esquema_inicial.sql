-- ─────────────────────────────────────────────────────────────
--  001 · Esquema inicial — Sistema de reservas (Supabase / Postgres)
--  Correr una sola vez en Supabase → SQL Editor → New query → Run.
-- ─────────────────────────────────────────────────────────────

-- Necesaria para impedir reservas superpuestas en la misma cancha
create extension if not exists btree_gist;

-- ── EMPLEADOS ────────────────────────────────────────────────
-- Lista blanca: solo estos emails pueden leer/escribir datos,
-- aunque alguien logre crear un usuario en Supabase Auth.
create table public.empleados (
  email      text primary key check (email = lower(email)),
  nombre     text,
  activo     boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.es_empleado()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.empleados
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
      and activo
  );
$$;

-- ── CANCHAS ──────────────────────────────────────────────────
create table public.canchas (
  id          text primary key,                         -- 'F5-1', 'F7-2', ...
  tipo        text not null check (tipo in ('F5', 'F7')),
  etiqueta    text not null,                            -- 'Cancha 1'
  precio_hora numeric(12,2) not null check (precio_hora >= 0),
  activa      boolean not null default true,
  orden       int not null default 0
);

insert into public.canchas (id, tipo, etiqueta, precio_hora, orden) values
  ('F5-1', 'F5', 'Cancha 1', 45000, 1),
  ('F5-2', 'F5', 'Cancha 2', 45000, 2),
  ('F5-3', 'F5', 'Cancha 3', 45000, 3),
  ('F5-4', 'F5', 'Cancha 4', 45000, 4),
  ('F7-1', 'F7', 'Cancha 1', 63000, 5),
  ('F7-2', 'F7', 'Cancha 2', 63000, 6);

-- ── CLIENTES ─────────────────────────────────────────────────
create table public.clientes (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  telefono   text not null unique,                      -- WhatsApp, identifica al cliente
  notas      text,
  created_at timestamptz not null default now()
);

-- ── RESERVAS ─────────────────────────────────────────────────
create table public.reservas (
  id                 uuid primary key default gen_random_uuid(),
  cancha_id          text not null references public.canchas(id),
  cliente_id         uuid not null references public.clientes(id),
  fecha              date not null,
  hora_inicio        time not null,
  duracion           int  not null default 1 check (duracion between 1 and 5),  -- horas
  precio             numeric(12,2) not null default 0,  -- lo calcula el trigger
  sena               numeric(12,2) not null default 0 check (sena >= 0),
  tipo_sena          text not null default 'Sin seña'
                     check (tipo_sena in ('Sin seña', 'Efectivo', 'Transferencia')),
  estado_sena        text not null default 'Pendiente'
                     check (estado_sena in ('Pendiente', 'Recibida')),
  estado             text not null default 'Confirmada'
                     check (estado in ('Confirmada', 'Asistida')),
  pago_restante      numeric(12,2) not null default 0 check (pago_restante >= 0),
  tipo_pago_restante text check (tipo_pago_restante in ('Efectivo', 'Transferencia')),
  notas              text,
  origen             text not null default 'Dashboard',  -- Dashboard / WhatsApp / Web
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Rango horario real de la reserva (cruza medianoche sin problema)
  rango tsrange generated always as (
    tsrange(fecha + hora_inicio, fecha + hora_inicio + make_interval(hours => duracion))
  ) stored,

  -- Regla clave: dos reservas de la misma cancha no pueden pisarse
  constraint reservas_sin_superposicion
    exclude using gist (cancha_id with =, rango with &&)
);

create index reservas_fecha_idx on public.reservas (fecha);

-- Precio = precio por hora de la cancha × duración (fuente única de verdad)
create or replace function public.reservas_calcular_precio()
returns trigger
language plpgsql
as $$
begin
  select c.precio_hora * new.duracion
    into new.precio
    from public.canchas c
   where c.id = new.cancha_id;
  new.updated_at := now();
  return new;
end;
$$;

create trigger reservas_precio
  before insert or update of cancha_id, duracion on public.reservas
  for each row execute function public.reservas_calcular_precio();

create or replace function public.tocar_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger reservas_updated_at
  before update on public.reservas
  for each row execute function public.tocar_updated_at();

-- ── EGRESOS ──────────────────────────────────────────────────
create table public.egresos (
  id          uuid primary key default gen_random_uuid(),
  fecha       date not null,
  categoria   text not null check (categoria in (
                'Luz', 'Gas', 'Agua', 'Mantenimiento', 'Limpieza',
                'Personal', 'Buffet', 'Alquiler', 'Impuestos', 'Otros')),
  descripcion text,
  monto       numeric(12,2) not null check (monto > 0),
  forma_pago  text not null check (forma_pago in ('Efectivo', 'Transferencia')),
  notas       text,
  created_at  timestamptz not null default now()
);

create index egresos_fecha_idx on public.egresos (fecha);

-- ── SEGURIDAD (Row Level Security) ───────────────────────────
-- Sin estas políticas, la clave pública (anon key) no puede leer ni escribir nada.
alter table public.empleados enable row level security;
alter table public.canchas   enable row level security;
alter table public.clientes  enable row level security;
alter table public.reservas  enable row level security;
alter table public.egresos   enable row level security;

create policy "empleado ve su propio registro" on public.empleados
  for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')));

create policy "empleados leen canchas" on public.canchas
  for select to authenticated using (public.es_empleado());

create policy "empleados gestionan clientes" on public.clientes
  for all to authenticated
  using (public.es_empleado()) with check (public.es_empleado());

create policy "empleados gestionan reservas" on public.reservas
  for all to authenticated
  using (public.es_empleado()) with check (public.es_empleado());

create policy "empleados gestionan egresos" on public.egresos
  for all to authenticated
  using (public.es_empleado()) with check (public.es_empleado());

-- ── PRIMER EMPLEADO ──────────────────────────────────────────
-- Reemplazar por el email real y descomentar (también hay que crear
-- el usuario en Authentication → Users → Add user).
-- insert into public.empleados (email, nombre) values ('tu-email@ejemplo.com', 'Seba');
