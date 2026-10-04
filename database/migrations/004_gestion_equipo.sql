-- ─────────────────────────────────────────────────────────────
--  004 · Gestión del equipo desde el panel (solo jefes)
--  Correr en Supabase → SQL Editor. Se puede correr más de una vez.
-- ─────────────────────────────────────────────────────────────

-- Los jefes pueden dar de alta, editar y dar de baja empleados
drop policy if exists "jefes modifican empleados" on public.empleados;
create policy "jefes modifican empleados" on public.empleados
  for all to authenticated
  using (public.es_jefe()) with check (public.es_jefe());

-- Seguridad: siempre tiene que quedar al menos un jefe activo
create or replace function public.empleados_exigir_un_jefe()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from public.empleados where rol = 'jefe' and activo) then
    raise exception 'Tiene que quedar al menos un jefe activo.' using errcode = 'P0001';
  end if;
  return null;
end;
$$;

drop trigger if exists empleados_un_jefe on public.empleados;
create constraint trigger empleados_un_jefe
  after update or delete on public.empleados
  deferrable initially immediate
  for each row execute function public.empleados_exigir_un_jefe();
