-- Après-vente (2026-10-01) : motif de garantie.
--
-- Un dossier GARANTIE porte désormais un motif choisi dans une liste fermée :
--   GA - Défaillance récurrente · GA - Défaillance soudaine · GA - Détérioration
--   rapide · GA - Fuite de liquides · GA - Mauvaise qualité de fabrication ·
--   GA - Non-conformité · GA - Pièce défectueuse à l'arrivée · GARANTIE
--
-- L'application envoie le motif en tête de la description (« <libellé> — <texte> »),
-- pour le comptoir comme pour le portail garage, sans changer open_sav_case ni
-- open_garage_dispute : le déclencheur ci-dessous le range dans sa colonne et
-- rend au texte sa forme d'origine. Une base sans cette migration garde donc le
-- motif lisible au début de la description.

alter table public.sav_cases
  add column if not exists warranty_motif text;
alter table public.sav_cases drop constraint if exists sav_cases_warranty_motif_check;
alter table public.sav_cases add constraint sav_cases_warranty_motif_check
  check (warranty_motif is null or warranty_motif in (
    'GA_DEFAILLANCE_RECURRENTE', 'GA_DEFAILLANCE_SOUDAINE', 'GA_DETERIORATION_RAPIDE', 'GA_FUITE_LIQUIDES',
    'GA_MAUVAISE_QUALITE', 'GA_NON_CONFORMITE', 'GA_DEFECTUEUSE_ARRIVEE', 'GARANTIE'
  ));
create index if not exists sav_cases_warranty_motif_idx
  on public.sav_cases (organization_id, warranty_motif)
  where warranty_motif is not null;

-- Libellé → code (les libellés sont ceux de l'application, lib/sav.ts).
create or replace function public.sav_warranty_motif_code(p_label text)
returns text
language sql
immutable
as $$
  select case trim(coalesce(p_label, ''))
    when 'GA - Défaillance récurrente' then 'GA_DEFAILLANCE_RECURRENTE'
    when 'GA - Défaillance soudaine' then 'GA_DEFAILLANCE_SOUDAINE'
    when 'GA - Détérioration rapide' then 'GA_DETERIORATION_RAPIDE'
    when 'GA - Fuite de liquides' then 'GA_FUITE_LIQUIDES'
    when 'GA - Mauvaise qualité de fabrication' then 'GA_MAUVAISE_QUALITE'
    when 'GA - Non-conformité' then 'GA_NON_CONFORMITE'
    when 'GA - Pièce défectueuse à l''arrivée' then 'GA_DEFECTUEUSE_ARRIVEE'
    when 'GARANTIE' then 'GARANTIE'
  end
$$;

-- À la création d'un dossier garantie : « <libellé> — <texte> » → colonne + texte.
create or replace function public.sav_cases_take_warranty_motif()
returns trigger
language plpgsql
as $$
declare
  v_pos integer;
  v_code text;
begin
  if new.type <> 'GARANTIE' or new.warranty_motif is not null or new.description is null then
    return new;
  end if;
  v_pos := position(' — ' in new.description);
  if v_pos > 0 then
    v_code := public.sav_warranty_motif_code(left(new.description, v_pos - 1));
    if v_code is not null then
      new.warranty_motif := v_code;
      new.description := nullif(trim(substr(new.description, v_pos + 3)), '');
    end if;
  else
    v_code := public.sav_warranty_motif_code(new.description);
    if v_code is not null then
      new.warranty_motif := v_code;
      new.description := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sav_cases_take_warranty_motif on public.sav_cases;
create trigger sav_cases_take_warranty_motif
  before insert on public.sav_cases
  for each row execute function public.sav_cases_take_warranty_motif();

-- Les dossiers déjà ouverts avec le motif en tête de description.
update public.sav_cases c
set warranty_motif = public.sav_warranty_motif_code(left(c.description, position(' — ' in c.description) - 1)),
    description = nullif(trim(substr(c.description, position(' — ' in c.description) + 3)), '')
where c.type = 'GARANTIE'
  and c.warranty_motif is null
  and c.description is not null
  and position(' — ' in c.description) > 0
  and public.sav_warranty_motif_code(left(c.description, position(' — ' in c.description) - 1)) is not null;

-- Comptoir : choisir ou corriger le motif d'un dossier.
create or replace function public.set_sav_case_warranty_motif(p_case_id uuid, p_motif text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_motif text := nullif(trim(coalesce(p_motif, '')), '');
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if v_motif is not null and v_motif not in (
    'GA_DEFAILLANCE_RECURRENTE', 'GA_DEFAILLANCE_SOUDAINE', 'GA_DETERIORATION_RAPIDE', 'GA_FUITE_LIQUIDES',
    'GA_MAUVAISE_QUALITE', 'GA_NON_CONFORMITE', 'GA_DEFECTUEUSE_ARRIVEE', 'GARANTIE'
  ) then
    raise exception 'Unknown warranty motif.';
  end if;
  update public.sav_cases
  set warranty_motif = v_motif
  where id = p_case_id and organization_id = v_org and type = 'GARANTIE';
  if not found then
    raise exception 'Warranty case not found.';
  end if;
end;
$$;
revoke execute on function public.set_sav_case_warranty_motif(uuid, text) from public, anon;
grant execute on function public.set_sav_case_warranty_motif(uuid, text) to authenticated;

notify pgrst, 'reload schema';
