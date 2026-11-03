import type { IApiKeyCacheStore, IPlanConfigProvider, IUsageTracker } from "@withwiz/toolkit/core/api-key";

/** 플랜과 무관하게 같은 한도를 돌려주는 IPlanConfigProvider. */
export function createFixedPlanConfig(limits: { apiKeyLimit: number; rateLimit: number }): IPlanConfigProvider {
  return {
    getApiKeyLimit: async () => limits.apiKeyLimit,
    getRateLimit: async () => limits.rateLimit,
  };
}

/** 캐시를 쓰지 않는다: 조회는 항상 미스이고 쓰기와 무효화는 아무 일도 하지 않는다. */
export const noopApiKeyCache: IApiKeyCacheStore = {
  getValidation: async () => null,
  setValidation: async () => {},
  invalidate: async () => {},
  invalidateUser: async () => {},
};

/** 사용량 한도를 두지 않는다: 항상 allowed. */
export const noopUsageTracker: IUsageTracker = {
  canMakeApiCall: async () => ({
    allowed: true,
    current: { daily: 0, monthly: 0 },
    limit: { daily: Number.MAX_SAFE_INTEGER, monthly: Number.MAX_SAFE_INTEGER },
  }),
};
