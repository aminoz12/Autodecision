import { describe, expect, it } from "vitest";
import { QUEUED_SMS_DEFAULTS, buildQueuedSms, isQueuedSmsKind, type QueuedSmsKind, type SmsSettings } from "@/lib/sms";
import { canSendNow, parisClock } from "@/lib/sms-queue";

const settings: SmsSettings & { templates?: Record<string, string> } = {
  magasin: "Espace Auto 92",
  horaires: null,
  readyTemplate: null,
  partialTemplate: null,
};

const links = { lien: "https://autodecision.netlify.app/avis/0123456789abcdef", stop: "https://autodecision.netlify.app/stop/0123456789abcdef" };

describe("messages après-vente", () => {
  it("fills every default template and stays in the GSM-7 alphabet", () => {
    const vars = { client: "M. Martin", commande: "REQ-2026-00412", date: "26/09", piece: "vos plaquettes de frein", montant: "120,00", vehicule: "Peugeot 308" };
    for (const kind of Object.keys(QUEUED_SMS_DEFAULTS) as QueuedSmsKind[]) {
      const { text, size } = buildQueuedSms(kind, vars, settings, links);
      expect(text, kind).not.toMatch(/\{[a-z]+\}/);
      expect(size.encoding, kind).toBe("GSM-7");
      expect(size.segments, kind).toBeLessThanOrEqual(2);
    }
  });

  it("keeps the messages that carry no link in one SMS", () => {
    const vars = { client: "M. Martin", commande: "REQ-2026-00412", date: "26/09", piece: "Alternateur", montant: "80,00" };
    for (const kind of ["DELAY", "DELAY_NODATE", "PICKUP_3", "PICKUP_7", "CONSIGNE_REMINDER"] as QueuedSmsKind[]) {
      expect(buildQueuedSms(kind, vars, settings).size.segments, kind).toBe(1);
    }
  });

  it("reuses the magasin's « commande prête » template for READY", () => {
    const { text } = buildQueuedSms("READY", { client: "Mme Durand", commande: "REQ-2026-00007" }, { ...settings, readyTemplate: "{client} : {commande} est la. {magasin}" });
    expect(text).toBe("Mme Durand : REQ-2026-00007 est la. Espace Auto 92");
  });

  it("lets the magasin override a text, and drops an empty vehicle cleanly", () => {
    const custom = buildQueuedSms("DELAY", { client: "Paul", commande: "C1", date: "02/10" }, { ...settings, templates: { DELAY: "{client}, retard : {date}." } });
    expect(custom.text).toBe("Paul, retard : 02/10.");
    const maintenance = buildQueuedSms("MAINTENANCE", { client: "Paul", piece: "votre batterie", vehicule: "" }, settings, links);
    expect(maintenance.text).toContain("faire controler votre batterie.");
    expect(maintenance.text).toContain("/stop/0123456789abcdef");
  });

  it("knows its kinds", () => {
    expect(isQueuedSmsKind("READY")).toBe(true);
    expect(isQueuedSmsKind("PICKUP_15")).toBe(true);
    expect(isQueuedSmsKind("PARTIAL")).toBe(false);
    expect(isQueuedSmsKind(null)).toBe(false);
  });
});

describe("plages d'envoi", () => {
  it("reads the Paris clock whatever the server timezone", () => {
    // 2026-09-19 is a Saturday; 07:30 UTC = 09:30 in Paris (CEST).
    expect(parisClock(new Date("2026-09-19T07:30:00Z"))).toEqual({ hour: 9, weekday: 6 });
    // 23:30 UTC on Saturday = 01:30 on Sunday in Paris.
    expect(parisClock(new Date("2026-09-19T23:30:00Z"))).toEqual({ hour: 1, weekday: 0 });
  });

  it("sends between 8h and 20h only", () => {
    expect(canSendNow("READY", new Date("2026-09-18T05:30:00Z"))).toBe(false); // 07:30
    expect(canSendNow("READY", new Date("2026-09-18T06:00:00Z"))).toBe(true); // 08:00
    expect(canSendNow("READY", new Date("2026-09-18T17:59:00Z"))).toBe(true); // 19:59
    expect(canSendNow("READY", new Date("2026-09-18T18:00:00Z"))).toBe(false); // 20:00
  });

  it("keeps prospecting off Sundays but still tells a client his part arrived", () => {
    const sundayNoon = new Date("2026-09-20T10:00:00Z");
    expect(canSendNow("MAINTENANCE", sundayNoon)).toBe(false);
    expect(canSendNow("SATISFACTION", sundayNoon)).toBe(false);
    expect(canSendNow("READY", sundayNoon)).toBe(true);
  });
});
