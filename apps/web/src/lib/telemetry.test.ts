import { describe, expect, it } from "vitest";
import { classifyFailure, redactBody } from "./telemetry";

describe("classifyFailure", () => {
  it("files a missing column, table or function as a schema warning (migration missing)", () => {
    expect(classifyFailure("supabase", "/orders", 400, "42703")).toEqual({ level: "warn", source: "schema" });
    expect(classifyFailure("supabase", "/rpc/set_line_reglement", 404, "PGRST202")).toEqual({ level: "warn", source: "schema" });
    expect(classifyFailure("supabase", "/app_events", 404, "42P01")).toEqual({ level: "warn", source: "schema" });
  });

  it("files a refused business rule as a warning, a server failure as an error", () => {
    expect(classifyFailure("supabase", "/rpc/record_order_payment", 400, "P0001")).toEqual({ level: "warn", source: "rule" });
    expect(classifyFailure("supabase", "/rpc/record_order_payment", 500, null)).toEqual({ level: "error", source: "db" });
    expect(classifyFailure("supabase", "/orders", 403, "42501")).toEqual({ level: "error", source: "db" });
  });

  it("keeps sign-in failures and /api refusals apart", () => {
    expect(classifyFailure("supabase", "/auth/v1/token", 400, null)).toEqual({ level: "warn", source: "auth" });
    expect(classifyFailure("api", "/api/team", 400, null)).toEqual({ level: "warn", source: "api" });
    expect(classifyFailure("api", "/api/send-sms", 502, null)).toEqual({ level: "error", source: "api" });
  });
});

describe("redactBody", () => {
  it("hides anything that looks like a secret and caps the length", () => {
    const out = redactBody(JSON.stringify({ p_order_id: "abc", p_password: "hunter2", access_token: "xyz" }));
    expect(out).toContain('"p_order_id":"abc"');
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("xyz");
    expect(redactBody("x".repeat(5000)).length).toBe(800);
  });
});
