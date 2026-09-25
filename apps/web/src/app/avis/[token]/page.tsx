"use client";

import { Loader2, Star, ThumbsDown, ThumbsUp } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * « La pièce vous convient ? » — the page behind the link of the satisfaction
 * SMS sent three days after the pickup. Two buttons:
 *   Oui → thank you + the magasin's Google review link, at the exact moment
 *         the client is happy;
 *   Non → a free comment, and an immediate alert at the counter, before a
 *         negative review writes itself.
 * Public page: the token in the URL is the only key (see /api/public/avis).
 */
type Context = { magasin: string; answer: "OUI" | "NON" | null; review_url: string | null };

export default function AvisPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const [ctx, setCtx] = useState<Context | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [commentSent, setCommentSent] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/public/avis?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) setError(body.error ?? "Lien invalide.");
        else setCtx(body as Context);
      })
      .catch(() => alive && setError("Connexion impossible. Réessayez dans un instant."));
    return () => {
      alive = false;
    };
  }, [token]);

  const answer = async (value: "OUI" | "NON", withComment?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/public/avis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, answer: value, comment: withComment }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Envoi impossible.");
      setCtx(body as Context);
      if (withComment) setCommentSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="sav-public">
      <div className="sav-public-card">
        {ctx && <p className="sav-public-shop">{ctx.magasin}</p>}
        {error && !ctx && (
          <>
            <h1 className="sav-public-title">Lien indisponible</h1>
            <p className="sav-public-text">{error}</p>
          </>
        )}
        {!ctx && !error && <Loader2 className="h-6 w-6 nc-spin" />}

        {ctx && ctx.answer === null && (
          <>
            <h1 className="sav-public-title">La pièce vous convient ?</h1>
            <p className="sav-public-text">Un clic suffit. Votre réponse arrive directement au magasin.</p>
            <div className="sav-public-choices">
              <button type="button" className="sav-public-btn sav-public-btn--yes" disabled={busy} onClick={() => void answer("OUI")}>
                <ThumbsUp className="h-7 w-7" /> Oui
              </button>
              <button type="button" className="sav-public-btn sav-public-btn--no" disabled={busy} onClick={() => void answer("NON")}>
                <ThumbsDown className="h-7 w-7" /> Non
              </button>
            </div>
          </>
        )}

        {ctx && ctx.answer === "OUI" && (
          <>
            <h1 className="sav-public-title">Merci !</h1>
            <p className="sav-public-text">
              {ctx.review_url
                ? "Si vous avez une minute, un avis Google aide beaucoup un commerce de quartier."
                : "Votre réponse a bien été transmise au magasin. À bientôt !"}
            </p>
            {ctx.review_url && (
              <a className="sav-public-btn sav-public-btn--primary" href={ctx.review_url} target="_blank" rel="noreferrer">
                <Star className="h-5 w-5" /> Laisser un avis Google
              </a>
            )}
          </>
        )}

        {ctx && ctx.answer === "NON" && (
          <>
            <h1 className="sav-public-title">{commentSent ? "C'est noté." : "Désolés de l'apprendre."}</h1>
            <p className="sav-public-text">
              {commentSent
                ? "Le magasin a été prévenu et va vous rappeler."
                : "Le magasin vient d'être prévenu. Dites-nous ce qui ne va pas, on vous rappelle."}
            </p>
            {!commentSent && (
              <>
                <textarea
                  className="sav-public-area"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Mauvaise référence, pièce abîmée, problème au montage…"
                  maxLength={1000}
                />
                <button
                  type="button"
                  className="sav-public-btn sav-public-btn--primary"
                  disabled={busy || !comment.trim()}
                  onClick={() => void answer("NON", comment.trim())}
                >
                  {busy ? <Loader2 className="h-5 w-5 nc-spin" /> : null} Envoyer au magasin
                </button>
              </>
            )}
          </>
        )}
        {error && ctx && <p className="sav-public-text" style={{ color: "var(--clr-danger-text)", marginTop: 12 }}>{error}</p>}
      </div>
    </main>
  );
}
