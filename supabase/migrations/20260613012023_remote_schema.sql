--
-- PostgreSQL database dump
--

\restrict coH9HXUYbtPBaHJ1chRPjm4a4E6WlCUrRpiFdfx40HzfSTcZo53qKmTO3SasBhi

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: canal_vente; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.canal_vente AS ENUM (
    'MAGASIN',
    'TÉLÉPHONE',
    'INTERNET',
    'B2B',
    'AUTRE'
);


--
-- Name: credit_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.credit_status AS ENUM (
    'EN_COURS',
    'PARTIEL',
    'UTILISE',
    'EXPIRE'
);


--
-- Name: delivery_tasks_workflow_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.delivery_tasks_workflow_status_enum AS ENUM (
    'PENDING',
    'TO_COLLECT',
    'IN_TRANSIT',
    'DELIVERED'
);


--
-- Name: invitation_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.invitation_status AS ENUM (
    'PENDING',
    'ACCEPTED',
    'REVOKED',
    'EXPIRED'
);


--
-- Name: orders_canal_vente_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.orders_canal_vente_enum AS ENUM (
    'MAGASIN',
    'TÉLÉPHONE',
    'INTERNET',
    'B2B',
    'AUTRE'
);


--
-- Name: orders_statut_livreur_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.orders_statut_livreur_enum AS ENUM (
    'EN_ATTENTE',
    'EN_COURS',
    'LIVRÉ'
);


--
-- Name: orders_statut_paiement_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.orders_statut_paiement_enum AS ENUM (
    'NON_PAYÉ',
    'PARTIEL',
    'PAYÉ'
);


--
-- Name: orders_workflow_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.orders_workflow_status_enum AS ENUM (
    'PENDING',
    'TO_COLLECT',
    'IN_TRANSIT',
    'DELIVERED'
);


--
-- Name: reception_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.reception_status AS ENUM (
    'PENDING',
    'RECEIVED',
    'BACKORDER',
    'NOT_RECEIVED'
);


--
-- Name: return_treatment; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.return_treatment AS ENUM (
    'A_TRAITER',
    'DEMANDE_ENVOYEE',
    'A_RECUPERER',
    'ACCEPTE',
    'REFUSE',
    'REMBOURSE'
);


--
-- Name: return_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.return_type AS ENUM (
    'RETOURNABLE',
    'RETOUR_IMPOSSIBLE',
    'CONSIGNE',
    'DELAI_DEPASSE'
);


--
-- Name: sms_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sms_status AS ENUM (
    'A_ENVOYER',
    'ENVOYE',
    'ECHEC'
);


--
-- Name: statut_livreur; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.statut_livreur AS ENUM (
    'EN_ATTENTE',
    'EN_COURS',
    'LIVRÉ'
);


--
-- Name: statut_paiement; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.statut_paiement AS ENUM (
    'NON_PAYÉ',
    'PARTIEL',
    'PAYÉ'
);


--
-- Name: subscription_plan; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.subscription_plan AS ENUM (
    'TRIAL',
    'STARTER',
    'PRO',
    'ENTERPRISE'
);


--
-- Name: tour_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tour_status AS ENUM (
    'PLANIFIEE',
    'EN_COURS',
    'TERMINEE'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'CAISSIER',
    'ADMIN',
    'LIVREUR'
);


--
-- Name: users_role_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.users_role_enum AS ENUM (
    'CAISSIER',
    'ADMIN',
    'LIVREUR'
);


--
-- Name: workflow_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.workflow_status AS ENUM (
    'PENDING',
    'TO_COLLECT',
    'IN_TRANSIT',
    'DELIVERED'
);


--
-- Name: current_user_org_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_user_org_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select p.organization_id from public.profiles p where p.user_id = auth.uid() limit 1;
$$;


--
-- Name: current_user_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_user_role() RETURNS public.user_role
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select p.role from public.profiles p where p.user_id = auth.uid() limit 1;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  target_org uuid;
  r public.user_role;
  display text;
  org_name text;
  new_slug text;
