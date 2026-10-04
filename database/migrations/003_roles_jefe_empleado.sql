-- ─────────────────────────────────────────────────────────────
--  003 · Roles: jefe / empleado
--  Correr en Supabase → SQL Editor. Se puede correr más de una vez.
--
--  empleado → reservas, canchas, caja del día.
--  jefe     → todo lo anterior + control mensual y egresos.
-- ─────────────────────────────────────────────────────────────

-- 1) Columna rol. Los empleados ya cargados pasan a 'jefe' para que nadie
--    pierda acceso; después bajá a 'empleado' a quien corresponda (ver abajo).
alter table public.empleados
  add column if not exists rol text not null default 'empleado'
  check (rol in ('jefe', 'empleado'));

update public.empleados set rol = 'jefe'
where not exists (select 1 from public.empleados where rol = 'jefe');
-- (solo corre si todavía no hay ningún jefe, así re-correr el script no pisa cambios)

-- 2) Función de chequeo de rol
create or replace function public.es_jefe()
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
      and rol = 'jefe'
  );
$$;
grant execute on function public.es_jefe() to authenticated;

-- 3) Egresos: solo los jefes los ven y los cargan
drop policy if exists "empleados gestionan egresos" on public.egresos;
drop policy if exists "jefes gestionan egresos"     on public.egresos;
create policy "jefes gestionan egresos" on public.egresos
  for all to authenticated
  using (public.es_jefe()) with check (public.es_jefe());

-- 4) Los jefes pueden ver la lista completa de empleados
drop policy if exists "jefes ven empleados" on public.empleados;
create policy "jefes ven empleados" on public.empleados
  for select to authenticated using (public.es_jefe());

-- ── Cómo asignar roles ───────────────────────────────────────
--   update public.empleados set rol = 'jefe'     where email = 'socio@ejemplo.com';
--   update public.empleados set rol = 'empleado' where email = 'empleado@ejemplo.com';

select email, nombre, rol, activo from public.empleados order by rol, email;
