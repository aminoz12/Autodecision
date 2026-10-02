import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/superadmin-auth";

export const dynamic = "force-dynamic";

/**
 * Everything the SaaS owner sees of one magasin (server-only, service role):
 * its subscription, every account with its last sign-in, the volumes, and what
 * was done lately (orders, payments, returns). The trail of who changed what is
 * served by /api/superadmin/journal?tab=activity&org=<id>.
 */

const DAY = 24 * 60 * 60 * 1000;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSuperAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin } = ctx;
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Magasin introuvable." }, { status: 404 });

    const { data: org, error: orgError } = await admin
      .from("organizations")
      .select("id, name, slug, plan, subscription_status, trial_ends_at, current_period_end, seat_limit, created_at, phone, address, city, stripe_customer_id, stripe_subscription_id")
      .eq("id", id)
      .maybeSingle();
    if (orgError) throw new Error(orgError.message);
    if (!org) return NextResponse.json({ error: "Magasin introuvable." }, { status: 404 });

    const since30 = new Date(Date.now() - 30 * DAY).toISOString();
    const since7 = new Date(Date.now() - 7 * DAY).toISOString();
    const count = (table: string) => admin.from(table).select("id", { count: "exact", head: true }).eq("organization_id", id);

    const [profilesRes, users, orders, devis, clients, invoices, returns, cases, stock, suppliers, month, open, paid, errors, recentOrders, recentPayments, recentReturns] =
      await Promise.all([
        admin.from("profiles").select("user_id, display_name, role, client_id, livreur_id").eq("organization_id", id),
        admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
        count("orders").eq("devis", false).eq("is_restock", false),
        count("orders").eq("devis", true),
        count("clients"),
        count("invoices"),
        count("sales_returns"),
        count("sav_cases"),
        count("stock_items"),
        count("suppliers"),
        admin.from("orders").select("montant_total").eq("organization_id", id).eq("devis", false).eq("is_restock", false).is("cancelled_at", null).gte("createdAt", since30).limit(5000),
        admin.from("orders").select("solde_restant").eq("organization_id", id).eq("devis", false).gt("solde_restant", 0).limit(5000),
        admin.from("payments").select("amount, kind").eq("organization_id", id).gte("received_at", since30).limit(5000),
        admin.from("app_events").select("id", { count: "exact", head: true }).eq("organization_id", id).eq("level", "error").gte("created_at", since7),
        admin
          .from("orders")
          .select("id, ref_demande, createdAt, montant_total, solde_restant, statut_paiement, workflow_status, devis, is_restock, cancelled_at, client_id, vendeur_id")
          .eq("organization_id", id)
          .order("createdAt", { ascending: false })
          .limit(20),
        admin.from("payments").select("id, received_at, kind, mode, amount, order_id, received_by, note").eq("organization_id", id).order("received_at", { ascending: false }).limit(20),
        admin.from("sales_returns").select("id, ref, created_at, designation, statut_traitement, montant").eq("organization_id", id).order("created_at", { ascending: false }).limit(15),
      ]);
    if (profilesRes.error) throw new Error(profilesRes.error.message);
    const profiles = profilesRes.data ?? [];

    // Names behind the ids shown on the page.
    const garageIds = profiles.map((p) => p.client_id).filter(Boolean) as string[];
    const livreurIds = profiles.map((p) => p.livreur_id).filter(Boolean) as string[];
    const orderRows = (recentOrders.data ?? []) as Record<string, unknown>[];
    const clientIds = [...new Set([...garageIds, ...orderRows.map((o) => o.client_id).filter(Boolean)])] as string[];
    const [clientNames, livreurNames] = await Promise.all([
      clientIds.length ? admin.from("clients").select("id, name").in("id", clientIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      livreurIds.length ? admin.from("livreurs").select("id, name").in("id", livreurIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    ]);
    const clientName = new Map((clientNames.data ?? []).map((c) => [String(c.id), String(c.name ?? "")]));
    const livreurName = new Map((livreurNames.data ?? []).map((l) => [String(l.id), String(l.name ?? "")]));
    const userById = new Map((users.data?.users ?? []).map((u) => [u.id, u]));
    const nameByUser = new Map(profiles.map((p) => [String(p.user_id), String(p.display_name ?? "")]));

    const accounts = profiles
      .map((p) => {
        const u = userById.get(String(p.user_id));
        const bannedUntil = (u as { banned_until?: string | null } | undefined)?.banned_until ?? null;
        const kind = p.client_id ? "GARAGE" : p.livreur_id ? "LIVREUR" : String(p.role ?? "CAISSIER");
        return {
          userId: String(p.user_id),
          name: String(p.display_name ?? "") || (p.client_id ? clientName.get(String(p.client_id)) : p.livreur_id ? livreurName.get(String(p.livreur_id)) : "") || "—",
          kind,
          /** The garage or livreur file the login belongs to. */
          linkedTo: p.client_id ? clientName.get(String(p.client_id)) ?? null : p.livreur_id ? livreurName.get(String(p.livreur_id)) ?? null : null,
          email: u?.email ?? null,
          lastSignIn: u?.last_sign_in_at ?? null,
          createdAt: u?.created_at ?? null,
          blocked: !!bannedUntil && new Date(bannedUntil).getTime() > Date.now(),
        };
      })
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

    const paidRows = (paid.data ?? []) as { amount: unknown; kind: string }[];
    return NextResponse.json({
      org: {
        id: String(org.id),
        name: String(org.name ?? ""),
        plan: String(org.plan ?? ""),
        status: String(org.subscription_status ?? ""),
        trialEndsAt: (org.trial_ends_at as string | null) ?? null,
        currentPeriodEnd: (org.current_period_end as string | null) ?? null,
        seatLimit: num(org.seat_limit),
        createdAt: String(org.created_at ?? ""),
        phone: (org.phone as string | null) ?? null,
        address: (org.address as string | null) ?? null,
        city: (org.city as string | null) ?? null,
        stripe: Boolean(org.stripe_subscription_id),
      },
      accounts,
      stats: {
        orders: orders.count ?? 0,
        devis: devis.count ?? 0,
        clients: clients.count ?? 0,
        invoices: invoices.count ?? 0,
        returns: returns.count ?? 0,
        savCases: cases.count ?? 0,
        stockItems: stock.count ?? 0,
        suppliers: suppliers.count ?? 0,
        orders30: (month.data ?? []).length,
        ca30: Math.round((month.data ?? []).reduce((s, r) => s + num((r as { montant_total: unknown }).montant_total), 0) * 100) / 100,
        collected30: Math.round(paidRows.filter((p) => p.kind !== "REMBOURSEMENT").reduce((s, p) => s + num(p.amount), 0) * 100) / 100,
        refunded30: Math.round(paidRows.filter((p) => p.kind === "REMBOURSEMENT").reduce((s, p) => s + num(p.amount), 0) * 100) / 100,
        openBalance: Math.round((open.data ?? []).reduce((s, r) => s + num((r as { solde_restant: unknown }).solde_restant), 0) * 100) / 100,
        /** null before migration 20261001040000. */
        errors7: errors.error ? null : errors.count ?? 0,
      },
      recentOrders: orderRows.map((o) => ({
        id: String(o.id),
        ref: String(o.ref_demande ?? ""),
        at: String(o.createdAt ?? ""),
        total: num(o.montant_total),
        balance: num(o.solde_restant),
        payment: String(o.statut_paiement ?? ""),
        workflow: String(o.workflow_status ?? ""),
        kind: o.is_restock ? "RÉAPPRO" : o.devis ? "DEVIS" : o.cancelled_at ? "ANNULÉE" : "COMMANDE",
        client: o.client_id ? clientName.get(String(o.client_id)) ?? null : null,
        by: nameByUser.get(String(o.vendeur_id)) ?? null,
      })),
      recentPayments: ((recentPayments.data ?? []) as Record<string, unknown>[]).map((p) => ({
        id: String(p.id),
        at: String(p.received_at ?? ""),
        kind: String(p.kind ?? ""),
        mode: String(p.mode ?? ""),
        amount: num(p.amount),
        note: (p.note as string | null) ?? null,
        by: nameByUser.get(String(p.received_by)) ?? null,
      })),
      recentReturns: ((recentReturns.data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        ref: String(r.ref ?? ""),
        at: String(r.created_at ?? ""),
        designation: (r.designation as string | null) ?? null,
        treatment: String(r.statut_traitement ?? ""),
        amount: num(r.montant),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Erreur serveur." }, { status: 500 });
  }
}
