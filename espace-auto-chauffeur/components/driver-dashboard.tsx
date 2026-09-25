"use client";

import {
  Building2,
  Check,
  ChevronDown,
  Clock3,
  PackageCheck,
  RotateCcw,
  ShoppingBag,
  Store,
  Truck,
  UserRound,
  Warehouse,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { initialReturns, initialTours } from "@/data/dashboard";
import type { PieceKind, PieceStatus, ReturnItem, Tour } from "@/types/dashboard";

const STORAGE_KEY = "espace-auto-92-driver-dashboard-v1";

const colorMap = {
  violet: { header: "bg-[#5b46ff]", soft: "bg-[#efedff] text-[#4935e8]" },
  pink: { header: "bg-[#e94d85]", soft: "bg-[#fff0f5] text-[#c53067]" },
  green: { header: "bg-[#19a974]", soft: "bg-[#eafaf4] text-[#0d875b]" },
  orange: { header: "bg-[#f28a2e]", soft: "bg-[#fff4e8] text-[#c56716]" },
} as const;

const kindConfig: Record<PieceKind, { label: string; className: string; icon: typeof Wrench }> = {
  garage: { label: "GARAGE", className: "bg-[#e8f8f1] text-[#0e8b62]", icon: Wrench },
  counter: { label: "COMPTOIR", className: "bg-[#f3edff] text-[#7950d4]", icon: UserRound },
  stock: { label: "STOCK", className: "bg-[#fff3d8] text-[#ad6a00]", icon: Warehouse },
};

function countPieces(tour: Tour) {
  return tour.suppliers.reduce((sum, supplier) => sum + supplier.pieces.length, 0);
}

function countPicked(tour: Tour) {
  return tour.suppliers.reduce(
    (sum, supplier) => sum + supplier.pieces.filter((piece) => piece.status === "picked" || piece.status === "received").length,
    0,
  );
}

function statusLabel(status: PieceStatus) {
  if (status === "picked") return "Récupérée";
  if (status === "unavailable") return "Indisponible";
  if (status === "received") return "Reçue magasin";
  return "À récupérer";
}

function StatusButton({ status, onClick }: { status: PieceStatus; onClick: () => void }) {
  const base = "grid h-10 w-10 shrink-0 place-items-center rounded-xl border-2 transition active:scale-95";
  if (status === "picked") {
    return <button type="button" aria-label="Marquer indisponible" onClick={onClick} className={`${base} border-[#16a36f] bg-[#16a36f] text-white`}><Check size={20} strokeWidth={3} /></button>;
  }
  if (status === "unavailable") {
    return <button type="button" aria-label="Remettre à récupérer" onClick={onClick} className={`${base} border-[#f5a8b5] bg-[#fff0f2] text-[#dd3152]`}><X size={20} strokeWidth={3} /></button>;
  }
  if (status === "received") {
    return <button type="button" aria-label="Pièce reçue au magasin" onClick={onClick} className={`${base} border-[#9dd7f2] bg-[#e8f7ff] text-[#1785b7]`}><Store size={19} strokeWidth={2.5} /></button>;
  }
  return <button type="button" aria-label="Marquer récupérée" onClick={onClick} className={`${base} border-[#d8dbe6] bg-white`} />;
}

function SummaryMetric({ kind }: { kind: PieceKind }) {
  const config = kindConfig[kind];
  const Icon = config.icon;
  const subtitles = { garage: "Caisse garage", counter: "Caisse comptoir", stock: "Caisse stock" };
  return (
    <div className={`rounded-2xl border p-2.5 ${config.className}`}>
      <div className="flex items-center gap-1 text-[10px] font-black tracking-wide"><Icon size={13} />{config.label}</div>
      <div className="mt-1 truncate text-[11px] font-bold opacity-80">{subtitles[kind]}</div>
    </div>
  );
}

export function DriverDashboard() {
  const [activeTab, setActiveTab] = useState<"tour" | "returns">("tour");
  const [tours, setTours] = useState<Tour[]>(initialTours);
  const [returns, setReturns] = useState<ReturnItem[]>(initialReturns);
  const [toast, setToast] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { tours?: Tour[]; returns?: ReturnItem[] };
        if (parsed.tours) setTours(parsed.tours);
        if (parsed.returns) setReturns(parsed.returns);
      }
    } catch {
      // Ignore malformed or unavailable local storage.
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tours, returns }));
  }, [hydrated, tours, returns]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const currentTour = tours[0];
  const nextTours = tours.slice(1);
  const total = countPieces(currentTour);
  const picked = countPicked(currentTour);
  const percent = total === 0 ? 0 : Math.round((picked / total) * 100);
  const pendingReturns = returns.filter((item) => !item.completedAt).length;

  const dayLabel = useMemo(() => {
    return new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "2-digit", month: "long" }).format(new Date());
  }, []);

  const cyclePiece = (supplierId: string, pieceId: string) => {
    const order: PieceStatus[] = ["pending", "picked", "unavailable"];
    setTours((previous) => previous.map((tour, tourIndex) => {
      if (tourIndex !== 0) return tour;
      return {
        ...tour,
        suppliers: tour.suppliers.map((supplier) => supplier.id !== supplierId ? supplier : {
          ...supplier,
          pieces: supplier.pieces.map((piece) => {
            if (piece.id !== pieceId || piece.status === "received") return piece;
            const next = order[(order.indexOf(piece.status) + 1) % order.length];
            return { ...piece, status: next };
          }),
        }),
      };
    }));
  };

  const deferPiece = (supplierId: string, pieceId: string) => {
    const supplier = currentTour.suppliers.find((item) => item.id === supplierId);
    const piece = supplier?.pieces.find((item) => item.id === pieceId);
    if (!supplier || !piece) return;

    setTours((previous) => previous.map((tour, tourIndex) => {
      if (tourIndex === 0) {
        return { ...tour, suppliers: tour.suppliers.map((item) => item.id !== supplierId ? item : { ...item, pieces: item.pieces.filter((p) => p.id !== pieceId) }) };
      }
      if (tourIndex === 1) {
        const existing = tour.suppliers.find((item) => item.name === supplier.name);
        if (existing) {
          return { ...tour, suppliers: tour.suppliers.map((item) => item.id !== existing.id ? item : { ...item, pieces: [...item.pieces, { ...piece, id: `${piece.id}-deferred`, canDefer: false, status: "pending" }] }) };
        }
        return { ...tour, suppliers: [...tour.suppliers, { ...supplier, id: `${supplier.id}-13`, pieces: [{ ...piece, id: `${piece.id}-deferred`, canDefer: false, status: "pending" }] }] };
      }
      return tour;
    }));
    setToast(`${piece.reference} reportée à 13H00`);
  };

  const completeReturn = (id: string) => {
    const completedAt = new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(new Date());
    setReturns((previous) => previous.map((item) => item.id === id ? { ...item, completedAt } : item));
    setToast("Retour enregistré avec succès");
  };

  const resetDemo = () => {
    setTours(initialTours);
    setReturns(initialReturns);
    window.localStorage.removeItem(STORAGE_KEY);
    setToast("Données réinitialisées");
  };

  return (
    <div className="mx-auto w-full max-w-md pb-20">
      <header className="overflow-hidden rounded-[24px] border border-[#e6e8f0] bg-white shadow-card">
        <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[#5b46ff] text-white shadow-float"><Truck size={23} /></div>
            <div className="min-w-0">
              <h1 className="truncate text-[18px] font-black leading-tight">Ma tournée</h1>
              <p className="mt-0.5 truncate text-[12px] font-semibold capitalize text-[#737b91]">MOHA · {dayLabel}</p>
            </div>
          </div>
          <div className="rounded-2xl bg-[#efedff] px-3 py-2 text-right text-[#4935e8]">
            <div className="text-[18px] font-black leading-none">{currentTour.time}</div>
            <div className="mt-1 text-[9px] font-black tracking-[.16em]">EN COURS</div>
          </div>
        </div>

        <nav className="grid grid-cols-2 gap-2 px-3 pb-3" aria-label="Navigation principale">
          <button type="button" onClick={() => setActiveTab("tour")} className={`flex min-h-12 items-center justify-center gap-2 rounded-2xl text-[14px] font-black transition ${activeTab === "tour" ? "bg-[#5b46ff] text-white shadow-float" : "border border-[#e6e8f0] bg-[#f7f8fb]"}`}>
            <Truck size={18} /> Tournée
          </button>
          <button type="button" onClick={() => setActiveTab("returns")} className={`flex min-h-12 items-center justify-center gap-2 rounded-2xl text-[14px] font-black transition ${activeTab === "returns" ? "bg-[#5b46ff] text-white shadow-float" : "border border-[#e6e8f0] bg-[#f7f8fb]"}`}>
            <RotateCcw size={18} /> Retours
            <span className={`rounded-full px-2 py-0.5 text-[10px] ${activeTab === "returns" ? "bg-white/20" : "bg-white"}`}>{pendingReturns}</span>
          </button>
        </nav>
      </header>

      {activeTab === "tour" ? (
        <div className="mt-3 space-y-3">
          <section className="overflow-hidden rounded-[24px] bg-gradient-to-br from-[#3020b8] via-[#5b46ff] to-[#8b78ff] text-white shadow-float">
            <div className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-black tracking-[.2em] text-white/70">TOURNÉE {currentTour.number}</p>
                  <div className="mt-1 text-[30px] font-black leading-none">{currentTour.time}</div>
                  <p className="mt-2 text-[12px] font-bold text-white/80">{currentTour.suppliers.length} fournisseurs · {total} pièces</p>
                </div>
                <div className="rounded-2xl bg-white/12 px-3 py-2 text-right backdrop-blur-sm">
                  <div className="text-[23px] font-black leading-none">{picked}/{total}</div>
                  <div className="mt-1 text-[9px] font-black tracking-wide text-white/70">RÉCUPÉRÉES</div>
                </div>
              </div>
              <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-white/20"><div className="h-full rounded-full bg-white transition-all duration-300" style={{ width: `${percent}%` }} /></div>
            </div>
            <div className="grid grid-cols-4 gap-px bg-white/15">
              {currentTour.suppliers.map((supplier) => (
                <div key={supplier.id} className="bg-black/10 px-1 py-2.5 text-center">
                  <div className="truncate text-[9px] font-bold text-white/65">{supplier.shortName}</div>
                  <div className="mt-0.5 text-[16px] font-black">{supplier.pieces.filter((piece) => piece.status === "pending" || piece.status === "unavailable").length}</div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-end justify-between px-1">
              <div><h2 className="text-[14px] font-black">Prochaines tournées</h2><p className="mt-0.5 text-[10px] font-semibold text-[#8a91a5]">Mise à jour automatique</p></div>
              <Clock3 size={17} className="text-[#8a91a5]" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              {nextTours.map((tour) => {
                const colors = colorMap[tour.color];
                return (
                  <div key={tour.id} className="overflow-hidden rounded-2xl border border-[#e6e8f0] bg-white shadow-card">
                    <div className={`${colors.header} py-2 text-center text-[12px] font-black text-white`}>{tour.time}</div>
                    <div className="p-2 text-center"><div className="text-[20px] font-black">{countPieces(tour)}</div><div className="text-[9px] font-semibold text-[#8a91a5]">pièces</div><div className="mt-1 truncate text-[9px] font-black">{tour.suppliers.length} fournisseurs</div></div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="grid grid-cols-3 gap-2"><SummaryMetric kind="garage" /><SummaryMetric kind="counter" /><SummaryMetric kind="stock" /></section>

          <section className="space-y-2">
            {currentTour.suppliers.map((supplier, supplierIndex) => {
              const pending = supplier.pieces.filter((piece) => piece.status === "pending" || piece.status === "unavailable").length;
              return (
                <details key={supplier.id} open={supplierIndex === 0} className="group overflow-hidden rounded-[20px] border border-[#e4e6ef] bg-white shadow-card">
                  <summary className="flex min-h-[62px] cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-2xl text-[10px] font-black ${supplierIndex === 0 ? "bg-[#5b46ff] text-white" : "bg-[#f0f1f6] text-[#464e63]"}`}>{supplier.shortName}</div>
                      <div className="min-w-0"><h3 className="truncate text-[15px] font-black">{supplier.name}</h3><p className="mt-0.5 text-[11px] font-semibold text-[#7b8296]"><strong className={pending ? "text-[#d37a00]" : "text-[#159166]"}>{pending}</strong> à récupérer · {supplier.pieces.length} réf.</p></div>
                    </div>
                    <ChevronDown size={20} className="shrink-0 text-[#8a91a5] transition group-open:rotate-180" />
                  </summary>
                  <div className="divide-y divide-[#eceef4] border-t border-[#eceef4]">
                    {supplier.pieces.map((piece) => {
                      const kind = piece.kind ? kindConfig[piece.kind] : null;
                      const KindIcon = kind?.icon;
                      return (
                        <article key={piece.id} className={`flex gap-3 px-3 py-3 ${piece.status === "received" ? "bg-[#f8fbfd] opacity-65" : ""}`}>
                          <StatusButton status={piece.status} onClick={() => cyclePiece(supplier.id, piece.id)} />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <strong className={`text-[14px] ${piece.status === "received" ? "line-through" : ""}`}>{piece.reference}{piece.quantity ? ` ×${piece.quantity}` : ""}</strong>
                              {kind && KindIcon && <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[9px] font-black ${kind.className}`}><KindIcon size={11} />{kind.label}</span>}
                            </div>
                            {piece.label && <p className="mt-1 text-[12px] font-bold">{piece.label}</p>}
                            <p className="mt-0.5 truncate text-[11px] font-medium text-[#7b8296]">{piece.detail || statusLabel(piece.status)}</p>
                            {piece.canDefer && piece.status !== "received" && (
                              <button type="button" onClick={() => deferPiece(supplier.id, piece.id)} className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-[#efbd5c] bg-[#fff7df] px-3 text-[11px] font-black text-[#9b6200]"><Clock3 size={14} /> Reporter à 13H00</button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </details>
              );
            })}
          </section>
        </div>
      ) : (
        <ReturnsView items={returns} onComplete={completeReturn} />
      )}

      <button type="button" onClick={resetDemo} className="mx-auto mt-5 flex items-center gap-2 rounded-xl px-3 py-2 text-[11px] font-bold text-[#8a91a5]"><RotateCcw size={14} /> Réinitialiser la démonstration</button>

      {toast && <div role="status" className="toast-in fixed bottom-5 left-1/2 z-50 flex w-[calc(100%-32px)] max-w-sm -translate-x-1/2 items-center gap-2 rounded-2xl bg-[#172033] px-4 py-3 text-[13px] font-bold text-white shadow-2xl"><Check size={17} className="text-[#65e6b5]" />{toast}</div>}
    </div>
  );
}

function ReturnsView({ items, onComplete }: { items: ReturnItem[]; onComplete: (id: string) => void }) {
  const garageItems = items.filter((item) => item.direction === "garage-to-store");
  const supplierItems = items.filter((item) => item.direction === "store-to-supplier");
  const countPending = (list: ReturnItem[]) => list.filter((item) => !item.completedAt).length;

  return (
    <div className="mt-3 space-y-3">
      <section className="grid grid-cols-2 gap-2">
        <div className="rounded-[22px] border-2 border-[#3bc594] bg-[#eafaf4] p-3.5"><div className="flex items-center gap-2 text-[#0b8a60]"><Wrench size={20} /><span className="text-[16px]">→</span><Store size={20} /></div><p className="mt-3 text-[10px] font-black tracking-wide text-[#0b8a60]">GARAGE → MAGASIN</p><div className="mt-1 text-[32px] font-black leading-none">{countPending(garageItems)}</div><p className="mt-1 text-[10px] font-semibold text-[#5f7e72]">à récupérer</p></div>
        <div className="rounded-[22px] border-2 border-[#a779ee] bg-[#f4edff] p-3.5"><div className="flex items-center gap-2 text-[#7745c8]"><Store size={20} /><span className="text-[16px]">→</span><Building2 size={20} /></div><p className="mt-3 text-[10px] font-black tracking-wide text-[#7745c8]">MAGASIN → FOURN.</p><div className="mt-1 text-[32px] font-black leading-none">{countPending(supplierItems)}</div><p className="mt-1 text-[10px] font-semibold text-[#786b89]">à déposer</p></div>
      </section>

      <ReturnSection title="GARAGE → MAGASIN" icon={Wrench} className="border-[#3bc594]" headerClassName="bg-[#eafaf4] text-[#0b8a60]" buttonClassName="bg-[#17a875]" items={garageItems} action="RÉCUPÉRER" completed="Récupérée" onComplete={onComplete} />
      <ReturnSection title="MAGASIN → FOURNISSEUR" icon={PackageCheck} className="border-[#a779ee]" headerClassName="bg-[#f4edff] text-[#7745c8]" buttonClassName="bg-[#8054d9]" items={supplierItems} action="DÉPOSÉ" completed="Déposée" onComplete={onComplete} />
    </div>
  );
}

function ReturnSection({ title, icon: Icon, className, headerClassName, buttonClassName, items, action, completed, onComplete }: {
  title: string;
  icon: typeof ShoppingBag;
  className: string;
  headerClassName: string;
  buttonClassName: string;
  items: ReturnItem[];
  action: string;
  completed: string;
  onComplete: (id: string) => void;
}) {
  return (
    <section className={`overflow-hidden rounded-[22px] border-2 bg-white shadow-card ${className}`}>
      <div className={`flex items-center gap-2 px-3.5 py-3 text-[12px] font-black ${headerClassName}`}><Icon size={17} />{title}</div>
      <div className="divide-y divide-[#eceef4]">
        {items.map((item) => (
          <article key={item.id} className="p-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0"><h3 className="text-[13px] font-black">{item.reference} · {item.label}</h3><p className="mt-1 truncate text-[11px] font-semibold text-[#7b8296]">{item.direction === "store-to-supplier" ? "→ " : ""}{item.destination}{item.slip ? ` · ${item.slip}` : ""}</p></div>
              {!item.completedAt && <span className={`shrink-0 rounded-full px-2 py-1 text-[8px] font-black ${headerClassName}`}>EN ATTENTE</span>}
            </div>
            {item.completedAt ? (
              <div className="mt-3 flex items-center gap-2 rounded-xl bg-[#eefaf5] px-3 py-2.5 text-[11px] font-bold text-[#0d865d]"><Check size={16} strokeWidth={3} />{completed} le {item.completedAt}</div>
            ) : (
              <button type="button" onClick={() => onComplete(item.id)} className={`mt-3 min-h-11 w-full rounded-xl text-[12px] font-black text-white shadow-sm transition active:scale-[.98] ${buttonClassName}`}>{action}</button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
