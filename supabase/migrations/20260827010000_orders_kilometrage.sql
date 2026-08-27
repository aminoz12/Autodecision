-- Vehicle mileage captured on each order (also auto-filled from devis PDFs).
alter table public.orders
  add column if not exists kilometrage integer;
