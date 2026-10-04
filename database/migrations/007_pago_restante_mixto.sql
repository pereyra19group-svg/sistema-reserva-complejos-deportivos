-- Pago del resto en parte efectivo y en parte transferencia.
-- tipo_pago_restante pasa a admitir 'Mixto'; pago_restante_transf guarda la parte por transferencia
-- (el efectivo es pago_restante - pago_restante_transf).

alter table public.reservas
  add column if not exists pago_restante_transf numeric(10,2) not null default 0;

alter table public.reservas drop constraint if exists reservas_tipo_pago_restante_check;
alter table public.reservas
  add constraint reservas_tipo_pago_restante_check
  check (tipo_pago_restante in ('Efectivo', 'Transferencia', 'Mixto'));

alter table public.reservas drop constraint if exists reservas_pago_restante_transf_check;
alter table public.reservas
  add constraint reservas_pago_restante_transf_check
  check (pago_restante_transf >= 0 and pago_restante_transf <= pago_restante);
