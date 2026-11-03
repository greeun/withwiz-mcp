import type { ApiKeyPermission } from "@withwiz/toolkit/core/api-key/types";
import type { ApiKeyService } from "@withwiz/toolkit/core/api-key/api-key.service";
import type { IUsageTracker } from "@withwiz/toolkit/core/api-key/ports";
import { isIpAllowed } from "@withwiz/toolkit/core/api-key/ip-whitelist";
import type { McpAction } from "../types.js";
import type { McpHandlerOptions } from "../handler.js";

export interface ApiKeyPrincipalData {
  email: string;
  plan: string;
  /** extractClientIp 가 있을 때 요청에서 얻은 클라이언트 IP. */
  ip?: string;
}

export interface ApiKeyCallRecord {
  apiKeyId: string;
  userId: string;
  tool: string;
  status: number;
  ip?: string;
}

export interface ApiKeyAuthenticatorOptions {
  service: Pick<ApiKeyService, "validateApiKey" | "trackUsage">;
  /** 지정하면 tools/call 직전에 사용량 한도를 확인한다. */
  usage?: IUsageTracker;
  /** 지정해야 키의 IP 화이트리스트를 검사할 수 있다. */
  extractClientIp?(headers: Headers): string | undefined;
  /**
   * 실행된 도구 호출 1건을 소비 프로젝트가 저장한다(usage 와 무관).
   * SDK 입력 검증은 execute 이전에 끝나므로 입력이 잘못된 호출은 authorize, onToolSettled 에 닿지 않아 기록되지 않는다.
   * 거부된 호출도 기록하지 않는다.
   */
  recordCall?(record: ApiKeyCallRecord): void | Promise<void>;
}

type Handler = McpHandlerOptions<ApiKeyPrincipalData>;

// toolkit 소문자 권한 어휘를 MCP 액션으로 변환한다.
const ACTION_BY_PERMISSION: Record<ApiKeyPermission, McpAction> = {
  read: "READ",
  write: "WRITE",
  delete: "DELETE",
};

/**
 * toolkit API 키 코어를 MCP 단계에 맞게 나눈다.
 * authenticate: 모든 POST(키 검증, IP). authorize: tools/call(권한, 사용량). onToolSettled: tools/call 종료(기록).
 */
export function createApiKeyAuthenticator(options: ApiKeyAuthenticatorOptions): {
  authenticate: Handler["authenticate"];
  authorize: NonNullable<Handler["authorize"]>;
  onToolSettled: NonNullable<Handler["onToolSettled"]>;
} {
  // 구조 분해하면 클래스 인스턴스 옵션의 메서드가 this 를 잃으므로 options 에서 직접 호출한다.
  const { service, usage } = options;

  const authenticate: Handler["authenticate"] = async (rawToken, request) => {
    const result = await service.validateApiKey(rawToken);
    if (!result.valid || !result.apiKey || !result.user) return null;
    const { apiKey, user } = result;

    const ip = options.extractClientIp?.(request.headers);
    // 캐시나 소비 저장소가 null 을 줄 수 있으므로 toolkit 미들웨어처럼 빈 목록으로 취급한다.
    if (apiKey.ipWhitelist?.length) {
      // 화이트리스트가 있는데 IP 를 알 수 없으면 거부한다(fail-closed).
      if (!ip || !isIpAllowed(ip, apiKey.ipWhitelist)) return null;
    }

    return {
      userId: apiKey.userId,
      tokenId: apiKey.id,
      actions: apiKey.permissions.map((p) => ACTION_BY_PERMISSION[p]),
      data: { email: user.email, plan: user.plan, ip },
    };
  };

  const authorize: NonNullable<Handler["authorize"]> = async (principal, tool) => {
    if (!principal.actions?.includes(tool.action)) return false;
    if (!usage) return true;
    // data 없이는 플랜을 알 수 없어 한도를 판정할 수 없다.
    if (!principal.data) return false;
    try {
      const check = await usage.canMakeApiCall(principal.userId, principal.data.plan);
      return check.allowed;
    } catch {
      // 사용량 인프라 장애로 정상 키의 호출을 막지 않는다.
      return true;
    }
  };

  const onToolSettled: NonNullable<Handler["onToolSettled"]> = async ({ tool, principal, status, denied }) => {
    // 거부된 호출은 실행되지 않았으므로 호출 수·한도·마지막 사용 정보에 반영하지 않는다.
    if (denied) return;
    const ip = principal.data?.ip;
    // 둘 중 하나가 실패해도 다른 기록과 도구 결과에는 영향을 주지 않는다.
    await Promise.allSettled([
      Promise.resolve().then(() => service.trackUsage(principal.tokenId, ip)),
      Promise.resolve().then(() =>
        options.recordCall?.({ apiKeyId: principal.tokenId, userId: principal.userId, tool: tool.name, status, ip }),
      ),
    ]);
  };

  return { authenticate, authorize, onToolSettled };
}
