import { describe, expect, it } from "vitest";
import { z as z3 } from "zod3";
import { z as z4 } from "zod4";
import { createMcpHandler, defineTool } from "../src/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function listTools(input: never) {
  const tool = defineTool({ name: "t", description: "d", action: "READ", input, handler: async () => ({}) });
  const h = createMcpHandler({
    server: { name: "t", version: "1.0.0" },
    tools: [tool],
    authenticate: () => ({ userId: "u", tokenId: "t", actions: ["READ"] }),
  });
  const res = await h.POST(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer x",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  return ((await res.json()) as any).result.tools[0].inputSchema;
}

describe("zod 호환", () => {
  it.each([
    ["zod 3", () => ({ name: z3.string(), n: z3.number().optional() })],
    ["zod 4", () => ({ name: z4.string(), n: z4.number().optional() })],
  ])("%s 입력의 스키마가 required 와 속성을 포함한다", async (_label, make) => {
    const schema = await listTools(make() as never);
    expect(Object.keys(schema.properties)).toEqual(["name", "n"]);
    expect(schema.required).toEqual(["name"]);
  });
});
