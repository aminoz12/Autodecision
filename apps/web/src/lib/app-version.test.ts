import { describe, expect, it } from "vitest";
import { isNewerDeploy, shouldAutoReload } from "./app-version";

describe("isNewerDeploy", () => {
  it("signale un déploiement différent du bundle courant", () => {
    expect(isNewerDeploy("c8166be", "d1f2e3a")).toBe(true);
  });
  it("reste muet quand les versions sont égales", () => {
    expect(isNewerDeploy("c8166be", "c8166be")).toBe(false);
  });
  it("reste muet en dev et quand /api/version ne répond pas", () => {
    expect(isNewerDeploy("dev", "c8166be")).toBe(false);
    expect(isNewerDeploy("c8166be", "dev")).toBe(false);
    expect(isNewerDeploy("c8166be", null)).toBe(false);
    expect(isNewerDeploy("c8166be", "")).toBe(false);
  });
});

describe("shouldAutoReload", () => {
  it("recharge une fois pour une version jamais vue", () => {
    expect(shouldAutoReload("d1f2e3a", null)).toBe(true);
    expect(shouldAutoReload("d1f2e3a", "c8166be")).toBe(true);
  });
  it("ne reboucle pas si on a déjà rechargé pour cette version", () => {
    expect(shouldAutoReload("d1f2e3a", "d1f2e3a")).toBe(false);
  });
});