begin
  org_name := nullif(trim(new.raw_user_meta_data->>'organization_name'), '');

  -- (1) Invited member — an explicit organization_id was passed in metadata.
  begin
    target_org := nullif(new.raw_user_meta_data->>'organization_id', '')::uuid;
  exception when others then
    target_org := null;
  end;

  if target_org is not null then
    begin
      r := coalesce(
        (new.raw_user_meta_data->>'role')::public.user_role,
        'CAISSIER'::public.user_role
      );
    exception when others then
      r := 'CAISSIER'::public.user_role;
    end;

  -- (2) Owner signup — create a brand-new organization, become ADMIN.
  elsif org_name is not null then
    new_slug := lower(regexp_replace(org_name, '[^a-zA-Z0-9]+', '-', 'g'));
    new_slug := trim(both '-' from new_slug);
    new_slug := coalesce(nullif(new_slug, ''), 'magasin')
                || '-' || substr(replace(new.id::text, '-', ''), 1, 8);

    insert into public.organizations (name, slug)
    values (org_name, new_slug)
    returning id into target_org;

    r := 'ADMIN'::public.user_role;

  -- (3) Fallback — no org info: legacy shared default org as CAISSIER.
  else
    insert into public.organizations (id, name, slug)
    values ('00000000-0000-4000-8000-000000000001', 'Magasin principal', 'default')
    on conflict (slug) do nothing;

    select id into target_org from public.organizations where slug = 'default' limit 1;
    if target_org is null then
      select id into target_org from public.organizations order by created_at limit 1;
    end if;

    r := 'CAISSIER'::public.user_role;
  end if;

  display := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Utilisateur'
  );

  insert into public.profiles (user_id, organization_id, display_name, role)
  values (new.id, target_org, display, r)
  on conflict (user_id) do update set
    organization_id = excluded.organization_id,
    display_name = excluded.display_name,
    role = excluded.role,
    updated_at = now();

  return new;
end;
$$;


