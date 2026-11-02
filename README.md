# @withwiz/mcp

Standard MCP server connection and auth for withwiz apps. Each app supplies its own tools; this package fixes how they are served and who may call them.

## Quick start

```bash
pnpm add @withwiz/mcp @modelcontextprotocol/sdk zod
```

```ts
// app/api/mcp/route.ts (Next.js)
import { z } from "zod";
import { createMcpHandler, defineTool } from "@withwiz/mcp";

const listPosts = defineTool({
  name: "list_posts",
  description: "List posts",
  action: "READ",
  input: { limit: z.number().int().max(50).optional() },
  async handler({ limit }, { principal }) {
    return await db.posts.list({ userId: principal.userId, limit });
  },
});

const handler = createMcpHandler({
  server: { name: "my-app", version: "1.0.0" },
  tools: [listPosts],
  // The only place that sees the raw token. Return null when invalid.
  async authenticate(rawToken) {
    const token = await findToken(rawToken);
    return token
      ? { userId: token.userId, tokenId: token.id, actions: token.actions }
      : null;
  },
  // You own error mapping: hide 5xx details here.
  mapError: (error) => toErrorResult(error),
});

export const { POST, GET, DELETE } = handler;
```

Connect a client:

```bash
claude mcp add --transport http my-app https://example.com/api/mcp \
  --header "Authorization: Bearer <token>"
```

## Fixed behaviours

- Stateless Streamable HTTP: a transport and server are created per request and closed afterwards.
- POST only. GET and DELETE return 405 with `Allow: POST`.
- Bearer only. Cookies are never read; `Authorization: Bearer` is the sole credential.
- Permission is per tool `action` (`READ`, `WRITE`, `DELETE`), checked against `principal.actions`, not by HTTP method.
- `authorize` fails closed: a rejected or throwing check denies the call.
- Failures are returned as `isError` tool results, not protocol errors.
- `mapError` decides what an error looks like to the client. Use it to hide 5xx details; raw exceptions are never exposed.
- Hooks (`authorize`, `runTool`, `onToolSettled`) receive the principal, never the raw token.
- Failures inside `onToolSettled` are absorbed and never affect the response.

## Traps these behaviours prevent

- GET on an MCP endpoint opens an SSE stream that never produces events and hangs clients. GET is a 405 instead.
- Cookie sessions would let a browser request bypass token scope. Only Bearer tokens are accepted.
- All MCP traffic is POST, so permissions keyed on HTTP method cannot tell a read from a write. Permissions follow the tool `action`.
- A server instance left open leaks resources per request. Each one is closed after the request.

## Rate limiting

Routes that expose WRITE or DELETE tools must be rate limited. The handler does not do it; wrap it outside:

```ts
export const POST = (request: Request) =>
  withRateLimit(request, () => handler.POST(request));
```

## License

MIT
