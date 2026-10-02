-- Clients PRO (2026-10-02) : un troisième type de client à côté du comptoir et
-- du garage — une société, une flotte, un taxi… qui achète « en compte ».
--
-- Un client PRO est un compte professionnel comme un garage (is_garage = true :
-- paiement en compte, échéance, relevé, règlements, tout ce qui existe déjà
-- s'applique tel quel), sans accès au portail. Seul ce type les distingue :
-- il n'a de sens que pour un compte professionnel.

alter table public.clients
  add column if not exists account_type text not null default 'GARAGE';
alter table public.clients drop constraint if exists clients_account_type_check;
alter table public.clients add constraint clients_account_type_check
  check (account_type in ('GARAGE', 'PRO'));

comment on column public.clients.account_type is
  'Type de compte professionnel (is_garage = true) : GARAGE (portail possible) ou PRO (société en compte, sans portail).';

notify pgrst, 'reload schema';
