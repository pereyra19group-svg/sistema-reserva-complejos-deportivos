-- ─────────────────────────────────────────────────────────────
--  002 · Permisos de la API + habilitar empleados
--  Correr en Supabase → SQL Editor. Se puede correr más de una vez.
-- ─────────────────────────────────────────────────────────────

-- 1) Permisos de la API para usuarios logueados.
--    Es seguro: RLS sigue filtrando y solo deja pasar a quien esté en "empleados".
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on function public.es_empleado() to authenticated;

-- 2) Habilitar como empleado a todos los usuarios creados en Authentication → Users.
--    (Por eso es importante tener desactivado "Allow new users to sign up".)
insert into public.empleados (email)
select lower(email) from auth.users where email is not null
on conflict (email) do update set activo = true;

-- 3) Verificación: cada usuario debería figurar con habilitado = true
select u.email                as usuario,
       u.email_confirmed_at is not null as email_confirmado,
       e.email is not null    as habilitado,
       e.activo
from auth.users u
left join public.empleados e on e.email = lower(u.email)
order by u.created_at;
