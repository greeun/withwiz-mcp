import type { ApiKeyValidationResult, IUsageTracker } from "@withwiz/toolkit/core/api-key";
import { describe, expect, it, vi } from "vitest";
import { createMcpHandler, defineTool, type AnyMcpTool, type McpPrincipal } from "../src/index.js";
import { createApiKeyAuthenticator, type ApiKeyPrincipalData } from "../src/tokens/index.js";

type Perm = "read" | "write" | "delete";

function validResult(over: { permissions?: Perm[]; ipWhitelist?: string[] } = {}): ApiKeyValidationResult {
  return {
    valid: true,
    apiKey: {
      id: "k1",
      userId: "u1",
      permissions: over.permissions ?? ["read"],
      rateLimit: 100,
      ipWhitelist: over.ipWhitelist ?? [],
      environment: "production",
    },
    user: { id: "u1", email: "a@b.c", plan: "PRO" },
  };
}

function setup(
  result: ApiKeyValidationResult = validResult(),
  opts: {
    usage?: IUsageTracker["canMakeApiCall"];
    extractClientIp?: (h: Headers) => string | undefined;
    recordCall?: (r: unknown) => void | Promise<void>;
    trackUsage?: () => Promise<void>;
  } = {},
) {
  const service = {
    validateApiKey: vi.fn(async () => result),
    trackUsage: vi.fn(opts.trackUsage ?? (async () => {})),
  };
  const canMakeApiCall = vi.fn(
    opts.usage ?? (async () => ({ allowed: true, current: { daily: 0, monthly: 0 }, limit: { daily: 1, monthly: 1 } })),
  );
  const auth = createApiKeyAuthenticator({
    service,
    usage: opts.usage ? { canMakeApiCall } : undefined,
    extractClientIp: opts.extractClientIp,
    recordCall: opts.recordCall as never,
  });
  return { service, canMakeApiCall, auth };
}

const req = (headers: Record<string, string> = {}) => new Request("http://x/mcp", { method: "POST", headers });
const tool = (action: "READ" | "WRITE" | "DELETE", name = "t"): AnyMcpTool<ApiKeyPrincipalData> =>
  ({ name, description: "d", action, input: {}, handler: async () => null }) as never;
const principalOf = async (a: ReturnType<typeof setup>["auth"], r = req()) => (await a.authenticate("raw", r))!;

describe("authenticate", () => {
  it("무효·폐기·만료 키는 null", async () => {
    for (const error of ["INVALID_API_KEY", "INACTIVE_API_KEY", "EXPIRED_API_KEY"] as const) {
      const { auth } = setup({ valid: false, error });
      expect(await auth.authenticate("raw", req())).toBeNull();
    }
  });

  it("permissions 를 read→READ, write→WRITE, delete→DELETE 로 변환한다", async () => {
    const { auth } = setup(validResult({ permissions: ["read", "write", "delete"] }));
    const p = await principalOf(auth);
    expect(p).toMatchObject({ userId: "u1", tokenId: "k1", actions: ["READ", "WRITE", "DELETE"] });
    expect(p.data).toEqual({ email: "a@b.c", plan: "PRO", ip: undefined });
  });

  it("화이트리스트 밖 IP 는 null", async () => {
    const { auth } = setup(validResult({ ipWhitelist: ["10.0.0.0/8"] }), { extractClientIp: () => "1.2.3.4" });
    expect(await auth.authenticate("raw", req())).toBeNull();
  });

  it("화이트리스트 안 IP 는 통과하고 ip 를 data 에 담는다", async () => {
    const { auth } = setup(validResult({ ipWhitelist: ["10.0.0.0/8"] }), { extractClientIp: () => "10.1.2.3" });
    expect((await principalOf(auth)).data?.ip).toBe("10.1.2.3");
  });

  it("화이트리스트가 있는데 extractClientIp 가 없으면 null", async () => {
    const { auth } = setup(validResult({ ipWhitelist: ["10.0.0.0/8"] }));
    expect(await auth.authenticate("raw", req())).toBeNull();
  });

  it("화이트리스트가 있는데 IP 를 얻지 못하면 null", async () => {
    const { auth } = setup(validResult({ ipWhitelist: ["10.0.0.0/8"] }), { extractClientIp: () => undefined });
    expect(await auth.authenticate("raw", req())).toBeNull();
  });

  it("화이트리스트가 비어 있으면 IP 없이 통과한다", async () => {
    const { auth } = setup();
    expect(await auth.authenticate("raw", req())).not.toBeNull();
  });

  it("authenticate 는 canMakeApiCall 을 호출하지 않는다", async () => {
    const { auth, canMakeApiCall } = setup(validResult(), { usage: async () => ({ allowed: false }) as never });
    expect(await auth.authenticate("raw", req())).not.toBeNull();
    expect(canMakeApiCall).not.toHaveBeenCalled();
  });
});

