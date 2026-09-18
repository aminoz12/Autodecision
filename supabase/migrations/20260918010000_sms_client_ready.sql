-- SMS « commande prête » au client (2026-09-18).
--
--  Le message envoyé depuis « Commande à préparer » est construit côté
--  serveur (/api/send-sms) à partir de trois réglages du magasin, modifiables
--  dans Paramètres → SMS aux clients :
--    sms_horaires          horaires cités dans le SMS (défaut : Lun-Sam 9h-18h30)
--    sms_ready_template    commande complète  — placeholders {client} {commande} {horaires} {magasin}
--    sms_partial_template  commande partielle (reliquat en cours)
--  NULL = texte par défaut de l'application (apps/web/src/lib/sms.ts).
--  update_organization_profile() apprend ces trois clés ; le reste est inchangé.

alter table public.organizations
  add column if not exists sms_horaires text,
  add column if not exists sms_ready_template text,
  add column if not exists sms_partial_template text;

create or replace function public.update_organization_profile(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_rate numeric;
begin
  if v_org is null or not public.is_counter_staff() or public.current_user_role() <> 'ADMIN'::public.user_role then
    raise exception 'Only an organization administrator may update settings.';
  end if;
  if nullif(trim(coalesce(p->>'name', '')), '') is null then
    raise exception 'Organization name is required.';
  end if;
  v_rate := coalesce(nullif(p->>'tva_rate', '')::numeric, 20);
  if v_rate < 0 or v_rate > 100 then
    raise exception 'Invalid VAT rate.';
  end if;
  update public.organizations
  set name = trim(p->>'name'),
      phone = nullif(trim(coalesce(p->>'phone', '')), ''),
      address = nullif(trim(coalesce(p->>'address', '')), ''),
      city = nullif(trim(coalesce(p->>'city', '')), ''),
      legal_name = nullif(trim(coalesce(p->>'legal_name', '')), ''),
      legal_form = nullif(trim(coalesce(p->>'legal_form', '')), ''),
      siret = nullif(regexp_replace(coalesce(p->>'siret', ''), '[^0-9]', '', 'g'), ''),
      tva_intra = nullif(upper(regexp_replace(coalesce(p->>'tva_intra', ''), '\s', '', 'g')), ''),
      rcs = nullif(trim(coalesce(p->>'rcs', '')), ''),
      capital = nullif(trim(coalesce(p->>'capital', '')), ''),
      iban = nullif(upper(regexp_replace(coalesce(p->>'iban', ''), '\s', '', 'g')), ''),
      bic = nullif(upper(trim(coalesce(p->>'bic', ''))), ''),
      tva_rate = v_rate,
      invoice_prefix = coalesce(nullif(upper(regexp_replace(coalesce(p->>'invoice_prefix', ''), '[^A-Za-z0-9]', '', 'g')), ''), 'FA'),
      invoice_footer = nullif(trim(coalesce(p->>'invoice_footer', '')), ''),
      payment_terms_text = nullif(trim(coalesce(p->>'payment_terms_text', '')), ''),
      sms_horaires = nullif(left(trim(coalesce(p->>'sms_horaires', '')), 120), ''),
      sms_ready_template = nullif(left(trim(coalesce(p->>'sms_ready_template', '')), 640), ''),
      sms_partial_template = nullif(left(trim(coalesce(p->>'sms_partial_template', '')), 640), ''),
      updated_at = now()
  where id = v_org;
end;
$$;
revoke execute on function public.update_organization_profile(jsonb) from public, anon;
grant execute on function public.update_organization_profile(jsonb) to authenticated;

notify pgrst, 'reload schema';
