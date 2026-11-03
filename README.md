# @withwiz/mcp

Standard MCP server connection and auth for withwiz apps. Each app supplies its own tools; this package fixes how they are served and who may call them.

## Quick start

```bash
pnpm add @withwiz/mcp @modelcontextprotocol/sdk zod
```

```ts
// app/api/mcp/route.ts (Next.js)
// `db`, `findToken`, `toErrorResult` and `withRateLimit` are app-defined, not part of this package.
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
  // You own error mapping: return { status: number; body: unknown } and hide 5xx details here.
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
- `authorize` fails closed: a rejected or throwing check denies the call. If you do not set it, the call is judged by `principal.actions`, and it is denied when the tool `action` is not listed or `actions` is absent.
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

## API keys (`@withwiz/mcp/tokens`)

Optional entry point that connects the API key core of `@withwiz/toolkit` (`>=0.13`, optional peer) to the handler stages. `@withwiz/mcp` itself does not import the toolkit.

```bash
pnpm add @withwiz/toolkit
```

```ts
import { createMcpHandler } from "@withwiz/mcp";
import {
  createApiKeyAuthenticator,
  createPrismaApiKeyRepository,
  createFixedPlanConfig,
  noopApiKeyCache,
  noopUsageTracker,
} from "@withwiz/mcp/tokens";
import { ApiKeyService } from "@withwiz/toolkit/core/api-key/api-key.service";

// `prisma`, `env`, `getTrustedClientIp` and `saveCall` are app-defined.
const repository = createPrismaApiKeyRepository({
  apiKey: prisma.apiKey,
  userSelect: { id: true, email: true, isActive: true, plan: true },
  mapUser: (u) => ({ id: u.id, email: u.email, isActive: u.isActive, plan: u.plan }),
});

const service = new ApiKeyService({
  repo: repository,
  cache: noopApiKeyCache,
  planConfig: createFixedPlanConfig({ apiKeyLimit: 5, rateLimit: 1000 }),
  usage: noopUsageTracker,
  env, // { prefixProd, prefixDev, defaultExpiryDays, restrictedPlans }
});

const auth = createApiKeyAuthenticator({
  service,
  usage: noopUsageTracker,            // optional: check usage limits before tools/call
  extractClientIp: getTrustedClientIp, // optional: required to enforce a key's IP whitelist
  recordCall: saveCall,                // optional: store one record per executed call
});

export const { POST, GET, DELETE } = createMcpHandler({
  server: { name: "my-app", version: "1.0.0" },
  tools,
  ...auth,
  responses: { unauthorized: { error: "..." }, invalidToken: { error: "..." }, forbidden: "..." },
});
```

### Stages

| Stage | Runs on | What it does |
| --- | --- | --- |
| `authenticate` | every POST | Validates the key (`validateApiKey`), then the IP whitelist. Returns `null` when the key is invalid, inactive, expired, or the IP is not allowed. |
| `authorize` | `tools/call` | Checks the key `permissions` against the tool `action` (`read`/`write`/`delete` map to `READ`/`WRITE`/`DELETE`), then the usage limit when `usage` is set. |
| `onToolSettled` | after an executed `tools/call` | Runs `service.trackUsage` and `recordCall`. A failure in either is absorbed and does not affect the other or the response. |

`initialize` and `tools/list` pass even when the usage limit is exceeded; only `tools/call` is denied.

### Caveats

- `extractClientIp` must read only headers set by a trusted proxy (for example the last hop your platform appends). Reading a client-controllable header such as a raw `X-Forwarded-For` lets a caller spoof the IP and bypass the whitelist. When a key has a whitelist and no IP can be determined, the request is rejected.
- `onToolSettled` is not awaited before the response is sent, so `trackUsage` and `recordCall` may be lost on serverless runtimes that freeze after responding. Use your platform's `waitUntil`-style mechanism inside `recordCall` if you cannot lose records.
- Only executed calls are counted. Denied calls and calls with invalid input (rejected by SDK validation before the tool runs) reach neither `trackUsage` nor `recordCall`.

### `responses` options

`createMcpHandler({ responses })` replaces the default bodies: `unauthorized` (401, missing Bearer), `invalidToken` (401, rejected token), `methodNotAllowed` (405 for GET and DELETE) and `forbidden` (the text of a denied `tools/call`).

### Prisma repository, default ports and schema

- `createPrismaApiKeyRepository({ apiKey, userSelect, mapUser })` implements the toolkit `IApiKeyRepository` on top of `prisma.apiKey`. The package depends on a structural `ApiKeyDelegateLike`, not on Prisma types. `userSelect` is the `select` read from the `user` relation by `findByHash`, and `mapUser` converts that row to `{ id, email, isActive, plan }`. Rows with `deletedAt` set are excluded from reads.
- Default ports: `createFixedPlanConfig({ apiKeyLimit, rateLimit })` returns the same limits for every plan, `noopApiKeyCache` never caches, and `noopUsageTracker` always allows.
- `prisma/fragment.prisma` holds the `ApiKey` model. Copy it into your `schema.prisma` (it ships in the package, for example `node_modules/@withwiz/mcp/prisma/fragment.prisma`), rename the `user` relation target to your user model, and add `apiKeys ApiKey[]` to that model. It has no per-call log table; store calls from `recordCall` in your own table.

## License

MIT
