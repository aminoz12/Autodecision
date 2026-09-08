"use client";

/**
 * Last-resort boundary (errors thrown by the root layout itself). Renders its
 * own <html>/<body> because the app shell is unavailable here, so styles are
 * inline on purpose.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="fr">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#F6F8FA", color: "#1A1F36" }}>
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ maxWidth: 460, background: "#fff", border: "1px solid #E3E8EE", borderRadius: 12, padding: "28px 30px", textAlign: "center" }}>
            <h1 style={{ fontSize: 20, margin: "0 0 10px" }}>L&apos;application a rencontré un problème</h1>
            <p style={{ margin: "0 0 18px", color: "#3C4257", fontSize: 14, lineHeight: 1.5 }}>
              Rechargez la page. Si cela se reproduit, contactez le support en indiquant la référence ci-dessous.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{ background: "#635BFF", color: "#fff", border: 0, borderRadius: 6, padding: "10px 18px", fontWeight: 600, cursor: "pointer" }}
            >
              Recharger
            </button>
            {error.digest && <p style={{ marginTop: 14, fontSize: 12, color: "#697386" }}>Référence : {error.digest}</p>}
          </div>
        </div>
      </body>
    </html>
  );
}
