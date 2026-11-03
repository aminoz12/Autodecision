-- Plus de fiche client en double (2026-11-03).
--
-- Dans un même magasin, deux fiches actives avec le même nom (lettres et
-- chiffres seulement, sans accents, majuscules ni espaces) et le même numéro
-- (chiffres seulement, +33 ramené à 0) sont refusées par la base — y compris
-- deux fiches de même nom sans numéro : le comptoir choisit alors la fiche
-- existante, ou saisit un numéro. L'application traduit l'erreur
-- (duplicateInsertError) et propose la fiche existante avant d'en arriver là
-- (findDuplicate). Une fiche désactivée ne compte pas.
--
-- La migration refuse de s'appliquer tant qu'il reste des doublons exacts :
-- ils se regroupent avec merge_clients (20261103010000) d'abord.

create or replace function public.client_match_key(p_name text)
returns text
language sql
immutable
parallel safe
as $$
  select regexp_replace(
    translate(lower(coalesce(p_name, '')), 'àâäáãéèêëíìîïóòôöõúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
    '[^a-z0-9]', '', 'g');
$$;

create or replace function public.phone_key(p_phone text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when d ~ '^(00)?33[1-9][0-9]{8}$' then '0' || right(d, 9)
    else d
  end
  from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as d) s;
$$;

do $$
declare
  v_list text;
begin
  select string_agg(format('%s ×%s', d.name, d.n), ', ' order by d.name) into v_list
  from (
    select min(c.name) as name, count(*) as n
    from public.clients c
    where c.is_active
    group by c.organization_id, public.client_match_key(c.name), public.phone_key(c.phone)
    having count(*) > 1
  ) d;
  if v_list is not null then
    raise exception 'clients_no_duplicate : regroupez d''abord ces fiches en double (merge_clients) : %', v_list;
  end if;
end;
$$;

create unique index if not exists clients_no_duplicate
  on public.clients (organization_id, public.client_match_key(name), public.phone_key(phone))
  where is_active;
