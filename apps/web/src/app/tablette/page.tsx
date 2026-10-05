"use client";

import {
  AlertTriangle,
  Check,
  Clock,
  Delete,
  Hourglass,
  Loader2,
  LogOut,
  MessageSquare,
  PackageCheck,
  RefreshCw,
  Search,
  Send,
  Truck,
  UserRound,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import {
  backorderLines,
  deliveryOrdersOf,
  lineKind,
  lineMatches,
  pendingLines,
  prepareOrdersOf,
  toursOf,
  type DeliveryOrder,
  type PrepareOrder,
} from "@/lib/commandes-board";
import {
  loadReceptionBoard,
  loadSmsStates,
  markOrderSmsTreated,
  setLineReceptionStatus,
  type BoardLine,
  type ReceptionStatus,
  type SmsState,
} from "@/lib/data/commandes";
import { dispatchOrderToLivreur, loadLivreurs, markOrderDelivered, type Livreur } from "@/lib/data/livreurs";
import { loadOrganizationSettings, markLineReceived } from "@/lib/data/saas";
import { flushClientMessages } from "@/lib/data/sav";
import { identify, loadStaff, release, tabletPeople, type Identity, type StaffEntry } from "@/lib/data/tablet";
import { buildClientSms, formatE164, toE164, type SmsSettings } from "@/lib/sms";
import { accountSpace } from "@/lib/spaces";
import { createClient, setActorToken } from "@/lib/supabase/client";

/* ------------------------------------------------------------------ */
/*  Tablette du stock — « Suivi des commandes » seul, plein écran.     */
/*  Compte partagé ; avant de pointer, le caissier touche son nom et   */
/*  tape son code : chaque action est enregistrée à son nom (jeton     */
/*  x-actor-token, migration 20261005020000). 2 min sans toucher       */
/*  l'écran → retour au choix du nom.                                  */
/* ------------------------------------------------------------------ */

type Tab = "recevoir" | "preparer" | "livrer" | "reliquats";
const IDLE_MS = 2 * 60_000;
const REFRESH_MS = 30_000;
const NO_SMS_SETTINGS: SmsSettings = { magasin: "", horaires: null, readyTemplate: null, partialTemplate: null };

const STATUS: Record<ReceptionStatus, { label: string; cls: string }> = {
  PENDING: { label: "En attente", cls: "wait" },
  PARTIAL: { label: "Reçu partiel", cls: "partial" },
  BACKORDER: { label: "Reliquat", cls: "partial" },
  NOT_RECEIVED: { label: "Non reçu", cls: "no" },
  RECEIVED: { label: "Reçu", cls: "ok" },
};
const KIND_LABEL = { CLIENT: "Client", GARAGE: "Garage", STOCK: "Stock" } as const;

function hhmm(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return today ? time : `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${time}`;
}

function orderMatches(o: { ref: string; clientName: string; clientPhone: string | null; plate: string | null }, q: string): boolean {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [o.ref, o.clientName, o.clientPhone ?? "", o.plate ?? ""].join(" ").toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export default function TablettePage() {
  const { user, profile, ready, logout } = useAuth();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const orgId = profile?.organization_id;
  const space = accountSpace(profile, user?.email);
  const allowed = space === "caissier" || space === "admin";

  useEffect(() => {
    if (ready && !user) router.replace("/tablette/login");
  }, [ready, user, router]);

  /* ---- Qui pointe ---- */
  const [staff, setStaff] = useState<StaffEntry[]>([]);
  const people = useMemo(() => tabletPeople(staff), [staff]);
  const names = useMemo(() => new Map(staff.map((s) => [s.userId, s.name])), [staff]);
  const [me, setMe] = useState<Identity | null>(null);
  const meRef = useRef<Identity | null>(null);

  const lock = useCallback(() => {
    const cur = meRef.current;
    meRef.current = null;
    setActorToken(null);
    setMe(null);
    if (cur) void release(supabase, cur.token);
  }, [supabase]);

  const enter = useCallback((id: Identity) => {
    meRef.current = id;
    setActorToken(id.token);
    setMe(id);
  }, []);

  // Never leave a token behind when the page goes away.
  useEffect(() => () => setActorToken(null), []);

  // 2 minutes without touching the screen: back to « Qui pointe ? ».
  useEffect(() => {
    if (!me) return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    const timer = window.setInterval(() => {
      if (Date.now() - last > IDLE_MS) lock();
    }, 5_000);
    return () => {
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
      window.clearInterval(timer);
    };
  }, [me, lock]);

  /* ---- Données ---- */
  const [board, setBoard] = useState<BoardLine[]>([]);
  const [sms, setSms] = useState<Map<string, SmsState>>(new Map());
  const [livreurs, setLivreurs] = useState<Livreur[]>([]);
  const [smsSettings, setSmsSettings] = useState<SmsSettings>(NO_SMS_SETTINGS);
  const [magasin, setMagasin] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!orgId) return;
      if (!quiet) setLoading(true);
      try {
        const [b, s, l, org, st] = await Promise.all([
          loadReceptionBoard(supabase, orgId),
          loadSmsStates(supabase, orgId),
          loadLivreurs(supabase, orgId, { activeOnly: true }),
          loadOrganizationSettings(supabase, orgId).catch(() => null),
          loadStaff(supabase).catch(() => null),
        ]);
        setBoard(b);
        setSms(s);
        setLivreurs(l);
        if (st) setStaff(st);
        if (org) {
          setMagasin(org.name);
          setSmsSettings({ magasin: org.name, horaires: org.smsHoraires, readyTemplate: org.smsReadyTemplate, partialTemplate: org.smsPartialTemplate });
        }
        if (!quiet) setError(null);
      } catch (e) {
        if (!quiet) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [supabase, orgId],
  );

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  // What the counter pointed shows up here too.
  const sheetOpenRef = useRef(false);
  useEffect(() => {
    if (!me) return;
    const timer = window.setInterval(() => {
      if (!sheetOpenRef.current && document.visibilityState === "visible") void load(true);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [me, load]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /* ---- Listes ---- */
  const [tab, setTab] = useState<Tab>("recevoir");
  const [search, setSearch] = useState("");
  const [tourFilter, setTourFilter] = useState<string | null>(null);
  const pending = useMemo(() => pendingLines(board), [board]);
  const backorders = useMemo(() => backorderLines(board), [board]);
  const prepare = useMemo(() => prepareOrdersOf(board, sms), [board, sms]);
  const deliveries = useMemo(() => deliveryOrdersOf(board), [board]);
  const tours = useMemo(() => toursOf(pending), [pending]);
  const dispatchedBy = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const l of board) if (!m.has(l.orderId)) m.set(l.orderId, l.dispatchedBy);
    return m;
  }, [board]);

  const recevoirRows = useMemo(
    () =>
      pending.filter(
        (l) => (tourFilter === null || (l.tourName ?? "Hors tournée") === tourFilter) && lineMatches(l, search),
      ),
    [pending, tourFilter, search],
  );
  const reliquatRows = useMemo(() => backorders.filter((l) => lineMatches(l, search)), [backorders, search]);
  const prepareRows = useMemo(() => prepare.filter((o) => orderMatches(o, search)), [prepare, search]);
  const deliveryRows = useMemo(() => deliveries.filter((o) => orderMatches(o, search)), [deliveries, search]);

  const TABS: { id: Tab; label: string; count: number }[] = [
    { id: "recevoir", label: "À recevoir", count: pending.length },
    { id: "preparer", label: "À préparer", count: prepare.length },
    { id: "livrer", label: "À livrer", count: deliveries.length },
    { id: "reliquats", label: "Reliquats", count: backorders.length },
  ];

  /* ---- Actions ---- */
  async function act(key: string, fn: () => Promise<void>, ok: string) {
    if (!orgId || busy) return;
    setBusy(key);
    setError(null);
    try {
      await fn();
      setNotice(ok);
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const receive = (l: BoardLine, qty?: number) =>
    act(
      l.id,
      async () => {
        await markLineReceived(
          supabase,
          orgId as string,
          { id: l.id, reference: l.reference, designation: l.designation, quantity: l.quantity, receivedQuantity: l.received },
          qty,
        );
        flushClientMessages(); // « commande prête » queued by the database, if the magasin switched it on
      },
      qty ? `${l.reference} : ${qty} reçue${qty > 1 ? "s" : ""}.` : `${l.reference} reçue.`,
    );

  const setStatus = (l: BoardLine, status: "BACKORDER" | "NOT_RECEIVED") =>
    act(
      l.id,
      async () => {
        await setLineReceptionStatus(supabase, orgId as string, l.id, status);
        if (status === "BACKORDER") flushClientMessages(); // « retard fournisseur »
      },
      `${l.reference} : ${status === "BACKORDER" ? "reliquat" : "non reçue"}.`,
    );

  /** Réception partielle: the line whose quantity picker is open. */
  const [partial, setPartial] = useState<{ lineId: string; qty: number } | null>(null);

  /* SMS « commande prête » */
  const [smsOrder, setSmsOrder] = useState<PrepareOrder | null>(null);
  const smsPreview = useMemo(() => {
    if (!smsOrder) return null;
    const built = buildClientSms(
      smsOrder.complet ? "READY" : "PARTIAL",
      { client: smsOrder.clientId ? smsOrder.clientName : "", commande: smsOrder.ref },
      smsSettings,
    );
    return { to: toE164(smsOrder.clientPhone), ...built };
  }, [smsOrder, smsSettings]);
  const sendSms = () =>
    smsOrder &&
    act(
      `sms-${smsOrder.orderId}`,
      async () => {
        const res = await fetch("/api/send-sms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: smsOrder.orderId, kind: smsOrder.complet ? "READY" : "PARTIAL" }),
        });
        const sent = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(sent.error ?? "Envoi du SMS impossible.");
        setSmsOrder(null);
      },
      `SMS envoyé à ${smsOrder.clientName}.`,
    );

  /* Livreur */
  const [dispatch, setDispatch] = useState<{ order: DeliveryOrder; livreurId: string } | null>(null);
  const openDispatch = (o: DeliveryOrder) => {
    const active = (id: string | null) => (id && livreurs.some((l) => l.id === id) ? id : null);
    setDispatch({ order: o, livreurId: active(o.livreurId) ?? active(o.tourLivreurId) ?? livreurs[0]?.id ?? "" });
  };
  const submitDispatch = () =>
    dispatch &&
    dispatch.livreurId &&
    act(
      `dispatch-${dispatch.order.orderId}`,
      async () => {
        await dispatchOrderToLivreur(supabase, dispatch.order.orderId, dispatch.livreurId);
        setDispatch(null);
      },
      `${dispatch.order.ref} confiée à ${livreurs.find((l) => l.id === dispatch.livreurId)?.name ?? "au livreur"}.`,
    );
  const [deliverOrder, setDeliverOrder] = useState<DeliveryOrder | null>(null);
  const submitDelivered = () =>
    deliverOrder &&
    act(
      `deliver-${deliverOrder.orderId}`,
      async () => {
        await markOrderDelivered(supabase, deliverOrder.orderId);
        setDeliverOrder(null);
      },
      `${deliverOrder.ref} livrée.`,
    );

  const sheetOpen = Boolean(smsOrder || dispatch || deliverOrder || partial);
  useEffect(() => {
    sheetOpenRef.current = sheetOpen;
  }, [sheetOpen]);

  /* ---------------------------------------------------------------- */
  /*  Rendu                                                            */
  /* ---------------------------------------------------------------- */

  if (!ready || (user && !profile)) {
    return (
      <div className="tb-center">
        <Loader2 className="h-8 w-8 nc-spin" />
      </div>
    );
  }
  if (!user) return null;
  if (!allowed) {
    return (
      <div className="tb-center">
        <p className="tb-empty-title">Cette tablette doit être connectée avec un compte du magasin.</p>
        <button type="button" className="tb-btn" onClick={() => void logout().then(() => router.replace("/tablette/login"))}>
          <LogOut className="h-5 w-5" /> Se déconnecter
        </button>
      </div>
    );
  }

  if (!me) {
    return (
      <LockScreen
        magasin={magasin}
        people={people}
        loading={loading && staff.length === 0}
        onIdentify={async (person, pin) => {
          const res = await identify(supabase, person.userId, pin);
          if (res.ok) enter(res.identity);
          return res.ok ? null : res.error;
        }}
        onLogout={() => void logout().then(() => router.replace("/tablette/login"))}
      />
    );
  }

  const pointedLabel = (l: BoardLine) =>
    l.pointedBy && names.get(l.pointedBy) ? `Pointé par ${names.get(l.pointedBy)} · ${hhmm(l.pointedAt)}` : null;

  const lineCard = (l: BoardLine) => {
    const st = STATUS[l.status];
    const missing = Math.max(0, l.quantity - l.received);
    const isBusy = busy === l.id;
    const kind = lineKind(l);
    const who = pointedLabel(l);
    const open = partial?.lineId === l.id;
    return (
      <article key={l.id} className={`tb-card tb-card--${st.cls}`}>
        <div className="tb-card-head">
          <p className="tb-ref">{l.reference}</p>
          <span className={`tb-badge tb-badge--${st.cls}`}>{st.label}</span>
        </div>
        {l.designation && l.designation.trim().toLowerCase() !== l.reference.trim().toLowerCase() && <p className="tb-des">{l.designation}</p>}
        <p className="tb-meta">
          <span className={`tb-kind tb-kind--${kind.toLowerCase()}`}>{KIND_LABEL[kind]}</span>
          <strong>{l.clientName}</strong> · {l.orderRef}
        </p>
        <p className="tb-meta">
          {l.supplierName ?? "Stock magasin"}
          {l.tourName ? ` · ${l.tourName}` : ""}
          {l.expectedAt && l.status !== "RECEIVED" ? ` · prévu ${hhmm(l.expectedAt)}` : ""}
        </p>
        <div className="tb-qty">
          <span>
            Reçu <strong>{l.received}</strong> / {l.quantity}
          </span>
          {who && <span className="tb-who">{who}</span>}
        </div>

        {open ? (
          <div className="tb-partial">
            <span>Combien sont arrivées ?</span>
            <div className="tb-stepper">
              <button type="button" className="tb-step" onClick={() => setPartial({ lineId: l.id, qty: Math.max(1, (partial?.qty ?? 1) - 1) })} aria-label="Moins">
                −
              </button>
              <strong>{partial?.qty}</strong>
              <button
                type="button"
                className="tb-step"
                onClick={() => setPartial({ lineId: l.id, qty: Math.min(missing - 1, (partial?.qty ?? 1) + 1) })}
                aria-label="Plus"
              >
                +
              </button>
            </div>
            <div className="tb-actions">
              <button type="button" className="tb-btn tb-btn--ghost" onClick={() => setPartial(null)}>
                Annuler
              </button>
              <button
                type="button"
                className="tb-btn tb-btn--ok"
                disabled={isBusy}
                onClick={() => {
                  const q = partial?.qty ?? 1;
                  setPartial(null);
                  void receive(l, q);
                }}
              >
                {isBusy ? <Loader2 className="h-5 w-5 nc-spin" /> : <Check className="h-5 w-5" />} Valider
              </button>
            </div>
          </div>
        ) : (
          <div className="tb-actions">
            <button type="button" className="tb-btn tb-btn--ok tb-btn--main" disabled={busy !== null} onClick={() => void receive(l)}>
              {isBusy ? <Loader2 className="h-5 w-5 nc-spin" /> : <Check className="h-5 w-5" />}
              Reçu{missing > 1 ? ` (${missing})` : ""}
            </button>
            {missing > 1 && (
              <button type="button" className="tb-btn" disabled={busy !== null} onClick={() => setPartial({ lineId: l.id, qty: 1 })}>
                Partiel
              </button>
            )}
            <button type="button" className="tb-btn" disabled={busy !== null || l.status === "BACKORDER"} onClick={() => void setStatus(l, "BACKORDER")}>
              <Hourglass className="h-5 w-5" /> Reliquat
            </button>
            <button type="button" className="tb-btn tb-btn--no" disabled={busy !== null || l.status === "NOT_RECEIVED"} onClick={() => void setStatus(l, "NOT_RECEIVED")}>
              <X className="h-5 w-5" /> Non reçu
            </button>
          </div>
        )}
      </article>
    );
  };

  const empty = (text: string) => (
    <div className="tb-empty">
      <PackageCheck className="h-10 w-10" />
      <p>{loading ? "Chargement…" : text}</p>
    </div>
  );

  return (
    <div className="tb-page">
      <header className="tb-top">
        <div className="tb-top-title">
          <p className="tb-shop">{magasin || "Magasin"}</p>
          <h1>Suivi des commandes</h1>
        </div>
        <button type="button" className="tb-me" onClick={lock} title="Changer de caissier">
          <UserRound className="h-5 w-5" />
          <span>{me.name}</span>
          <small>Changer</small>
        </button>
        <button type="button" className="tb-icon-btn" onClick={() => void load()} aria-label="Actualiser" disabled={loading}>
          <RefreshCw className={`h-6 w-6${loading ? " nc-spin" : ""}`} />
        </button>
      </header>

      <nav className="tb-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tb-tab${tab === t.id ? " tb-tab--on" : ""}`}
            onClick={() => {
              setTab(t.id);
              setPartial(null);
            }}
          >
            <span>{t.label}</span>
            <strong>{t.count}</strong>
          </button>
        ))}
      </nav>

      <div className="tb-search">
        <Search className="h-5 w-5" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Référence, n° de commande, client, plaque…"
          aria-label="Rechercher"
        />
        {search && (
          <button type="button" onClick={() => setSearch("")} aria-label="Effacer">
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {error && (
        <div className="tb-error">
          <AlertTriangle className="h-5 w-5" /> {error}
        </div>
      )}

      <main className="tb-list">
        {tab === "recevoir" && (
          <>
            {tours.length > 1 && (
              <div className="tb-chips">
                <button type="button" className={`tb-chip${tourFilter === null ? " tb-chip--on" : ""}`} onClick={() => setTourFilter(null)}>
                  Toutes ({pending.length})
                </button>
                {tours.map((t) => (
                  <button key={t.name} type="button" className={`tb-chip${tourFilter === t.name ? " tb-chip--on" : ""}`} onClick={() => setTourFilter(t.name)}>
                    {t.name} ({t.count})
                  </button>
                ))}
              </div>
            )}
            {recevoirRows.length === 0 ? empty(search ? "Aucune pièce pour cette recherche." : "Toutes les pièces sont pointées.") : recevoirRows.map(lineCard)}
          </>
        )}

        {tab === "reliquats" && (reliquatRows.length === 0 ? empty("Aucun reliquat.") : reliquatRows.map(lineCard))}

        {tab === "preparer" &&
          (prepareRows.length === 0
            ? empty("Aucune commande à préparer.")
            : prepareRows.map((o) => (
                <article key={o.orderId} className="tb-card">
                  <div className="tb-card-head">
                    <p className="tb-ref">{o.ref}</p>
                    <span className={`tb-badge tb-badge--${o.complet ? "ok" : "partial"}`}>{o.complet ? "Complète" : "Partielle"}</span>
                  </div>
                  <p className="tb-meta">
                    <strong>{o.clientName}</strong>
                    {o.clientPhone ? ` · ${o.clientPhone}` : ""}
                    {o.plate ? ` · ${o.plate}` : ""}
                  </p>
                  <div className="tb-qty">
                    <span>
                      <strong>{o.received}</strong> / {o.total} pièce{o.total > 1 ? "s" : ""} reçue{o.received > 1 ? "s" : ""}
                    </span>
                    {o.state.sent && <span className="tb-who">SMS envoyé</span>}
                  </div>
                  <div className="tb-actions">
                    <button type="button" className="tb-btn" disabled={busy !== null || !o.clientPhone} onClick={() => setSmsOrder(o)}>
                      <MessageSquare className="h-5 w-5" /> {o.state.sent ? "Renvoyer le SMS" : "Prévenir par SMS"}
                    </button>
                    <button
                      type="button"
                      className="tb-btn tb-btn--ok tb-btn--main"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(`done-${o.orderId}`, () => markOrderSmsTreated(supabase, orgId as string, o.orderId), `${o.ref} traitée.`)
                      }
                    >
                      {busy === `done-${o.orderId}` ? <Loader2 className="h-5 w-5 nc-spin" /> : <Check className="h-5 w-5" />} Traité
                    </button>
                  </div>
                </article>
              )))}

        {tab === "livrer" &&
          (deliveryRows.length === 0
            ? empty("Aucune commande à livrer.")
            : deliveryRows.map((o) => {
                const by = dispatchedBy.get(o.orderId);
                return (
                  <article key={o.orderId} className="tb-card">
                    <div className="tb-card-head">
                      <p className="tb-ref">{o.ref}</p>
                      <span className={`tb-badge tb-badge--${o.stage === "TRANSIT" ? "transit" : o.stage === "READY" ? "ok" : "wait"}`}>
                        {o.stage === "TRANSIT" ? "En livraison" : o.stage === "READY" ? "Prête à envoyer" : "En attente"}
                      </span>
                    </div>
                    <p className="tb-meta">
                      <strong>{o.clientName}</strong>
                      {o.address || o.city ? ` · ${[o.address, o.city].filter(Boolean).join(", ")}` : ""}
                    </p>
                    <p className="tb-meta">
                      {o.stage === "AWAITING"
                        ? `${o.missing} pièce${o.missing > 1 ? "s" : ""} pas encore reçue${o.missing > 1 ? "s" : ""}`
                        : `${o.pieces} pièce${o.pieces > 1 ? "s" : ""}`}
                      {o.tourName ? ` · ${o.tourName}` : ""}
                    </p>
                    {o.stage === "TRANSIT" && (
                      <div className="tb-qty">
                        <span>
                          <Truck className="h-4 w-4" /> {o.livreurName ?? "Livreur"}
                        </span>
                        {by && names.get(by) && <span className="tb-who">Confiée par {names.get(by)}</span>}
                      </div>
                    )}
                    {o.failedReason && o.attempts > 0 && <p className="tb-fail">Dernier passage : {o.failedReason}</p>}
                    <div className="tb-actions">
                      {o.stage === "TRANSIT" ? (
                        <>
                          <button type="button" className="tb-btn" disabled={busy !== null} onClick={() => openDispatch(o)}>
                            Changer de livreur
                          </button>
                          <button type="button" className="tb-btn tb-btn--ok tb-btn--main" disabled={busy !== null} onClick={() => setDeliverOrder(o)}>
                            <Check className="h-5 w-5" /> Livrée
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={`tb-btn tb-btn--main${o.stage === "READY" ? " tb-btn--ok" : ""}`}
                          disabled={busy !== null || livreurs.length === 0}
                          onClick={() => openDispatch(o)}
                        >
                          <Send className="h-5 w-5" /> {o.stage === "READY" ? "Envoyer au livreur" : "Envoyer quand même"}
                        </button>
                      )}
                    </div>
                  </article>
                );
              }))}
      </main>

      {notice && (
        <div className="tb-toast" role="status">
          <Check className="h-5 w-5" /> {notice}
        </div>
      )}

      {/* ---- SMS ---- */}
      {smsOrder && smsPreview && (
        <Sheet title={`Prévenir ${smsOrder.clientName}`} onClose={() => setSmsOrder(null)}>
          <p className="tb-sheet-line">
            {smsPreview.to ? <strong>{formatE164(smsPreview.to)}</strong> : <span className="tb-fail">Numéro de téléphone invalide</span>}
          </p>
          <div className="sms-bubble">{smsPreview.text}</div>
          <div className="tb-actions">
            <button type="button" className="tb-btn tb-btn--ghost" onClick={() => setSmsOrder(null)}>
              Annuler
            </button>
            <button type="button" className="tb-btn tb-btn--ok tb-btn--main" disabled={busy !== null || !smsPreview.to} onClick={() => void sendSms()}>
              {busy?.startsWith("sms-") ? <Loader2 className="h-5 w-5 nc-spin" /> : <MessageSquare className="h-5 w-5" />} Envoyer le SMS
            </button>
          </div>
        </Sheet>
      )}

      {/* ---- Livreur ---- */}
      {dispatch && (
        <Sheet title={`${dispatch.order.ref} — quel livreur ?`} onClose={() => setDispatch(null)}>
          <div className="tb-choices">
            {livreurs.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`tb-choice${dispatch.livreurId === l.id ? " tb-choice--on" : ""}`}
                onClick={() => setDispatch({ ...dispatch, livreurId: l.id })}
              >
                <Truck className="h-5 w-5" /> {l.name}
              </button>
            ))}
          </div>
          {dispatch.order.stage === "AWAITING" && (
            <p className="tb-fail">
              {dispatch.order.missing} pièce{dispatch.order.missing > 1 ? "s" : ""} pas encore reçue{dispatch.order.missing > 1 ? "s" : ""} : envoi partiel.
            </p>
          )}
          <div className="tb-actions">
            <button type="button" className="tb-btn tb-btn--ghost" onClick={() => setDispatch(null)}>
              Annuler
            </button>
            <button type="button" className="tb-btn tb-btn--ok tb-btn--main" disabled={busy !== null || !dispatch.livreurId} onClick={() => void submitDispatch()}>
              {busy?.startsWith("dispatch-") ? <Loader2 className="h-5 w-5 nc-spin" /> : <Send className="h-5 w-5" />} Confier au livreur
            </button>
          </div>
        </Sheet>
      )}

      {/* ---- Livrée ---- */}
      {deliverOrder && (
        <Sheet title={`${deliverOrder.ref} livrée ?`} onClose={() => setDeliverOrder(null)}>
          <p className="tb-sheet-line">
            {deliverOrder.clientName} — {deliverOrder.livreurName ?? "livreur"}
          </p>
          <div className="tb-actions">
            <button type="button" className="tb-btn tb-btn--ghost" onClick={() => setDeliverOrder(null)}>
              Annuler
            </button>
            <button type="button" className="tb-btn tb-btn--ok tb-btn--main" disabled={busy !== null} onClick={() => void submitDelivered()}>
              {busy?.startsWith("deliver-") ? <Loader2 className="h-5 w-5 nc-spin" /> : <Check className="h-5 w-5" />} Oui, livrée
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/* ---- Bas d'écran (feuille) pour confirmer une action ---- */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="tb-sheet-overlay" onClick={onClose}>
      <div className="tb-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="tb-sheet-head">
          <p>{title}</p>
          <button type="button" className="tb-icon-btn" onClick={onClose} aria-label="Fermer">
            <X className="h-6 w-6" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---- « Qui pointe ? » : le nom, puis le code à 4 chiffres ---- */
function LockScreen({
  magasin,
  people,
  loading,
  onIdentify,
  onLogout,
}: {
  magasin: string;
  people: StaffEntry[];
  loading: boolean;
  /** null = accepted, else the message to show. */
  onIdentify: (person: StaffEntry, pin: string) => Promise<string | null>;
  onLogout: () => void;
}) {
  const [person, setPerson] = useState<StaffEntry | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /** Logout sits behind a long press: nobody leaves the tablet by accident. */
  const pressTimer = useRef<number | null>(null);

  const press = async (digit: string) => {
    if (!person || checking || pin.length >= 4) return;
    const next = pin + digit;
    setPin(next);
    setError(null);
    if (next.length === 4) {
      setChecking(true);
      const err = await onIdentify(person, next);
      setChecking(false);
      if (err) {
        setError(err);
        setPin("");
      }
    }
  };

  return (
    <div className="tb-lock">
      <div className="tb-lock-head">
        <p className="tb-shop">{magasin || "Magasin"}</p>
        <h1>{person ? person.name : "Qui pointe ?"}</h1>
        <p className="tb-lock-sub">{person ? "Tapez votre code à 4 chiffres" : "Touchez votre nom"}</p>
      </div>

      {!person ? (
        loading ? (
          <div className="tb-center">
            <Loader2 className="h-8 w-8 nc-spin" />
          </div>
        ) : people.length === 0 ? (
          <div className="tb-empty">
            <Clock className="h-10 w-10" />
            <p>Aucun code tablette. Un administrateur les définit dans Admin → Équipe → « Code tablette ».</p>
          </div>
        ) : (
          <div className="tb-people">
            {people.map((p) => (
              <button
                key={p.userId}
                type="button"
                className="tb-person"
                onClick={() => {
                  setPerson(p);
                  setPin("");
                  setError(null);
                }}
              >
                <span className="tb-person-avatar">{p.name.slice(0, 2).toUpperCase()}</span>
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        )
      ) : (
        <div className="tb-pin">
          <div className={`tb-dots${error ? " tb-dots--error" : ""}`} aria-label={`${pin.length} chiffre(s) saisi(s)`}>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={i < pin.length ? "on" : ""} />
            ))}
          </div>
          <p className="tb-pin-error" role="alert">
            {checking ? "Vérification…" : error ?? " "}
          </p>
          <div className="tb-keys">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button key={d} type="button" className="tb-key" onClick={() => void press(d)} disabled={checking}>
                {d}
              </button>
            ))}
            <button type="button" className="tb-key tb-key--text" onClick={() => setPerson(null)} disabled={checking}>
              Retour
            </button>
            <button type="button" className="tb-key" onClick={() => void press("0")} disabled={checking}>
              0
            </button>
            <button type="button" className="tb-key tb-key--text" onClick={() => setPin((p) => p.slice(0, -1))} disabled={checking} aria-label="Effacer">
              <Delete className="h-7 w-7" />
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        className="tb-lock-logout"
        onPointerDown={() => {
          pressTimer.current = window.setTimeout(onLogout, 1500);
        }}
        onPointerUp={() => {
          if (pressTimer.current) window.clearTimeout(pressTimer.current);
        }}
        onPointerLeave={() => {
          if (pressTimer.current) window.clearTimeout(pressTimer.current);
        }}
      >
        Appui long pour déconnecter la tablette
      </button>
    </div>
  );
}
