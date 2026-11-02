import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpHandler, defineTool, type McpPrincipal, type McpToolSettled } from "../src/index.js";

const SERVER = { name: "t", version: "1.0.0" };
const echo = defineTool({
  name: "whoami",
  description: "d",
  action: "READ",
  input: { n: z.number().optional() },
  handler: async (_args, { principal }) => ({ userId: principal.userId }),
});

const byToken = (raw: string): McpPrincipal | null =>
  raw.startsWith("tok-") ? { userId: raw.slice(4), tokenId: "tid", actions: ["READ"] } : null;

function handler(over: Partial<Parameters<typeof createMcpHandler>[0]> = {}) {
  return createMcpHandler({ server: SERVER, tools: [echo], authenticate: byToken, ...over });
}

function rpc(body: unknown, headers: Record<string, string> = {}, raw = false) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

// 응답 JSON-RPC 본문 접근용 느슨한 타입.
const rpcJson = async (res: Response) => (await res.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const callWho = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } };

afterEach(() => vi.restoreAllMocks());

describe("createMcpHandler", () => {
  it("GET, DELETE 는 allow: POST 와 405 를 응답한다", async () => {
    const h = handler();
    for (const res of [h.GET(), h.DELETE()]) {
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(await res.json()).toEqual({ error: "Method not allowed" });
    }
  });

  it("methodNotAllowed 본문을 교체할 수 있다", async () => {
    const res = handler({ responses: { methodNotAllowed: { nope: 1 } } }).GET();
    expect(await res.json()).toEqual({ nope: 1 });
  });

  it("Bearer 가 없으면 401 이고 쿠키를 읽지 않는다", async () => {
    const authenticate = vi.fn(byToken);
    const res = await handler({ authenticate }).POST(rpc(list, { cookie: "session=tok-abc" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("authenticate 가 null 이면 401 invalidToken 본문", async () => {
    const res = await handler().POST(rpc(list, auth("bad")));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid token" });
  });

  it("응답 본문을 교체할 수 있다", async () => {
    const h = handler({ responses: { unauthorized: { u: 1 }, invalidToken: { i: 1 } } });
    expect(await (await h.POST(rpc(list))).json()).toEqual({ u: 1 });
    expect(await (await h.POST(rpc(list, auth("bad")))).json()).toEqual({ i: 1 });
  });

  it("authenticate 가 throw 하면 원인 없는 500", async () => {
    const authenticate = () => {
      throw new Error("db password leaked");
    };
    const res = await handler({ authenticate }).POST(rpc(list, auth("tok-a")));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("leaked");
    expect(JSON.parse(text)).toEqual({ error: "Internal error" });
  });

  it("Bearer 값을 authenticate 에 원문으로 전달하고 settled 이벤트에는 넣지 않는다", async () => {
    const authenticate = vi.fn((raw: string, _request: Request) => byToken(raw));
    const events: McpToolSettled[] = [];
    const h = handler({ authenticate, onToolSettled: (e) => void events.push(e) });
    await h.POST(rpc(callWho, auth("tok-secret9")));
    expect(authenticate.mock.calls[0][0]).toBe("tok-secret9");
    expect(authenticate.mock.calls[0][1]).toBeInstanceOf(Request);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain("tok-secret9");
  });

  it("scheme 대소문자를 구분하지 않는다", async () => {
    const res = await handler().POST(rpc(list, { authorization: "bearer tok-a" }));
    expect(res.status).toBe(200);
  });

  it("tools/list 를 JSON 으로 응답한다", async () => {
    const res = await handler().POST(rpc(list, auth("tok-a")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await rpcJson(res);
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(["whoami"]);
  });

  it("tools/call 이 실제 전송을 건너 핸들러와 principal 에 닿는다", async () => {
    const res = await handler().POST(rpc(callWho, auth("tok-alice")));
    const body = await rpcJson(res);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ userId: "alice" });
  });

  it("처리 후 서버를 close 한다", async () => {
    const close = vi.spyOn(McpServer.prototype, "close");
    await handler().POST(rpc(list, auth("tok-a")));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("잘못된 JSON 본문은 4xx 이고 서버를 close 한다", async () => {
    const close = vi.spyOn(McpServer.prototype, "close");
    const res = await handler().POST(rpc("{not json", auth("tok-a"), true));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("동시 요청에서 principal 이 섞이지 않는다", async () => {
    const h = handler();
    const users = ["a", "b", "c", "d", "e", "f"];
    const bodies = await Promise.all(
      users.map(async (u) => rpcJson(await h.POST(rpc(callWho, auth(`tok-${u}`))))),
    );
    expect(bodies.map((b) => JSON.parse(b.result.content[0].text).userId)).toEqual(users);
  });
});
