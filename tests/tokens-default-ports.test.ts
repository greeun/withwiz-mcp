import { describe, expect, it } from "vitest";
import { createFixedPlanConfig, noopApiKeyCache, noopUsageTracker } from "../src/tokens/index.js";

describe("기본 포트", () => {
  it("createFixedPlanConfig 는 플랜과 무관하게 고정 한도를 반환한다", async () => {
    const cfg = createFixedPlanConfig({ apiKeyLimit: 5, rateLimit: 60 });
    expect(await cfg.getApiKeyLimit("FREE")).toBe(5);
    expect(await cfg.getApiKeyLimit("PRO")).toBe(5);
    expect(await cfg.getRateLimit("PRO")).toBe(60);
  });

  it("noopApiKeyCache 는 항상 미스이고 쓰기는 아무 일도 하지 않는다", async () => {
    await noopApiKeyCache.setValidation("h", { valid: true });
    expect(await noopApiKeyCache.getValidation("h")).toBeNull();
    await expect(noopApiKeyCache.invalidate("h")).resolves.toBeUndefined();
    await expect(noopApiKeyCache.invalidateUser?.("u")).resolves.toBeUndefined();
  });

  it("noopUsageTracker 는 항상 allowed", async () => {
    const r = await noopUsageTracker.canMakeApiCall("u", "PRO");
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});
