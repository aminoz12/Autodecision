"use client";

import { BellOff, Loader2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";

/**
 * « STOP » — the way out carried by every non-essential message (relance
 * d'entretien, avoir, satisfaction). RGPD: one tap, no login. The messages
 * about an order in progress (pièce arrivée, retard) are not prospecting and
 * keep coming. Public page, keyed by the client's token (/api/public/stop).
 */
export default function StopPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const [state, setState] = useState<"ask" | "done" | "back">("ask");
  const [magasin, setMagasin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (resubscribe: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/public/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, resubscribe }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Lien invalide.");
      setMagasin(typeof body.magasin === "string" ? body.magasin : null);
      setState(resubscribe ? "back" : "done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="sav-public">
      <div className="sav-public-card">
        {magasin && <p className="sav-public-shop">{magasin}</p>}
        {state === "ask" && (
          <>
            <h1 className="sav-public-title">Ne plus recevoir nos rappels ?</h1>
            <p className="sav-public-text">
              Vous ne recevrez plus de rappels d&apos;entretien ni de messages d&apos;information. Les messages liés à une commande en cours
              (pièce arrivée, retard) continueront de vous parvenir.
            </p>
            <button type="button" className="sav-public-btn sav-public-btn--primary" disabled={busy} onClick={() => void send(false)}>
              {busy ? <Loader2 className="h-5 w-5 nc-spin" /> : <BellOff className="h-5 w-5" />} Me désinscrire
            </button>
          </>
        )}
        {state === "done" && (
          <>
            <h1 className="sav-public-title">C&apos;est fait.</h1>
            <p className="sav-public-text">Vous ne recevrez plus nos rappels. Une erreur ?</p>
            <button type="button" className="sav-public-btn" style={{ width: "100%" }} disabled={busy} onClick={() => void send(true)}>
              Me réinscrire
            </button>
          </>
        )}
        {state === "back" && (
          <>
            <h1 className="sav-public-title">Vous êtes réinscrit.</h1>
            <p className="sav-public-text">Pour recevoir à nouveau les rappels d&apos;entretien, donnez votre accord au comptoir lors de votre prochaine visite.</p>
          </>
        )}
        {error && <p className="sav-public-text" style={{ color: "var(--clr-danger-text)", marginTop: 12 }}>{error}</p>}
      </div>
    </main>
  );
}