describe("authorize", () => {
  it("키 권한 밖 액션은 false, 안의 액션은 true", async () => {
    const { auth } = setup(validResult({ permissions: ["read"] }));
    const p = await principalOf(auth);
    expect(await auth.authorize(p, tool("WRITE"))).toBe(false);
    expect(await auth.authorize(p, tool("READ"))).toBe(true);
  });

  it("사용량 초과면 false", async () => {
    const { auth, canMakeApiCall } = setup(validResult(), { usage: async () => ({ allowed: false }) as never });
    const p = await principalOf(auth);
    expect(await auth.authorize(p, tool("READ"))).toBe(false);
    expect(canMakeApiCall).toHaveBeenCalledWith("u1", "PRO");
  });

  it("사용량 인프라 장애는 true", async () => {
    const { auth } = setup(validResult(), {
      usage: async () => {
        throw new Error("redis down");
      },
    });
    expect(await auth.authorize(await principalOf(auth), tool("READ"))).toBe(true);
  });

  it("권한 밖 액션이면 사용량을 조회하지 않는다", async () => {
    const { auth, canMakeApiCall } = setup(validResult({ permissions: ["read"] }), {
      usage: async () => ({ allowed: true }) as never,
    });
    await auth.authorize(await principalOf(auth), tool("DELETE"));
    expect(canMakeApiCall).not.toHaveBeenCalled();
  });

  it("data 가 없는 principal 은 거부한다", async () => {
    const { auth } = setup(validResult(), { usage: async () => ({ allowed: true }) as never });
    const p: McpPrincipal<ApiKeyPrincipalData> = { userId: "u", tokenId: "t", actions: ["READ"] };
    expect(await auth.authorize(p, tool("READ"))).toBe(false);
  });
});

describe("onToolSettled", () => {
  it("trackUsage 와 recordCall 을 호출한다", async () => {
    const recordCall = vi.fn();
    const { auth, service } = setup(validResult(), { recordCall, extractClientIp: () => "9.9.9.9" });
    const p = await principalOf(auth);
    await auth.onToolSettled({ tool: tool("READ", "my_tool"), principal: p, status: 200 });
    expect(service.trackUsage).toHaveBeenCalledWith("k1", "9.9.9.9");
    expect(recordCall).toHaveBeenCalledWith({
      apiKeyId: "k1",
      userId: "u1",
      tool: "my_tool",
      status: 200,
      ip: "9.9.9.9",
    });
  });

  it("거부된 호출은 trackUsage 도 recordCall 도 호출하지 않는다", async () => {
    const recordCall = vi.fn();
    const { auth, service } = setup(validResult(), { recordCall });
    await auth.onToolSettled({ tool: tool("READ"), principal: await principalOf(auth), status: 403, denied: true });
    expect(service.trackUsage).not.toHaveBeenCalled();
    expect(recordCall).not.toHaveBeenCalled();
  });

  it("usage 가 없어도 실행된 호출은 기록하고, 도구 내부 403 도 기록한다", async () => {
    const recordCall = vi.fn();
    const { auth, service } = setup(validResult(), { recordCall });
    await auth.onToolSettled({ tool: tool("READ"), principal: await principalOf(auth), status: 403 });
    expect(service.trackUsage).toHaveBeenCalledOnce();
    expect(recordCall).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it("trackUsage, recordCall 실패를 삼키고 서로 막지 않는다", async () => {
    const recordCall = vi.fn(async () => {
      throw new Error("db");
    });
    const { auth, service } = setup(validResult(), {
      recordCall,
      trackUsage: async () => {
        throw new Error("db");
      },
    });
    const p = await principalOf(auth);
    await expect(auth.onToolSettled({ tool: tool("READ"), principal: p, status: 200 })).resolves.toBeUndefined();
    expect(service.trackUsage).toHaveBeenCalled();
    expect(recordCall).toHaveBeenCalled();
  });

  it("recordCall 이 동기로 던져도 삼킨다", async () => {
    const { auth } = setup(validResult(), {
      recordCall: () => {
        throw new Error("sync");
      },
    });
    const p = await principalOf(auth);
    await expect(auth.onToolSettled({ tool: tool("READ"), principal: p, status: 200 })).resolves.toBeUndefined();
  });
});

describe("createMcpHandler 결합", () => {
  it("한도 초과 키로 tools/list 는 200, tools/call 은 isError", async () => {
    const { auth, service, canMakeApiCall } = setup(validResult(), { usage: async () => ({ allowed: false }) as never });
    const ping = defineTool<ApiKeyPrincipalData, {}>({
      name: "ping",
      description: "d",
      action: "READ",
      input: {},
      handler: async () => "pong",
    });
    const h = createMcpHandler<ApiKeyPrincipalData>({
      server: { name: "t", version: "1.0.0" },
      tools: [ping],
      ...auth,
    });
    const rpc = (body: unknown) =>
      new Request("http://x/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer raw",
        },
        body: JSON.stringify(body),
      });
    const init = await h.POST(
      rpc({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } },
      }),
    );
    expect(init.status).toBe(200);
    const list = await h.POST(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).result.tools).toHaveLength(1); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(canMakeApiCall).not.toHaveBeenCalled();
    expect(service.trackUsage).not.toHaveBeenCalled();
    const call = await h.POST(
      rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } }),
    );
    expect(call.status).toBe(200);
    expect(((await call.json()) as any).result.isError).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});
