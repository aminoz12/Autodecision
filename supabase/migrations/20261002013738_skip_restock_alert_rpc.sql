-- Stock (2026-10-02) : « Déjà en stock » passait par une écriture directe sur
-- order_lines, que le comptoir n'a pas le droit de faire (« permission denied
-- for table order_lines », vu dix fois dans le journal du 2026-10-01) : la
-- table ne s'écrit que par des fonctions. Le bouton appelle désormais celle-ci.

create or replace function public.skip_restock_alert(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  update public.order_lines
  set restock_skipped_at = now()
  where id = p_line_id and organization_id = v_org;
  if not found then
    raise exception 'Line not found.';
  end if;
end;
$$;
revoke execute on function public.skip_restock_alert(uuid) from public, anon;
grant execute on function public.skip_restock_alert(uuid) to authenticated;

notify pgrst, 'reload schema';
