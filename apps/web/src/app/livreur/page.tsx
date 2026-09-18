"use client";

import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  CloudOff,
  KeyRound,
  Loader2,
  LogOut,
  MapPin,
  Navigation,
  Package,
  Phone,
  RefreshCw,
  RotateCcw,
  Trash2,
  Truck,
  Warehouse,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { NotificationBell } from "@/components/NotificationBell";
import { ReturnsTab } from "@/components/livreur/ReturnsTab";
import { TourTab, type NextTour } from "@/components/livreur/TourTab";
import { Toast } from "@/components/ui/Toast";
import { ChangePasswordDialog } from "@/components/auth/ChangePasswordDialog";
import { createClient } from "@/lib/supabase/client";
import {
  addDays,
  applyQueuedTourActions,
  loadSupplierTourBoard,
  parisDate,
  TourBoardUnavailableError,
  type PickupStatus,
  type SupplierTour,
  type SupplierTourBoard,
  type TourLine,
  type TourStatus,
} from "@/lib/data/tournees";
import {
  buildFailureReason,
  compressImage,
  DELIVERY_FAILURE_REASONS,
  DeliveryNetworkError,
  deliverOrder,
  isNetworkError,
  LivreurDisabledError,
  loadLivreurTour,
  mapsLink,
  reportDeliveryFailure,
  splitTour,
  uploadProofOfDelivery,
  type TourStop,
} from "@/lib/data/delivery";
import { completeReturnLeg, deferLineToNextTour, setLinePickup, setSupplierTourStatus, type TourReturn } from "@/lib/data/tournees";
import {
  clearTourCache,
  flushOutbox,
  listOutbox,
  loadPickupsCache,
  loadTourCache,
  newOutboxId,
  outboxAvailable,
  putOutbox,
  savePickupsCache,
  saveTourCache,
  type FlushReport,
  type OutboxItem,
} from "@/lib/data/delivery-outbox";
import { homeSpace } from "@/lib/spaces";

/** Background refresh while the app is in front (new assignments also arrive by Realtime). */
const REFRESH_MS = 60_000;

