import { describe, expect, it } from "vitest";
import { activitySummary, errorsCsv, errorsJson, groupEvents, toCsv, type Activity, type AppEvent } from "./superadmin-journal";

const event = (p: Partial<AppEvent> & { id: number }): AppEvent => ({
  created_at: "2026-10-02T08:00:00Z",
  level: "error",
  source: "db",
  message: "POST /rpc/x → 500",
  stack: null,
  url: "/dashboard/retours?filter=A_VALIDER",
  context: null,
  fingerprint: "f1",
  organization_id: "org1",
  user_id: "u1",
  user_email: "caisse@example.com",
  user_role: "CAISSIER",
  user_agent: "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36",
  app_version: "abc1234",
  ...p,
});

describe("toCsv", () => {
  it("writes what French Excel opens: BOM, « ; », CRLF, quoted cells", () => {
    const csv = toCsv(["A", "B"], [["x;y", 'say "hi"'], ["line\nbreak", null]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('A;B\r\n"x;y";"say ""hi"""\r\n"line\nbreak";\r\n');
  });

  it("neutralises cells that would start a formula", () => {
    expect(toCsv(["A"], [["=HYPERLINK(1)"], ["-5"], ["@x"]])).toContain("'=HYPERLINK(1)\r\n'-5\r\n'@x");
  });
});

describe("groupEvents", () => {
  it("counts one problem per fingerprint, newest first, with who and where", () => {
    const groups = groupEvents([
      event({ id: 1, created_at: "2026-10-02T08:00:00Z" }),
      event({ id: 2, created_at: "2026-10-02T09:00:00Z", user_email: "admin@example.com", message: "POST /rpc/x → 500 again" }),
      event({ id: 3, fingerprint: "f2", level: "warn", created_at: "2026-10-02T10:00:00Z", organization_id: null, user_email: null }),
    ]);
    expect(groups.map((g) => g.fingerprint)).toEqual(["f2", "f1"]);
    expect(groups[1]).toMatchObject({ count: 2, first: "2026-10-02T08:00:00Z", last: "2026-10-02T09:00:00Z", message: "POST /rpc/x → 500 again" });
    expect(groups[1].users.sort()).toEqual(["admin@example.com", "caisse@example.com"]);
    expect(groups[1].pages).toEqual(["/dashboard/retours"]);
    expect(groups[0].users).toEqual([]);
  });
});

describe("exports", () => {
  it("puts the magasin name, the HTTP status and the code in the CSV", () => {
    const csv = errorsCsv([event({ id: 1, context: { status: 400, code: "P0001" } })], { org1: "Espace Auto 92" });
    const line = csv.split("\r\n")[1];
    expect(line).toContain("Espace Auto 92");
    expect(line).toContain(";400;P0001;");
    expect(line).toContain("Chrome · Windows");
  });

  it("groups the problems at the top of the JSON export", () => {
    const out = JSON.parse(errorsJson([event({ id: 1 }), event({ id: 2 })], { org1: "Espace Auto 92" }, { days: 7 }));
    expect(out.count).toBe(2);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toMatchObject({ count: 2, organizations: ["Espace Auto 92"] });
    expect(out.events[0].organization).toBe("Espace Auto 92");
  });
});

describe("activitySummary", () => {
  const base: Activity = { id: 1, created_at: "", organization_id: null, actor_id: null, action: "UPDATE", entity: "orders", entity_id: "abcdef123456", before: null, after: null };

  it("shows before → after for an update and the reference for a creation", () => {
    expect(activitySummary({ ...base, before: { solde_restant: 120 }, after: { solde_restant: 0 } })).toBe("solde_restant : 120 → 0");
    expect(activitySummary({ ...base, action: "INSERT", after: { ref_demande: "REQ-2026-00003" } })).toBe("REQ-2026-00003");
    expect(activitySummary({ ...base, action: "DELETE", before: {} })).toBe("abcdef12");
  });
});
