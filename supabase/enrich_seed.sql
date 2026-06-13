-- ============================================================================
--  ENRICH SEED — fills the "rich" columns the minimal seed left null, so the
--  wired dashboard pages show full data (ratings, city, pro flag, ...).
--  Idempotent: only fills NULLs (coalesce), safe to re-run. Targets newest org.
--  Run in the Supabase SQL Editor, after seed_orders.sql.
-- ============================================================================
do $$
declare v_org uuid;
begin
  select p.organization_id into v_org
  from public.profiles p
  join public.organizations o on o.id = p.organization_id
  order by o.created_at desc, p.created_at asc
  limit 1;
  if v_org is null then
    raise exception 'Aucune organisation avec un profil.';
  end if;

  -- ----- clients: rating / city / pro flag / active (for Garages + fidélité)
  update public.clients set
    rating = coalesce(rating, round((3.7 + random()*1.2)::numeric, 1)),
    is_active = coalesce(is_active, random() > 0.1),
    is_professional = coalesce(
      is_professional,
      case
        when lower(coalesce(email,'')) like '%gmail%'
          or lower(coalesce(email,'')) like '%outlook%' then false
        else true
      end),
    city = coalesce(
      city,
      (array['Lyon','Paris','Marseille','Nantes','Toulouse','Lille','Bordeaux','Nanterre'])[1 + floor(random()*8)::int])
  where organization_id = v_org;

  raise notice 'Clients enrichis (rating/city/pro/actif) pour org %.', v_org;
end $$;
