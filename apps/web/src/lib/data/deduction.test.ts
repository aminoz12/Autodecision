import { describe, expect, it } from "vitest";
import { deductionMessage } from "./saas";

const eur = (s: string) => s.replace(/ | /g, " ");

describe("deductionMessage", () => {
  it("says what was taken off the encours", () => {
    expect(eur(deductionMessage({ num: "AV-2026-00008", amount: 50, imputed: 50, remaining: 0 }))).toBe(
      "50,00 € déduits de l’encours (avoir AV-2026-00008).",
    );
  });

  it("says what stays on the credit note when the client owed less", () => {
    expect(eur(deductionMessage({ num: "AV-2026-00009", amount: 100, imputed: 30, remaining: 70 }))).toBe(
      "30,00 € déduits de l’encours ; 70,00 € restent en avoir AV-2026-00009.",
    );
  });

  it("keeps everything as a credit note when nothing was owed", () => {
    expect(eur(deductionMessage({ num: "AV-2026-00010", amount: 80, imputed: 0, remaining: 80 }))).toBe(
      "Le client ne devait plus rien : 80,00 € restent en avoir AV-2026-00010.",
    );
  });

  it("still answers when the credit note could not be read back", () => {
    expect(deductionMessage(null)).toBe("Retour déduit de l’encours.");
  });
});