function fmtTime(v: string | number | null): string {
  if (v === null || v === "") return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function fmtDay(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  return Number.isNaN(d.getTime()) ? isoDate : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function pieceCount(s: TourStop): number {
  return s.pieces.reduce((n, p) => n + p.quantity, 0);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n > 1 ? "s" : ""}`;
}

function flushSummary(report: FlushReport): { notice: string | null; error: string | null } {
  const notices: string[] = [];
  if (report.sent.length > 0) {
    notices.push(`${plural(report.sent.length, "confirmation")} gardée${report.sent.length > 1 ? "s" : ""} hors connexion envoyée${report.sent.length > 1 ? "s" : ""} au magasin.`);
  }
  // A pickup refused because the tour moved on is not worth an error banner.
  report.rejected = report.rejected.filter((r) => r.item.kind !== "pickup" && r.item.kind !== "tour" && r.item.kind !== "return");
  if (report.photoDropped.length > 0) {
    notices.push(`Photo refusée pour ${report.photoDropped.map((i) => i.ref).join(", ")} : livraison confirmée sans photo.`);
  }
  return {
    notice: notices.length > 0 ? notices.join(" ") : null,
    error: report.rejected.length > 0 ? report.rejected.map((r) => `${r.item.ref} : ${r.message}`).join(" · ") : null,
  };
}

/**
 * Mobile space for a LIVREUR: the deliveries assigned to them (served by the
 * livreur_tour() RPC — nothing else of the magasin is readable), in tour
 * order, with the address, a call button, the itinerary, and one clear
 * outcome per stop. Works through dead zones: the last tour stays on screen
 * and outcomes recorded offline are sent when the network comes back.
 */
export default function LivreurPage() {
  const { user, profile, ready, logout } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

  const userId = user?.id ?? null;
  const orgId = profile?.organization_id ?? null;
  const livreurId = profile?.livreur_id ?? null;
  const isLivreur = profile?.role === "LIVREUR";

  const [stops, setStops] = useState<TourStop[]>([]);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [today, setToday] = useState(() => new Date());
  const refreshing = useRef(false);

  /* ---- Tournée fournisseurs (onglet) ---- */
  const [tab, setTab] = useState<"tournee" | "livraisons" | "retours">("tournee");
  const [pickupDay, setPickupDay] = useState(() => parisDate());
  const [pickups, setPickups] = useState<SupplierTourBoard | null>(null);
  const [pickupsLoading, setPickupsLoading] = useState(false);
  const [pickupsError, setPickupsError] = useState<string | null>(null);
  const pickupsSeq = useRef(0);

  // Only livreur sessions belong here — anonymous visitors get this
  // space's login page, other accounts go to their own space.
  useEffect(() => {
    if (!ready) return;
    if (!user) {
      router.replace("/livreur/login");
      return;
    }
    if (profile?.role !== "LIVREUR") router.replace(homeSpace(profile, user.email));
  }, [ready, user, profile, router]);

  // Installable app + offline shell, limited to /livreur. The first version
  // registered the worker for the whole site: hand the site back.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const sw = navigator.serviceWorker;
    void sw
      .getRegistrations()
      .then(async (regs) => {
        for (const r of regs) if (new URL(r.scope).pathname === "/") await r.unregister();
        await sw.register("/sw.js", { scope: "/livreur" });
      })
      .catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    if (!userId || !orgId || !livreurId || !isLivreur || refreshing.current) return;
    refreshing.current = true;
    setLoading(true);
    let flushError: string | null = null;
    try {
      // Outcomes recorded offline go first, so the fresh tour reflects them.
      if (outboxAvailable()) {
        try {
          const summary = flushSummary(await flushOutbox(supabase, userId));
          if (summary.notice) setNotice(summary.notice);
          flushError = summary.error;
          setOutbox(await listOutbox(userId));
        } catch {
          /* IndexedDB blocked on this phone: nothing can be queued */
        }
      }
      const fresh = await loadLivreurTour(supabase, { orgId, livreurId });
      setStops(fresh);
      setSyncedAt(Date.now());
      setDisabled(false);
      setError(flushError);
      saveTourCache(userId, fresh);
    } catch (e) {
      if (e instanceof LivreurDisabledError) {
        setDisabled(true);
        setStops([]);
        clearTourCache(userId);
      } else if (isNetworkError(e)) {
        // Dead zone: keep the tour on screen, the banner says it.
        if (flushError) setError(flushError);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      refreshing.current = false;
      setLoading(false);
      setToday(new Date());
    }
  }, [supabase, userId, orgId, livreurId, isLivreur]);

  const refreshPickups = useCallback(async () => {
    if (!userId || !livreurId || !isLivreur) return;
    const mine = ++pickupsSeq.current;
    setPickupsLoading(true);
    try {
      const fresh = await loadSupplierTourBoard(supabase, pickupDay);
      if (pickupsSeq.current !== mine) return;
      setPickups(fresh);
      setPickupsError(null);
      savePickupsCache(userId, fresh);
    } catch (e) {
      if (pickupsSeq.current !== mine) return;
      if (e instanceof LivreurDisabledError) {
        setDisabled(true);
      } else if (isNetworkError(e)) {
        // Dead zone: the cached board stays on screen.
      } else if (e instanceof TourBoardUnavailableError) {
        setPickupsError("La tournée fournisseurs n'est pas encore activée par votre magasin.");
      } else {
        setPickupsError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (pickupsSeq.current === mine) setPickupsLoading(false);
    }
  }, [supabase, userId, livreurId, isLivreur, pickupDay]);

  // Last tour loaded on this phone + what is waiting to be sent.
  useEffect(() => {
    if (!userId || !isLivreur) return;
    const cached = loadTourCache(userId);
    if (cached) {
      setStops(cached.stops);
      setSyncedAt(cached.savedAt);
    }
    void listOutbox(userId).then(setOutbox).catch(() => {});
  }, [userId, isLivreur]);

  // Supplier tours of the chosen day: cache first, then the server.
  useEffect(() => {
    if (!userId || !isLivreur) return;
    setPickups(loadPickupsCache(userId, pickupDay)?.board ?? null);
    void refreshPickups();
  }, [userId, isLivreur, pickupDay, refreshPickups]);

  // Stay current: on open, when the app comes back to the front or the
  // network returns, every minute, and as soon as a delivery is assigned.
  useEffect(() => {
    if (!userId || !isLivreur) return;
    void refresh();
    const both = () => {
      void refresh();
      void refreshPickups();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") both();
    };
    const onOnline = () => both();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) both();
    }, REFRESH_MS);
    const channel = supabase
      .channel(`livreur-tour:${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        () => both(),
      )
      .subscribe();
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [supabase, userId, isLivreur, refresh, refreshPickups]);

  const { toDeliver, failedToday, deliveredToday } = useMemo(() => splitTour(stops, today), [stops, today]);
  const queued = useMemo(
    () => new Map(outbox.filter((i) => i.kind === "deliver" || i.kind === "fail").map((i) => [i.orderId, i.kind] as const)),
    [outbox],
  );
  const queuedLines = useMemo(() => new Set(outbox.flatMap((i) => (i.kind === "pickup" && i.lineId ? [i.lineId] : []))), [outbox]);
  const queuedTours = useMemo(() => new Set(outbox.flatMap((i) => (i.kind === "tour" && i.tourId ? [i.tourId] : []))), [outbox]);
  const queuedReturns = useMemo(() => new Set(outbox.flatMap((i) => (i.kind === "return" && i.returnId ? [i.returnId] : []))), [outbox]);
  const shownPickups = useMemo(() => (pickups ? applyQueuedTourActions(pickups, outbox) : null), [pickups, outbox]);
  const pickupToday = parisDate(today);
  const pickupTomorrow = addDays(pickupToday, 1);
  const pickupsLeft = useMemo(() => {
    if (!shownPickups || pickupDay !== pickupToday) return 0;
    return shownPickups.lines.filter((l) => l.receptionStatus !== "RECEIVED" && l.receptionStatus !== "NOT_RECEIVED" && !l.pickupStatus).length;
  }, [shownPickups, pickupDay, pickupToday]);
  const returnsLeft = useMemo(
    () => (shownPickups && pickupDay === pickupToday ? shownPickups.returns.filter((r) => !r.done).length : 0),
    [shownPickups, pickupDay, pickupToday],
  );
  const dayLabel = useMemo(() => new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "2-digit", month: "short" }).format(today), [today]);

  const markLocally = (orderId: string, patch: Partial<TourStop>) =>
    setStops((prev) => prev.map((s) => (s.id === orderId ? { ...s, ...patch } : s)));

  const enqueue = async (
    item: Pick<
      OutboxItem,
      "kind" | "orderId" | "ref" | "recipient" | "note" | "reason" | "photo" | "podPath" | "lineId" | "pickupStatus" | "tourId" | "tourStatus" | "returnId" | "returnDone"
    >,
  ) => {
    if (!userId || !orgId || !outboxAvailable()) {
      throw new Error("Pas de réseau, et ce téléphone ne peut pas garder la confirmation : réessayez dès que la connexion revient.");
    }
    await putOutbox({ ...item, id: newOutboxId(), userId, orgId, createdAt: Date.now() });
    setOutbox(await listOutbox(userId));
  };

  /* ---- Fournisseurs : pièce récupérée / indispo, tournée partie / terminée ---- */
  const patchPickupLine = (lineId: string, status: PickupStatus | null) =>
    setPickups((b) =>
      b
        ? {
            ...b,
            lines: b.lines.map((l) =>
              l.id === lineId ? { ...l, pickupStatus: status, pickupAt: status ? new Date().toISOString() : null } : l,
            ),
          }
        : b,
    );

  const pickupPart = async (line: TourLine, status: PickupStatus | null) => {
    if (!userId || !orgId) return;
    const before = line.pickupStatus;
    patchPickupLine(line.id, status);
    try {
      if (!navigator.onLine) throw new DeliveryNetworkError("offline");
      await setLinePickup(supabase, line.id, status);
      void refreshPickups();
    } catch (e) {
      if (isNetworkError(e)) {
        try {
          await enqueue({ kind: "pickup", orderId: line.orderId, ref: line.reference, lineId: line.id, pickupStatus: status });
        } catch (qe) {
          patchPickupLine(line.id, before);
          setPickupsError(qe instanceof Error ? qe.message : String(qe));
        }
      } else {
        patchPickupLine(line.id, before);
        setPickupsError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const changeTourStatus = async (tour: SupplierTour, status: TourStatus, left: number) => {
    if (!userId || !orgId) return;
    if (
      status === "TERMINEE" &&
      left > 0 &&
      !window.confirm(`${plural(left, "pièce")} pas encore récupérée${left > 1 ? "s" : ""}. Terminer ${tour.name} quand même ?`)
    ) {
      return;
    }
    const before = tour.status;
    setPickups((b) => (b ? { ...b, tours: b.tours.map((t) => (t.id === tour.id ? { ...t, status } : t)) } : b));
    try {
      if (!navigator.onLine) throw new DeliveryNetworkError("offline");
      await setSupplierTourStatus(supabase, tour.id, status);
      setNotice(status === "TERMINEE" ? `${tour.name} terminée : le magasin est prévenu.` : `${tour.name} ${status === "EN_COURS" ? "démarrée" : "mise à jour"}.`);
      void refreshPickups();
    } catch (e) {
      if (isNetworkError(e)) {
        try {
          await enqueue({ kind: "tour", orderId: "", ref: tour.name, tourId: tour.id, tourStatus: status });
          setNotice(`${tour.name} : gardé sur le téléphone, envoyé au magasin dès le retour du réseau.`);
        } catch (qe) {
          setPickups((b) => (b ? { ...b, tours: b.tours.map((t) => (t.id === tour.id ? { ...t, status: before } : t)) } : b));
          setPickupsError(qe instanceof Error ? qe.message : String(qe));
        }
      } else {
        setPickups((b) => (b ? { ...b, tours: b.tours.map((t) => (t.id === tour.id ? { ...t, status: before } : t)) } : b));
        setPickupsError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  /* ---- Reporter une pièce à la tournée suivante (un déplacement : réseau requis) ---- */
  const [deferring, setDeferring] = useState<ReadonlySet<string>>(() => new Set());
  const deferPart = async (line: TourLine, next: NextTour) => {
    if (!navigator.onLine) {
      setPickupsError("Il faut du réseau pour reporter une pièce à la tournée suivante.");
      return;
    }
    setDeferring((s) => new Set(s).add(line.id));
    try {
      const moved = await deferLineToNextTour(supabase, line.id);
      const slot = (moved.slot ?? next.slot).replace(":", "h");
      setNotice(`${line.reference} reportée à ${moved.tourName} (${slot})${moved.date && moved.date !== pickupDay ? ` du ${fmtDay(moved.date)}` : ""}.`);
      await refreshPickups();
    } catch (e) {
      setPickupsError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeferring((s) => {
        const n = new Set(s);
        n.delete(line.id);
        return n;
      });
    }
  };

  /* ---- Retours : récupéré chez le garage / déposé chez le fournisseur ---- */
  const patchReturn = (id: string, done: boolean) =>
    setPickups((b) =>
      b ? { ...b, returns: b.returns.map((r) => (r.id === id ? { ...r, done, doneAt: done ? new Date().toISOString() : null } : r)) } : b,
    );

  const completeReturn = async (ret: TourReturn, done: boolean) => {
    if (!userId || !orgId) return;
    const before = ret.done;
    patchReturn(ret.id, done);
    try {
      if (!navigator.onLine) throw new DeliveryNetworkError("offline");
      await completeReturnLeg(supabase, ret.id, done);
      setNotice(
        done
          ? `${ret.designation} : ${ret.leg === "GARAGE_TO_STORE" ? "récupéré" : "déposé"}, le magasin est prévenu.`
          : `${ret.designation} : remis à faire.`,
      );
      void refreshPickups();
    } catch (e) {
      if (isNetworkError(e)) {
        try {
          await enqueue({ kind: "return", orderId: "", ref: ret.designation, returnId: ret.id, returnDone: done });
          setNotice(`${ret.designation} : gardé sur le téléphone, envoyé au magasin dès le retour du réseau.`);
        } catch (qe) {
          patchReturn(ret.id, before);
          setPickupsError(qe instanceof Error ? qe.message : String(qe));
        }
      } else {
        patchReturn(ret.id, before);
        setPickupsError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const [pwdOpen, setPwdOpen] = useState(false);
  const signOut = () => {
    if (
      outbox.length > 0 &&
      !window.confirm(
        `${plural(outbox.length, "confirmation")} pas encore envoyée${outbox.length > 1 ? "s" : ""} au magasin : elle${outbox.length > 1 ? "s" : ""} partira${outbox.length > 1 ? "ont" : ""} à votre prochaine connexion sur ce téléphone. Se déconnecter ?`,
      )
    ) {
      return;
    }
    if (userId) clearTourCache(userId);
    void logout().then(() => router.replace("/livreur/login"));
  };

  /* ---- Livrée (avec preuve) ---- */
  const [deliver, setDeliver] = useState<TourStop | null>(null);
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  /** The photo already reached Storage: a retry only re-sends the confirmation. */
  const uploaded = useRef<{ file: File; path: string } | null>(null);

  useEffect(
    () => () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    },
    [photoUrl],
  );

  const pickPhoto = (file: File | null) => {
    setPhoto(file);
    setPhotoUrl(file ? URL.createObjectURL(file) : null);
    uploaded.current = null;
    setModalError(null);
  };

  const openDeliver = (s: TourStop) => {
    setDeliver(s);
    setRecipient("");
    setNote("");
    pickPhoto(null);
  };

  const closeDeliver = () => {
    setDeliver(null);
    pickPhoto(null);
  };

  const submitDeliver = async () => {
    if (!deliver || !orgId) return;
    const target = deliver;
    setBusy(true);
    setModalError(null);
    let small: Blob | null = null;
    let sendingPhoto = Boolean(photo);
    try {
      if (photo) small = await compressImage(photo);
      if (!navigator.onLine) throw new DeliveryNetworkError("offline");
      let podPath: string | null = null;
      if (photo && small) {
        if (uploaded.current?.file === photo) {
          podPath = uploaded.current.path;
        } else {
          podPath = await uploadProofOfDelivery(supabase, orgId, target.id, small);
          uploaded.current = { file: photo, path: podPath };
        }
      }
      sendingPhoto = false;
      await deliverOrder(supabase, { orderId: target.id, recipient, note, podPath });
      markLocally(target.id, { workflow: "DELIVERED", deliveredAt: new Date().toISOString() });
      setNotice(`${target.ref} livrée ✓`);
      closeDeliver();
      void refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isNetworkError(e)) {
        const podPath = photo && uploaded.current?.file === photo ? uploaded.current.path : null;
        try {
          await enqueue({
            kind: "deliver",
            orderId: target.id,
            ref: target.ref,
            recipient,
            note,
            photo: podPath ? null : small,
            podPath,
          });
          setNotice(`${target.ref} : livraison gardée sur le téléphone, envoyée au magasin dès le retour du réseau.`);
          closeDeliver();
        } catch (qe) {
          setModalError(qe instanceof Error ? qe.message : String(qe));
        }
      } else if (sendingPhoto) {
        setModalError(`La photo n'a pas pu être envoyée (${message}). Reprenez-la, ou retirez-la pour confirmer sans photo.`);
      } else {
        setModalError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  /* ---- Non livrée ---- */
  const [fail, setFail] = useState<TourStop | null>(null);
  const [failReason, setFailReason] = useState<string>(DELIVERY_FAILURE_REASONS[0]);
  const [failDetail, setFailDetail] = useState("");

  const openFail = (s: TourStop) => {
    setFail(s);
    setFailReason(DELIVERY_FAILURE_REASONS[0]);
    setFailDetail("");
    setModalError(null);
  };

  const submitFail = async () => {
    if (!fail) return;
    const target = fail;
    const reason = buildFailureReason(failReason, failDetail);
    if (!reason) {
      setModalError("Précisez le motif.");
      return;
    }
    setBusy(true);
    setModalError(null);
    try {
      if (!navigator.onLine) throw new DeliveryNetworkError("offline");
      await reportDeliveryFailure(supabase, { orderId: target.id, reason });
      markLocally(target.id, {
        workflow: "TO_COLLECT",
        failedAt: new Date().toISOString(),
        failedReason: reason,
        attempts: target.attempts + 1,
      });
      setNotice(`${target.ref} : non livrée, le magasin est prévenu.`);
      setFail(null);
      void refresh();
    } catch (e) {
      if (isNetworkError(e)) {
        try {
          await enqueue({ kind: "fail", orderId: target.id, ref: target.ref, reason });
          setNotice(`${target.ref} : signalement gardé sur le téléphone, envoyé au magasin dès le retour du réseau.`);
          setFail(null);
        } catch (qe) {
          setModalError(qe instanceof Error ? qe.message : String(qe));
        }
      } else {
        setModalError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  if (!ready || !profile || profile.role !== "LIVREUR") {
    return <div className="lp-page"><p className="lp-loading">Chargement…</p></div>;
  }

  if (disabled || !livreurId) {
    return (
      <div className="lp-page">
        <div className="lp-disabled">
          <span className="lp-brand"><Truck className="h-5 w-5" /></span>
          <p className="lp-title">{livreurId ? "Accès livreur désactivé" : "Compte livreur non relié"}</p>
          <p className="lp-sub">
            {livreurId
              ? "Votre magasin a désactivé votre accès à la tournée. Contactez-le si c'est une erreur."
              : "Ce compte n'est relié à aucun livreur. Demandez à votre magasin de recréer votre accès."}
          </p>
          <button type="button" className="od-btn od-btn--ghost" onClick={signOut}>
            <LogOut className="h-4 w-4" /> Se déconnecter
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="lp-page">
      <header className="lp-header">
        <span className="lp-brand"><Truck className="h-5 w-5" /></span>
        <div className="lp-header-text">
          <p className="lp-title">Ma tournée</p>
          <p className="lp-sub">
            {profile.display_name} · {dayLabel}
            {syncedAt ? ` · à jour ${fmtTime(syncedAt)}` : ""}
          </p>
        </div>
        <NotificationBell compact />
        <button type="button" className="lp-iconbtn" onClick={() => void refresh()} aria-label="Actualiser" disabled={loading || !online}>
          {loading ? <Loader2 className="h-5 w-5 nc-spin" /> : <RefreshCw className="h-5 w-5" />}
        </button>
        <button type="button" className="lp-iconbtn" aria-label="Changer mon mot de passe" title="Changer mon mot de passe" onClick={() => setPwdOpen(true)}>
          <KeyRound className="h-5 w-5" />
        </button>
        <button type="button" className="lp-iconbtn" aria-label="Se déconnecter" onClick={signOut}>
          <LogOut className="h-5 w-5" />
        </button>
      </header>

      {!online && (
        <div className="lp-offline">
          <CloudOff className="h-4 w-4" />
          Hors connexion{syncedAt ? ` — tournée de ${fmtTime(syncedAt)}` : ""}. Vos confirmations sont gardées et partent dès le retour du réseau.
        </div>
      )}
      {online && outbox.length > 0 && (
        <div className="lp-offline lp-offline--sync">
          <Loader2 className="h-4 w-4 nc-spin" />
          {plural(outbox.length, "confirmation")} en attente d&apos;envoi…
        </div>
      )}
      {error && <div className="nc-error lp-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} />
      <ChangePasswordDialog open={pwdOpen} onClose={() => setPwdOpen(false)} onDone={setNotice} />

      <div className="lpt-tabs lpt-tabs--3" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "tournee"}
          className={`lpt-tab${tab === "tournee" ? " lpt-tab--on" : ""}`}
          onClick={() => setTab("tournee")}
        >
          <Warehouse className="h-5 w-5" />
          Tournée
          {pickupsLeft > 0 && <span className="lp-count">{pickupsLeft}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "livraisons"}
          className={`lpt-tab${tab === "livraisons" ? " lpt-tab--on" : ""}`}
          onClick={() => setTab("livraisons")}
        >
          <Truck className="h-5 w-5" />
          Livraisons
          {toDeliver.length > 0 && <span className="lp-count">{toDeliver.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "retours"}
          className={`lpt-tab${tab === "retours" ? " lpt-tab--on" : ""}`}
          onClick={() => setTab("retours")}
        >
          <RotateCcw className="h-5 w-5" />
          Retours
          {returnsLeft > 0 && <span className="lp-count">{returnsLeft}</span>}
        </button>
      </div>

      {tab === "tournee" && (
        <main className="lp-main">
          <TourTab
            board={shownPickups}
            day={pickupDay}
            today={pickupToday}
            tomorrow={pickupTomorrow}
            onDay={setPickupDay}
            loading={pickupsLoading}
            error={pickupsError}
            livreurId={livreurId}
            queuedLines={queuedLines}
            queuedTours={queuedTours}
            onPickup={(l, s) => void pickupPart(l, s)}
            onTourStatus={(t, s, left) => void changeTourStatus(t, s, left)}
            onDefer={(l, next) => void deferPart(l, next)}
            deferring={deferring}
            online={online}
          />
        </main>
      )}

      {tab === "retours" && (
        <main className="lp-main">
          <ReturnsTab
            board={shownPickups}
            day={pickupDay}
            today={pickupToday}
            tomorrow={pickupTomorrow}
            onDay={setPickupDay}
            loading={pickupsLoading}
            error={pickupsError}
            queued={queuedReturns}
            onComplete={(r, done) => void completeReturn(r, done)}
          />
        </main>
      )}

      <main className="lp-main" hidden={tab !== "livraisons"}>
        <p className="lp-section">
          À livrer <span className="lp-count">{toDeliver.length}</span>
        </p>

        {loading && syncedAt === null && <p className="lp-loading">Chargement des livraisons…</p>}

        {!loading && syncedAt === null && (
          <div className="lp-empty lp-empty--offline">
            <CloudOff className="h-8 w-8" />
            <p>Tournée pas encore chargée : elle s&apos;affichera dès que le téléphone aura du réseau.</p>
          </div>
        )}

        {syncedAt !== null && toDeliver.length === 0 && (
          <div className="lp-empty">
            <CheckCircle2 className="h-8 w-8" />
            <p>Aucune livraison en attente. 👍</p>
          </div>
        )}

        {toDeliver.map((s, idx) => {
          const link = mapsLink(s.address, s.city);
          const outcome = queued.get(s.id);
          return (
            <article key={s.id} className={`lp-card${outcome ? " lp-card--queued" : ""}`}>
              <div className="lp-card-head">
                <span className="lp-stop">{idx + 1}</span>
                <div>
                  <p className="lp-client">
                    {s.client}
                    {s.isGarage && <span className="lp-tag">Garage</span>}
                  </p>
                  <p className="lp-meta">
                    {s.ref}
                    {s.dateEnvoi ? ` · créneau ${fmtTime(s.dateEnvoi)}` : ""}
                    {s.attempts > 0 ? ` · ${s.attempts + 1}ᵉ passage` : ""}
                  </p>
                </div>
              </div>
              {s.failedReason && s.attempts > 0 && (
                <p className="lp-warn"><AlertTriangle className="h-4 w-4" /> Dernier passage : {s.failedReason}</p>
              )}
              <div className="lp-address">
                <MapPin className="h-4 w-4" />
                <span>
                  {s.address ? <strong>{s.address}</strong> : <em>Adresse non renseignée : appelez le client</em>}
                  {s.city ? <> · {s.city}</> : null}
                </span>
              </div>
              {s.note && <p className="lp-note">📝 {s.note}</p>}
              <div className="lp-contact">
                {s.phone && (
                  <a href={`tel:${s.phone.replace(/\s/g, "")}`} className="lp-call">
                    <Phone className="h-4 w-4" />
                    Appeler
                  </a>
                )}
                {link && (
                  <a href={link} target="_blank" rel="noreferrer" className="lp-call lp-call--nav">
                    <Navigation className="h-4 w-4" />
                    Itinéraire
                  </a>
                )}
              </div>
              <div className="lp-pieces">
                <p className="lp-pieces-title">
                  <Package className="h-4 w-4" />
                  {pieceCount(s)} pièce(s)
                </p>
                {s.pieces.map((p, i) => (
                  <p key={i} className={`lp-piece${p.pending ? " lp-piece--pending" : ""}`}>
                    <strong>×{p.quantity}</strong> {p.name} {p.reference && <span>({p.reference})</span>}
                    {p.pending && <em className="lp-piece-tag">pas encore reçue</em>}
                  </p>
                ))}
              </div>
              {outcome ? (
                <p className="lp-queued">
                  <CloudOff className="h-4 w-4" />
                  {outcome === "deliver" ? "Livrée" : "Non livrée"} — le magasin sera prévenu dès le retour du réseau
                </p>
              ) : (
                <div className="lp-actions">
                  <button type="button" className="lp-fail" disabled={busy} onClick={() => openFail(s)}>
                    <X className="h-5 w-5" /> Non livrée
                  </button>
                  <button type="button" className="lp-deliver" disabled={busy} onClick={() => openDeliver(s)}>
                    <Check className="h-5 w-5" /> Livrée
                  </button>
                </div>
              )}
            </article>
          );
        })}

        {failedToday.length > 0 && (
          <>
            <p className="lp-section lp-section--failed">
              Non livrées aujourd&apos;hui <span className="lp-count lp-count--failed">{failedToday.length}</span>
            </p>
            {failedToday.map((s) => (
              <article key={s.id} className="lp-card lp-card--done lp-card--failed">
                <AlertTriangle className="h-5 w-5" />
                <div>
                  <p className="lp-client">{s.client}</p>
                  <p className="lp-meta">{s.ref} · {fmtTime(s.failedAt)} · {s.failedReason ?? "Non livrée"}</p>
                </div>
              </article>
            ))}
          </>
        )}

        {deliveredToday.length > 0 && (
          <>
            <p className="lp-section lp-section--done">
              Livrées aujourd&apos;hui <span className="lp-count lp-count--done">{deliveredToday.length}</span>
            </p>
            {deliveredToday.map((s) => (
              <article key={s.id} className="lp-card lp-card--done">
                <CheckCircle2 className="h-5 w-5" />
                <div>
                  <p className="lp-client">{s.client}</p>
                  <p className="lp-meta">{s.ref} · {fmtTime(s.deliveredAt)} · {pieceCount(s)} pièce(s)</p>
                </div>
              </article>
            ))}
          </>
        )}
      </main>

      {deliver && (
        <div className="ga-modal-overlay" onClick={() => !busy && closeDeliver()}>
          <div className="ga-modal lp-modal" role="dialog" aria-modal="true" aria-labelledby="deliver-title" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title" id="deliver-title"><Check className="h-4 w-4" /> Livrée — {deliver.client}</span>
              <button type="button" className="ga-modal-close" onClick={closeDeliver} aria-label="Fermer" disabled={busy}><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              {modalError && <div className="nc-error">{modalError}</div>}
              <div className="od-field">
                <span className="od-label">Remis à (nom)</span>
                <input className="od-input" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="M. Martin, réception…" />
              </div>
              <div className="od-field">
                <span className="od-label">Photo (preuve de livraison)</span>
                {photo && photoUrl ? (
                  <div className="lp-photo-row">
                    {/* eslint-disable-next-line @next/next/no-img-element -- blob: preview of the camera photo, next/image cannot load it */}
                    <img src={photoUrl} alt="Photo de la livraison" className="lp-photo-preview" />
                    <label className="lp-photo lp-photo--small">
                      <Camera className="h-4 w-4" />
                      Reprendre
                      <input type="file" accept="image/*" capture="environment" hidden disabled={busy} onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)} />
                    </label>
                    <button type="button" className="lp-photo lp-photo--small" onClick={() => pickPhoto(null)} disabled={busy}>
                      <Trash2 className="h-4 w-4" />
                      Retirer
                    </button>
                  </div>
                ) : (
                  <label className="lp-photo">
                    <Camera className="h-5 w-5" />
                    <span>Prendre une photo</span>
                    <input type="file" accept="image/*" capture="environment" hidden disabled={busy} onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)} />
                  </label>
                )}
              </div>
              <div className="od-field">
                <span className="od-label">Remarque</span>
                <input className="od-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Déposé au comptoir, colis ouvert…" />
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={closeDeliver} disabled={busy}>Annuler</button>
                <button type="button" className="od-btn od-btn--primary" onClick={() => void submitDeliver()} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />} Confirmer la livraison
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {fail && (
        <div className="ga-modal-overlay" onClick={() => !busy && setFail(null)}>
          <div className="ga-modal lp-modal" role="dialog" aria-modal="true" aria-labelledby="fail-title" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title" id="fail-title"><AlertTriangle className="h-4 w-4" /> Non livrée — {fail.client}</span>
              <button type="button" className="ga-modal-close" onClick={() => setFail(null)} aria-label="Fermer" disabled={busy}><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              {modalError && <div className="nc-error">{modalError}</div>}
              <div className="od-field">
                <span className="od-label">Motif</span>
                <div className="lp-reasons" role="radiogroup">
                  {DELIVERY_FAILURE_REASONS.map((r) => (
                    <button key={r} type="button" role="radio" aria-checked={failReason === r} className={`nc-chip${failReason === r ? " nc-chip--on" : ""}`} onClick={() => setFailReason(r)}>{r}</button>
                  ))}
                </div>
              </div>
              <div className="od-field">
                <span className="od-label">{failReason === "Autre" ? "Précisez" : "Détail (facultatif)"}</span>
                <input className="od-input" value={failDetail} onChange={(e) => setFailDetail(e.target.value)} placeholder="Personne au garage à 15 h, rappelé…" />
              </div>
              <p className="st-cmd-hint">La commande revient dans « Commande à livrer » et le magasin reçoit une alerte.</p>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setFail(null)} disabled={busy}>Annuler</button>
                <button type="button" className="od-btn od-btn--primary" onClick={() => void submitFail()} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <AlertTriangle className="h-4 w-4" />} Signaler
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
