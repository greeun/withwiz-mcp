import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildMcpServer,
  defineTool,
  type AnyMcpTool,
  type McpAction,
  type McpPrincipal,
  type McpServerOptions,
  type McpToolSettled,
} from "../src/index.js";

const base: McpServerOptions = { server: { name: "t", version: "1.0.0" } };

function principal(actions?: McpAction[]): McpPrincipal {
  return { userId: "u1", tokenId: "t1", actions };
}

async function connect(tools: AnyMcpTool[], options: McpServerOptions, p: McpPrincipal) {
  const server = buildMcpServer(tools, options, p);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Result = { content: { type: string; text: string }[]; isError?: boolean };

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as unknown as Result;
}

function tool(over: Partial<{ action: McpAction; handler: () => Promise<unknown>; name: string }> = {}) {
  return defineTool({
    name: over.name ?? "echo",
    description: "d",
    action: over.action ?? "READ",
    input: {},
    handler: over.handler ?? (async () => ({ a: 1 })),
  });
}

describe("buildMcpServer", () => {
  it("성공 결과를 JSON text 로 직렬화한다", async () => {
    const client = await connect([tool()], base, principal(["READ"]));
    const r = await call(client, "echo");
    expect(r.content[0].text).toBe('{"a":1}');
    expect(r.isError).toBeUndefined();
  });

  it("반환값이 없으면 null 을 응답한다", async () => {
    const client = await connect([tool({ handler: async () => undefined })], base, principal(["READ"]));
    expect((await call(client, "echo")).content[0].text).toBe("null");
  });

  it("authorize 가 없으면 principal.actions 로 판정한다", async () => {
    const handler = vi.fn(async () => ({}));
    const client = await connect([tool({ action: "WRITE", handler })], base, principal(["READ"]));
    const r = await call(client, "echo");
    expect(r.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("authorize 도 actions 도 없으면 거부한다", async () => {
    const handler = vi.fn(async () => ({}));
    const client = await connect([tool({ handler })], base, principal());
    expect((await call(client, "echo")).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("거부 시 responses.forbidden 본문과 status 403 으로 settled 한다", async () => {
    const events: McpToolSettled<unknown>[] = [];
    const client = await connect(
      [tool({ action: "DELETE" })],
      { ...base, responses: { forbidden: { code: "NO" } }, onToolSettled: (e) => { events.push(e); } },
      principal(["READ"]),
    );
    const r = await call(client, "echo");
    expect(JSON.parse(r.content[0].text)).toEqual({ code: "NO" });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe(403);
    expect(events[0].denied).toBe(true);
  });

  it("도구 내부 오류가 mapError 로 403 이 되어도 denied 가 아니다", async () => {
    const events: McpToolSettled<unknown>[] = [];
    const client = await connect(
      [tool({ handler: async () => { throw new Error("x"); } })],
      { ...base, mapError: () => ({ status: 403, body: {} }), onToolSettled: (e) => { events.push(e); } },
      principal(["READ"]),
    );
    await call(client, "echo");
    expect(events[0].status).toBe(403);
    expect(events[0].denied).toBeUndefined();
  });

  it("기본 거부 본문은 Forbidden 이다", async () => {
    const client = await connect([tool({ action: "WRITE" })], base, principal(["READ"]));
    expect(JSON.parse((await call(client, "echo")).content[0].text)).toEqual({ error: "Forbidden" });
  });

  it("authorize 가 throw 하면 실행하지 않고 오류로 응답한다", async () => {
    const handler = vi.fn(async () => ({}));
    const client = await connect(
      [tool({ handler })],
      {
        ...base,
        authorize: () => {
          throw new Error("secret");
        },
      },
      principal(["READ"]),
    );
    const r = await call(client, "echo");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain("secret");
    expect(handler).not.toHaveBeenCalled();
  });

  it("authorize 결과가 true 면 actions 와 무관하게 실행한다", async () => {
    const client = await connect([tool({ action: "WRITE" })], { ...base, authorize: () => true }, principal());
    expect((await call(client, "echo")).isError).toBeUndefined();
  });

  it("mapError 가 없으면 예외 원인을 숨긴다", async () => {
    const events: McpToolSettled<unknown>[] = [];
    const boom = new Error("secret");
    const client = await connect(
      [
        tool({
          handler: async () => {
            throw boom;
          },
        }),
      ],
      { ...base, onToolSettled: (e) => { events.push(e); } },
      principal(["READ"]),
    );
    const r = await call(client, "echo");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain("secret");
    expect(JSON.parse(r.content[0].text)).toEqual({ error: "Internal error" });
    expect(events[0].status).toBe(500);
    expect(events[0].error).toBe(boom);
  });

  it("mapError 결과를 변형 없이 응답한다", async () => {
    const events: McpToolSettled<unknown>[] = [];
    const client = await connect(
      [
        tool({
          handler: async () => {
            throw new Error("x");
          },
        }),
      ],
      { ...base, mapError: () => ({ status: 503, body: { msg: "later" } }), onToolSettled: (e) => { events.push(e); } },
      principal(["READ"]),
    );
    const r = await call(client, "echo");
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({ msg: "later" });
    expect(events[0].status).toBe(503);
  });

  it("runTool 안에서 핸들러를 실행한다", async () => {
    const als = new AsyncLocalStorage<string>();
    const client = await connect(
      [tool({ handler: async () => ({ v: als.getStore() }) })],
      { ...base, runTool: (_p, _t, execute) => als.run("ctx", execute) },
      principal(["READ"]),
    );
    expect((await call(client, "echo")).content[0].text).toBe('{"v":"ctx"}');
  });

  it("onToolSettled 가 throw 해도 도구 결과는 유지된다", async () => {
    const client = await connect(
      [tool()],
      {
        ...base,
        onToolSettled: () => {
          throw new Error("hook");
        },
      },
      principal(["READ"]),
    );
    const r = await call(client, "echo");
    expect(r.content[0].text).toBe('{"a":1}');
    expect(r.isError).toBeUndefined();
  });

  it("onToolSettled 가 reject 해도 도구 결과는 유지되고 unhandled rejection 이 없다", async () => {
    const unhandled: unknown[] = [];
    const listener = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", listener);
    try {
      const client = await connect(
        [tool()],
        { ...base, onToolSettled: async () => Promise.reject(new Error("hook")) },
        principal(["READ"]),
      );
      const r = await call(client, "echo");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(r.content[0].text).toBe('{"a":1}');
      expect(r.isError).toBeUndefined();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("성공 시 status 200 으로 settled 한다", async () => {
    const events: McpToolSettled<unknown>[] = [];
    const client = await connect([tool()], { ...base, onToolSettled: (e) => { events.push(e); } }, principal(["READ"]));
    await call(client, "echo");
    expect(events[0]).toMatchObject({ status: 200, tool: { name: "echo" } });
    expect(events[0].error).toBeUndefined();
  });

  it("initialize, tools/list 에서는 authorize 와 settled 를 호출하지 않는다", async () => {
    const authorize = vi.fn(() => true);
    const onToolSettled = vi.fn();
    const client = await connect([tool()], { ...base, authorize, onToolSettled }, principal(["READ"]));
    await client.listTools();
    expect(authorize).not.toHaveBeenCalled();
    expect(onToolSettled).not.toHaveBeenCalled();
  });

  it("annotations 와 input 을 tools/list 에 노출한다", async () => {
    const t = defineTool({
      name: "typed",
      description: "d",
      action: "READ",
      input: { n: z.number() },
      annotations: { readOnlyHint: true },
      handler: async (args) => ({ doubled: args.n * 2 }),
    });
    const client = await connect([t], base, principal(["READ"]));
    const { tools } = await client.listTools();
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
    expect(tools[0].inputSchema.properties).toHaveProperty("n");
    expect((await call(client, "typed", { n: 2 })).content[0].text).toBe('{"doubled":4}');
  });

  it("handler 에 principal 을 전달한다", async () => {
    const t = defineTool<{ k: number }, Record<string, never>>({
      name: "who",
      description: "d",
      action: "READ",
      input: {},
      handler: async (_a, ctx) => ({ u: ctx.principal.userId, k: ctx.principal.data?.k }),
    });
    const p: McpPrincipal<{ k: number }> = { userId: "u9", tokenId: "t", actions: ["READ"], data: { k: 7 } };
    const client = await connect([t] as AnyMcpTool[], base, p as McpPrincipal);
    expect((await call(client, "who")).content[0].text).toBe('{"u":"u9","k":7}');
  });
});

describe("defineTool 타입 추론", () => {
  it("input 형상에 없는 인자는 컴파일 오류다", () => {
    defineTool({
      name: "t",
      description: "d",
      action: "READ",
      input: { n: z.number() },
      // @ts-expect-error input 에 없는 필드
      handler: async (args) => args.missing,
    });
  });
});