--
-- Name: next_ref_demande(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_ref_demande(p_org uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  y int := extract(year from current_date);
  prefix constant text := format('REQ-%s-', y);
  next_n int;
begin
  select coalesce(max((regexp_match(o.ref_demande, '(\d+)$'))[1]::int), 0) + 1
  into next_n
  from orders o
  where o.organization_id = p_org
    and o.ref_demande like prefix || '%';

  return prefix || lpad(next_n::text, 5, '0');
end;
$_$;


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin new.updated_at = now(); return new; end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying NOT NULL,
    phone character varying,
    email character varying,
    immatriculation character varying,
    vehicle_model character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    city text,
    is_professional boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    rating numeric(2,1),
    notes text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: consignment_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consignment_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    description text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    status character varying DEFAULT 'ACTIF'::character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    num text,
    montant numeric(14,2),
    echeance date,
    supplier_id uuid,
    motif text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: credit_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    amount numeric(14,2) NOT NULL,
    order_id uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    num text,
    statut public.credit_status DEFAULT 'EN_COURS'::public.credit_status NOT NULL,
    echeance date,
    motif text,
    designation text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: delivery_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    assigned_livreur_id uuid,
    workflow_status public.delivery_tasks_workflow_status_enum DEFAULT 'TO_COLLECT'::public.delivery_tasks_workflow_status_enum NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: delivery_tours; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_tours (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    livreur_id uuid,
    vehicle_label text,
    slot_start time without time zone,
    slot_end time without time zone,
    tour_date date DEFAULT CURRENT_DATE NOT NULL,
    status public.tour_status DEFAULT 'PLANIFIEE'::public.tour_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    email text NOT NULL,
    role public.user_role DEFAULT 'CAISSIER'::public.user_role NOT NULL,
    token text DEFAULT encode(extensions.gen_random_bytes(16), 'hex'::text) NOT NULL,
    status public.invitation_status DEFAULT 'PENDING'::public.invitation_status NOT NULL,
    invited_by uuid,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    nom_produit character varying NOT NULL,
    reference character varying NOT NULL,
    supplier_id uuid,
    quantity integer NOT NULL,
    a_commander_pour_livreur boolean DEFAULT false NOT NULL,
    prix_achat_unitaire numeric(14,2) NOT NULL,
    prix_vente_unitaire numeric(14,2) NOT NULL,
    organization_id uuid NOT NULL,
    depuis_magasin boolean DEFAULT false NOT NULL,
    retour_stock_fait boolean DEFAULT false NOT NULL,
    qte_recue integer DEFAULT 0 NOT NULL,
    reception_status public.reception_status DEFAULT 'PENDING'::public.reception_status NOT NULL,
    received_at timestamp with time zone,
    origine text DEFAULT 'client'::text NOT NULL,
    tour_id uuid,
    prevue_le timestamp with time zone
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ref_demande character varying NOT NULL,
    date_commande date NOT NULL,
    vendeur_id uuid NOT NULL,
    canal_vente public.orders_canal_vente_enum NOT NULL,
    client_id uuid,
    client_phone character varying NOT NULL,
    client_email character varying,
    immatriculation character varying,
    vehicle_model character varying,
    montant_total numeric(14,2) NOT NULL,
    devis boolean DEFAULT false NOT NULL,
    statut_paiement public.orders_statut_paiement_enum NOT NULL,
    montant_paye numeric(14,2) DEFAULT 0 NOT NULL,
    avance_payee numeric(14,2) DEFAULT 0 NOT NULL,
    solde_restant numeric(14,2) NOT NULL,
    envoyer_au_livreur boolean DEFAULT false NOT NULL,
    date_envoi timestamp with time zone,
    statut_livreur public.orders_statut_livreur_enum DEFAULT 'EN_ATTENTE'::public.orders_statut_livreur_enum NOT NULL,
    consigne text,
    workflow_status public.orders_workflow_status_enum DEFAULT 'PENDING'::public.orders_workflow_status_enum NOT NULL,
    bl boolean DEFAULT false NOT NULL,
    date_bl date,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text,
    subscription_status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    plan public.subscription_plan DEFAULT 'TRIAL'::public.subscription_plan NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    trial_ends_at timestamp with time zone,
    current_period_end timestamp with time zone,
    seat_limit integer DEFAULT 3 NOT NULL,
    currency text DEFAULT 'EUR'::text NOT NULL,
    locale text DEFAULT 'fr-FR'::text NOT NULL,
    phone text,
    address text,
    city text,
    logo_url text,
    sms_sender text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    display_name text NOT NULL,
    role public.user_role DEFAULT 'CAISSIER'::public.user_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ref character varying NOT NULL,
    created_by_id uuid NOT NULL,
    payload jsonb NOT NULL,
    converted_order_id uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sales_returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_returns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid,
    reason text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    ref text,
    client_id uuid,
    supplier_id uuid,
    type_retour public.return_type,
    statut_traitement public.return_treatment,
    decote_pct numeric(5,2) DEFAULT 0 NOT NULL,
    montant numeric(14,2),
    motif text,
    designation text,
    echeance date,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sms_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    order_id uuid,
    client_id uuid,
    phone text,
    message text,
    status public.sms_status DEFAULT 'A_ENVOYER'::public.sms_status NOT NULL,
    traite boolean DEFAULT false NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sku character varying NOT NULL,
    name character varying NOT NULL,
    quantity_on_hand integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supplier_receptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_receptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reference character varying NOT NULL,
    received boolean DEFAULT false NOT NULL,
    "receivedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppliers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying NOT NULL,
    code character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying NOT NULL,
    "passwordHash" character varying NOT NULL,
    "displayName" character varying NOT NULL,
    role public.users_role_enum NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    client_id uuid,
    plate text,
    model text,
    vin text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: clients clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (id);


--
-- Name: consignment_entries consignment_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consignment_entries
    ADD CONSTRAINT consignment_entries_pkey PRIMARY KEY (id);


--
-- Name: credit_notes credit_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_notes
    ADD CONSTRAINT credit_notes_pkey PRIMARY KEY (id);


--
-- Name: delivery_tasks delivery_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_tasks
    ADD CONSTRAINT delivery_tasks_pkey PRIMARY KEY (id);


--
-- Name: delivery_tours delivery_tours_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_tours
    ADD CONSTRAINT delivery_tours_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_token_key UNIQUE (token);


--
-- Name: order_lines order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_lines
    ADD CONSTRAINT order_lines_pkey PRIMARY KEY (id);


--
-- Name: orders orders_org_ref_demande_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_org_ref_demande_key UNIQUE (organization_id, ref_demande);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_key UNIQUE (slug);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (user_id);


--
-- Name: quotes quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_pkey PRIMARY KEY (id);


--
-- Name: quotes quotes_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_ref_key UNIQUE (ref);


--
-- Name: sales_returns sales_returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_returns
    ADD CONSTRAINT sales_returns_pkey PRIMARY KEY (id);


--
-- Name: sms_notifications sms_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_notifications
    ADD CONSTRAINT sms_notifications_pkey PRIMARY KEY (id);


--
-- Name: stock_items stock_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_pkey PRIMARY KEY (id);


--
-- Name: stock_items stock_items_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_sku_key UNIQUE (sku);


--
-- Name: supplier_receptions supplier_receptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_receptions
    ADD CONSTRAINT supplier_receptions_pkey PRIMARY KEY (id);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vehicles vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_pkey PRIMARY KEY (id);


--
-- Name: idx_clients_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clients_org ON public.clients USING btree (organization_id);


--
-- Name: idx_consign_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_consign_org ON public.consignment_entries USING btree (organization_id);


--
-- Name: idx_credits_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credits_org ON public.credit_notes USING btree (organization_id);


--
-- Name: idx_delivery_tasks_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_tasks_order ON public.delivery_tasks USING btree (order_id);


--
-- Name: idx_delivery_tasks_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_tasks_org ON public.delivery_tasks USING btree (organization_id);


--
-- Name: idx_invitations_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_email ON public.invitations USING btree (lower(email));


--
-- Name: idx_invitations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_org ON public.invitations USING btree (organization_id);


--
-- Name: idx_order_lines_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_lines_order ON public.order_lines USING btree (order_id);


--
-- Name: idx_order_lines_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_lines_org ON public.order_lines USING btree (organization_id);


--
-- Name: idx_order_lines_recep; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_lines_recep ON public.order_lines USING btree (reception_status);


--
-- Name: idx_order_lines_tour; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_lines_tour ON public.order_lines USING btree (tour_id);


--
-- Name: idx_orders_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_client ON public.orders USING btree (client_id);


--
-- Name: idx_orders_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_org ON public.orders USING btree (organization_id);


--
-- Name: idx_orders_vendeur; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_vendeur ON public.orders USING btree (vendeur_id);


--
-- Name: idx_orders_workflow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_workflow ON public.orders USING btree (workflow_status);


--
-- Name: idx_profiles_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_org ON public.profiles USING btree (organization_id);


--
-- Name: idx_quotes_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotes_org ON public.quotes USING btree (organization_id);


--
-- Name: idx_receptions_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receptions_org ON public.supplier_receptions USING btree (organization_id);


--
-- Name: idx_returns_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_returns_org ON public.sales_returns USING btree (organization_id);


--
-- Name: idx_sms_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_order ON public.sms_notifications USING btree (order_id);


--
-- Name: idx_sms_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_org ON public.sms_notifications USING btree (organization_id);


--
-- Name: idx_stock_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_org ON public.stock_items USING btree (organization_id);


--
-- Name: idx_suppliers_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppliers_org ON public.suppliers USING btree (organization_id);


--
-- Name: idx_tours_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tours_org ON public.delivery_tours USING btree (organization_id);


--
-- Name: idx_vehicles_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicles_client ON public.vehicles USING btree (client_id);


--
-- Name: idx_vehicles_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicles_org ON public.vehicles USING btree (organization_id);


--
-- Name: uq_supplier_receptions_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_supplier_receptions_reference ON public.supplier_receptions USING btree (reference);


--
-- Name: clients set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: consignment_entries set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.consignment_entries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: credit_notes set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.credit_notes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: delivery_tasks set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.delivery_tasks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: delivery_tours set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.delivery_tours FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: orders set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: organizations set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: profiles set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: quotes set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: sales_returns set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.sales_returns FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: stock_items set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.stock_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: supplier_receptions set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.supplier_receptions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: suppliers set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: vehicles set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: clients clients_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: consignment_entries consignment_entries_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consignment_entries
    ADD CONSTRAINT consignment_entries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: consignment_entries consignment_entries_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consignment_entries
    ADD CONSTRAINT consignment_entries_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;


--
-- Name: credit_notes credit_notes_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_notes
    ADD CONSTRAINT credit_notes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: delivery_tasks delivery_tasks_assigned_livreur_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_tasks
    ADD CONSTRAINT delivery_tasks_assigned_livreur_id_fkey FOREIGN KEY (assigned_livreur_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: delivery_tasks delivery_tasks_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_tasks
    ADD CONSTRAINT delivery_tasks_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: delivery_tasks delivery_tasks_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_tasks
    ADD CONSTRAINT delivery_tasks_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: delivery_tours delivery_tours_livreur_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_tours
    ADD CONSTRAINT delivery_tours_livreur_id_fkey FOREIGN KEY (livreur_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: delivery_tours delivery_tours_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_tours
    ADD CONSTRAINT delivery_tours_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: invitations invitations_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: invitations invitations_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: order_lines order_lines_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_lines
    ADD CONSTRAINT order_lines_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_lines order_lines_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_lines
    ADD CONSTRAINT order_lines_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: order_lines order_lines_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_lines
    ADD CONSTRAINT order_lines_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;


--
-- Name: order_lines order_lines_tour_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_lines
    ADD CONSTRAINT order_lines_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES public.delivery_tours(id) ON DELETE SET NULL;


--
-- Name: orders orders_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;


--
-- Name: orders orders_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: orders orders_vendeur_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_vendeur_id_fkey FOREIGN KEY (vendeur_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: profiles profiles_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: profiles profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: quotes quotes_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: quotes quotes_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: sales_returns sales_returns_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_returns
    ADD CONSTRAINT sales_returns_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: sms_notifications sms_notifications_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_notifications
    ADD CONSTRAINT sms_notifications_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;


--
-- Name: sms_notifications sms_notifications_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_notifications
    ADD CONSTRAINT sms_notifications_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: sms_notifications sms_notifications_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_notifications
    ADD CONSTRAINT sms_notifications_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: stock_items stock_items_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: supplier_receptions supplier_receptions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_receptions
    ADD CONSTRAINT supplier_receptions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: suppliers suppliers_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: vehicles vehicles_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: vehicles vehicles_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

--
-- Name: clients clients_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clients_all ON public.clients USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: consignment_entries consign_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY consign_all ON public.consignment_entries USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: consignment_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.consignment_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: consignment_entries consignment_entries_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY consignment_entries_all ON public.consignment_entries USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: credit_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_notes credit_notes_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY credit_notes_all ON public.credit_notes USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: credit_notes credits_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY credits_all ON public.credit_notes USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: delivery_tasks delivery_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_all ON public.delivery_tasks USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: delivery_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_tasks delivery_tasks_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_tasks_all ON public.delivery_tasks USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: delivery_tours; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_tours ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_tours delivery_tours_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_tours_all ON public.delivery_tours USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: invitations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: invitations invitations_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invitations_admin ON public.invitations USING (((organization_id = public.current_user_org_id()) AND (public.current_user_role() = 'ADMIN'::public.user_role))) WITH CHECK (((organization_id = public.current_user_org_id()) AND (public.current_user_role() = 'ADMIN'::public.user_role)));


--
-- Name: order_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: order_lines order_lines_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_lines_all ON public.order_lines USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

--
-- Name: orders orders_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_delete ON public.orders FOR DELETE USING ((organization_id = public.current_user_org_id()));


--
-- Name: orders orders_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_insert ON public.orders FOR INSERT WITH CHECK (((organization_id = public.current_user_org_id()) AND (vendeur_id = auth.uid())));


--
-- Name: orders orders_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_select ON public.orders FOR SELECT USING ((organization_id = public.current_user_org_id()));


--
-- Name: orders orders_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_update ON public.orders FOR UPDATE USING ((organization_id = public.current_user_org_id()));


--
-- Name: organizations org_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_select ON public.organizations FOR SELECT USING ((id = public.current_user_org_id()));


--
-- Name: organizations org_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_update ON public.organizations FOR UPDATE USING (((id = public.current_user_org_id()) AND (public.current_user_role() = 'ADMIN'::public.user_role))) WITH CHECK ((id = public.current_user_org_id()));


--
-- Name: organizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_delete ON public.profiles FOR DELETE USING (((organization_id = public.current_user_org_id()) AND (public.current_user_role() = 'ADMIN'::public.user_role) AND (user_id <> auth.uid())));


--
-- Name: profiles profiles_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select ON public.profiles FOR SELECT USING (((user_id = auth.uid()) OR (organization_id = public.current_user_org_id())));


--
-- Name: profiles profiles_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_update ON public.profiles FOR UPDATE USING (((user_id = auth.uid()) OR ((organization_id = public.current_user_org_id()) AND (public.current_user_role() = 'ADMIN'::public.user_role))));


--
-- Name: quotes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;

--
-- Name: quotes quotes_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY quotes_all ON public.quotes USING ((organization_id = public.current_user_org_id())) WITH CHECK (((organization_id = public.current_user_org_id()) AND (created_by_id = auth.uid())));


--
-- Name: supplier_receptions receptions_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY receptions_all ON public.supplier_receptions USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: sales_returns returns_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY returns_all ON public.sales_returns USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: sales_returns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sales_returns ENABLE ROW LEVEL SECURITY;

--
-- Name: sales_returns sales_returns_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sales_returns_all ON public.sales_returns USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: sms_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_notifications sms_notifications_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sms_notifications_all ON public.sms_notifications USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: stock_items stock_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stock_all ON public.stock_items USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: stock_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_items ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_items stock_items_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stock_items_all ON public.stock_items USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: supplier_receptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supplier_receptions ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_receptions supplier_receptions_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY supplier_receptions_all ON public.supplier_receptions USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: suppliers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

--
-- Name: suppliers suppliers_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY suppliers_all ON public.suppliers USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicles vehicles_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vehicles_all ON public.vehicles USING ((organization_id = public.current_user_org_id())) WITH CHECK ((organization_id = public.current_user_org_id()));


--
-- PostgreSQL database dump complete
--

\unrestrict coH9HXUYbtPBaHJ1chRPjm4a4E6WlCUrRpiFdfx40HzfSTcZo53qKmTO3SasBhi

