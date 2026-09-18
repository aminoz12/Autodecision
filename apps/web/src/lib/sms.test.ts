import { describe, expect, it } from "vitest";
import {
  SMS_DEFAULT_HORAIRES,
  buildClientSms,
  formatE164,
  renderSmsTemplate,
  smsSize,
  toE164,
  toGsm7,
} from "./sms";

const NO_SETTINGS = { magasin: "Espace Auto 92", horaires: null, readyTemplate: null, partialTemplate: null };

describe("toE164", () => {
  it("normalises French national numbers", () => {
    expect(toE164("06 12 34 56 78")).toBe("+33612345678");
    expect(toE164("06.12.34.56.78")).toBe("+33612345678");
    expect(toE164("0612345678")).toBe("+33612345678");
    expect(toE164("612345678")).toBe("+33612345678");
  });
  it("keeps international forms", () => {
    expect(toE164("+33 6 12 34 56 78")).toBe("+33612345678");
    expect(toE164("+33 (0)6 12 34 56 78")).toBe("+33612345678");
    expect(toE164("0033612345678")).toBe("+33612345678");
    expect(toE164("33612345678")).toBe("+33612345678");
    expect(toE164("+212612345678")).toBe("+212612345678");
  });
  it("uses the given default country code", () => {
    expect(toE164("0612345678", "212")).toBe("+212612345678");
  });
  it("rejects empty or implausible numbers", () => {
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164("3631")).toBeNull();
    expect(toE164("abc")).toBeNull();
    expect(toE164("+123456789012345678")).toBeNull();
  });
  it("formats French numbers for display", () => {
    expect(formatE164("+33612345678")).toBe("+33 6 12 34 56 78");
    expect(formatE164("+212612345678")).toBe("+212612345678");
  });
});

describe("renderSmsTemplate", () => {
  const vars = { client: "Jean Dupont", commande: "CO-2026-00042", horaires: "Lun-Sam 9h-18h30", magasin: "Espace Auto 92" };
  it("fills placeholders, case-insensitive and with spaces", () => {
    expect(renderSmsTemplate("{client} / {COMMANDE} / { horaires } / {magasin}", vars)).toBe(
      "Jean Dupont / CO-2026-00042 / Lun-Sam 9h-18h30 / Espace Auto 92",
    );
  });
  it("tidies the greeting when the client has no name", () => {
    expect(renderSmsTemplate("Bonjour {client}, vos pièces", { ...vars, client: "" })).toBe("Bonjour, vos pièces");
  });
  it("leaves unknown placeholders visible", () => {
    expect(renderSmsTemplate("Hello {nom}", vars)).toBe("Hello {nom}");
  });
  it("caps the length", () => {
    expect(renderSmsTemplate("x".repeat(1000), vars)).toHaveLength(640);
  });
});

describe("toGsm7", () => {
  it("keeps the accents GSM-7 has and drops the others", () => {
    expect(toGsm7("prête à être récupérée, bientôt, ça")).toBe("prete à etre récupérée, bientot, ca");
  });
  it("maps typographic punctuation and ligatures", () => {
    expect(toGsm7("l’œuvre « ici » — fin…")).toBe("l'oeuvre \"ici\" - fin...");
  });
  it("leaves what it cannot map", () => {
    expect(toGsm7("ok 👍")).toBe("ok 👍");
  });
});

describe("smsSize", () => {
  it("counts GSM-7 segments", () => {
    expect(smsSize("")).toEqual({ encoding: "GSM-7", chars: 0, segments: 0 });
    expect(smsSize("a".repeat(160)).segments).toBe(1);
    expect(smsSize("a".repeat(161)).segments).toBe(2);
    expect(smsSize("a".repeat(306)).segments).toBe(2);
    expect(smsSize("a".repeat(307)).segments).toBe(3);
  });
  it("escaped characters weigh two septets", () => {
    expect(smsSize("€").chars).toBe(2);
    expect(smsSize("a".repeat(159) + "€").segments).toBe(2);
  });
  it("switches to UCS-2 on a single foreign accent", () => {
    const s = smsSize("prête " + "a".repeat(65));
    expect(s.encoding).toBe("UCS-2");
    expect(s.segments).toBe(2);
  });
});

describe("buildClientSms", () => {
  it("builds the « commande prête » message in one SMS by default", () => {
    const { text, size } = buildClientSms("READY", { client: "Jean Dupont", commande: "CO-2026-00042" }, NO_SETTINGS);
    expect(text).toBe(
      "Bonjour Jean Dupont, votre commande CO-2026-00042 est prete à etre récupérée au magasin. " +
        `Horaires : ${SMS_DEFAULT_HORAIRES}. Merci et à très bientot !`,
    );
    expect(size.encoding).toBe("GSM-7");
    expect(size.segments).toBe(1);
  });
  it("uses the partial template for a reliquat", () => {
    const { text, size } = buildClientSms("PARTIAL", { client: "Jean Dupont", commande: "CO-2026-00042" }, NO_SETTINGS);
    expect(text).toContain("une partie de votre commande CO-2026-00042");
    expect(text).toContain("le reste suivra");
    expect(size.segments).toBe(1);
  });
  it("honours the magasin settings", () => {
    const { text } = buildClientSms(
      "READY",
      { client: "Jean Dupont", commande: "CO-2026-00042" },
      {
        magasin: "Espace Auto 92",
        horaires: "Lun-Ven 8h-19h",
        readyTemplate: "{magasin} : commande {commande} prête ({horaires}).",
        partialTemplate: null,
      },
    );
    expect(text).toBe("Espace Auto 92 : commande CO-2026-00042 prete (Lun-Ven 8h-19h).");
  });
  it("falls back to the default text when a template is blank", () => {
    const { text } = buildClientSms(
      "READY",
      { client: "", commande: "CO-1" },
      { ...NO_SETTINGS, readyTemplate: "   ", horaires: "" },
    );
    expect(text.startsWith("Bonjour, votre commande CO-1")).toBe(true);
    expect(text).toContain(SMS_DEFAULT_HORAIRES);
  });
});
