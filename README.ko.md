# @withwiz/mcp

withwiz 앱을 위한 표준 MCP 서버 연결과 인증 패키지입니다. 도구는 각 앱이 직접 제공하며, 이 패키지는 도구를 서비스하는 방식과 호출 권한을 고정합니다.

## 빠른 시작

```bash
pnpm add @withwiz/mcp @modelcontextprotocol/sdk zod
```

```ts
// app/api/mcp/route.ts (Next.js)
// `db`, `findToken`, `toErrorResult`, `withRateLimit` 는 앱이 직접 구현하는 함수이며 이 패키지에 없다.
import { z } from "zod";
import { createMcpHandler, defineTool } from "@withwiz/mcp";

const listPosts = defineTool({
  name: "list_posts",
  description: "글 목록 조회",
  action: "READ",
  input: { limit: z.number().int().max(50).optional() },
  async handler({ limit }, { principal }) {
    return await db.posts.list({ userId: principal.userId, limit });
  },
});

const handler = createMcpHandler({
  server: { name: "my-app", version: "1.0.0" },
  tools: [listPosts],
  // 토큰 원문을 받는 유일한 지점이다. 유효하지 않으면 null 을 반환한다.
  async authenticate(rawToken) {
    const token = await findToken(rawToken);
    return token
      ? { userId: token.userId, tokenId: token.id, actions: token.actions }
      : null;
  },
  // 오류 변환은 앱 책임이다: { status: number; body: unknown } 를 반환하고 5xx 상세는 여기서 숨긴다.
  mapError: (error) => toErrorResult(error),
});

export const { POST, GET, DELETE } = handler;
```

클라이언트 연결:

```bash
claude mcp add --transport http my-app https://example.com/api/mcp \
  --header "Authorization: Bearer <token>"
```

## 고정 동작

- stateless Streamable HTTP: 요청마다 전송과 서버를 새로 만들고, 끝나면 닫습니다.
- POST 만 받습니다. GET 과 DELETE 는 `Allow: POST` 와 함께 405 를 반환합니다.
- Bearer 만 받습니다. 쿠키는 읽지 않으며 `Authorization: Bearer` 가 유일한 자격 증명입니다.
- 권한은 HTTP 메서드가 아니라 도구별 `action`(`READ`, `WRITE`, `DELETE`)을 `principal.actions` 와 대조해 판정합니다.
- `authorize` 는 fail-closed 입니다. 거부하거나 예외가 나면 호출이 차단됩니다. 지정하지 않으면 `principal.actions` 로 판정하며, 도구의 `action` 이 목록에 없거나 `actions` 가 없으면 거부합니다.
- 실패는 프로토콜 오류가 아니라 `isError` 도구 결과로 반환합니다.
- 클라이언트에게 보이는 오류 형태는 `mapError` 가 정합니다. 5xx 상세를 숨기는 일은 여기서 합니다. 원본 예외는 노출되지 않습니다.
- 훅(`authorize`, `runTool`, `onToolSettled`)은 principal 만 받고 토큰 원문은 받지 않습니다.
- `onToolSettled` 안에서 난 실패는 흡수되며 응답에 영향을 주지 않습니다.

## 이 동작들이 막는 함정

- MCP 엔드포인트의 GET 은 이벤트가 오지 않는 SSE 스트림을 열어 클라이언트를 멈추게 합니다. 그래서 GET 은 405 로 응답합니다.
- 쿠키 세션을 받으면 브라우저 요청이 토큰 범위를 우회할 수 있습니다. 그래서 Bearer 토큰만 받습니다.
- MCP 트래픽은 전부 POST 라서 HTTP 메서드 기반 권한으로는 읽기와 쓰기를 구분하지 못합니다. 그래서 도구의 `action` 으로 판정합니다.
- 닫히지 않은 서버 인스턴스는 요청마다 자원을 누수시킵니다. 그래서 요청이 끝나면 매번 닫습니다.

## rate limit

WRITE 나 DELETE 도구를 노출하는 라우트에는 rate limit 이 필수입니다. 핸들러가 처리하지 않으므로 바깥에서 감쌉니다.

```ts
export const POST = (request: Request) =>
  withRateLimit(request, () => handler.POST(request));
```

## API 키 (`@withwiz/mcp/tokens`)

`@withwiz/toolkit`(`>=0.13`, 선택적 peer)의 API 키 코어를 핸들러 단계에 연결하는 선택 진입점입니다. `@withwiz/mcp` 본체는 toolkit 을 import 하지 않습니다.

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

// `prisma`, `env`, `getTrustedClientIp`, `saveCall` 은 앱이 정의합니다.
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
  usage: noopUsageTracker,            // 선택: tools/call 직전에 사용량 한도 확인
  extractClientIp: getTrustedClientIp, // 선택: 키의 IP 화이트리스트를 검사하려면 필요
  recordCall: saveCall,                // 선택: 실행된 호출마다 1건 저장
});

export const { POST, GET, DELETE } = createMcpHandler({
  server: { name: "my-app", version: "1.0.0" },
  tools,
  ...auth,
  responses: { unauthorized: { error: "..." }, invalidToken: { error: "..." }, forbidden: "..." },
});
```

### 단계

| 단계 | 실행 시점 | 하는 일 |
| --- | --- | --- |
| `authenticate` | 모든 POST | 키를 검증하고(`validateApiKey`) IP 화이트리스트를 검사합니다. 키가 무효·비활성·만료이거나 IP 가 허용되지 않으면 `null` 을 반환합니다. |
| `authorize` | `tools/call` | 키의 `permissions` 를 도구의 `action` 과 대조하고(`read`/`write`/`delete` 가 `READ`/`WRITE`/`DELETE` 에 대응), `usage` 가 있으면 사용량 한도를 확인합니다. |
| `onToolSettled` | 실행된 `tools/call` 이 끝난 뒤 | `service.trackUsage` 와 `recordCall` 을 실행합니다. 둘 중 하나가 실패해도 흡수되며 다른 쪽과 응답에 영향을 주지 않습니다. |

사용량 한도를 넘겨도 `initialize` 와 `tools/list` 는 통과하고 `tools/call` 만 거부됩니다.

### 주의 사항

- `extractClientIp` 는 신뢰하는 프록시가 설정한 헤더만 읽어야 합니다(예: 플랫폼이 마지막에 덧붙이는 값). 원본 `X-Forwarded-For` 처럼 클라이언트가 바꿀 수 있는 헤더를 읽으면 호출자가 IP 를 위조해 화이트리스트를 우회할 수 있습니다. 키에 화이트리스트가 있는데 IP 를 알 수 없으면 요청을 거부합니다.
- `onToolSettled` 는 응답을 보내기 전에 await 되지 않으므로, 응답 직후 실행을 멈추는 서버리스 런타임에서는 `trackUsage` 와 `recordCall` 이 유실될 수 있습니다. 기록을 잃으면 안 된다면 `recordCall` 안에서 플랫폼의 `waitUntil` 계열 기능을 사용합니다.
- 실행된 호출만 집계합니다. 거부된 호출과, 도구 실행 전에 SDK 검증에서 걸러진 입력 오류 호출은 `trackUsage` 와 `recordCall` 어디에도 닿지 않습니다.

### `responses` 옵션

`createMcpHandler({ responses })` 로 기본 응답 본문을 바꿉니다. `unauthorized`(401, Bearer 없음), `invalidToken`(401, 거부된 토큰), `methodNotAllowed`(GET 과 DELETE 의 405), `forbidden`(거부된 `tools/call` 의 문구)를 지정할 수 있습니다.

### Prisma 저장소, 기본 포트, 스키마

- `createPrismaApiKeyRepository({ apiKey, userSelect, mapUser })` 는 `prisma.apiKey` 위에서 toolkit 의 `IApiKeyRepository` 를 구현합니다. 패키지는 Prisma 타입이 아니라 구조적 타입 `ApiKeyDelegateLike` 에 의존합니다. `userSelect` 는 `findByHash` 가 `user` relation 에서 읽는 `select` 이고, `mapUser` 는 그 행을 `{ id, email, isActive, plan }` 으로 변환합니다. `deletedAt` 이 있는 행은 조회에서 제외합니다.
- 기본 포트: `createFixedPlanConfig({ apiKeyLimit, rateLimit })` 는 모든 플랜에 같은 한도를 반환하고, `noopApiKeyCache` 는 캐시하지 않으며, `noopUsageTracker` 는 항상 허용합니다.
- `prisma/fragment.prisma` 에 `ApiKey` 모델이 들어 있습니다. 앱의 `schema.prisma` 에 복사하고(패키지에 포함되어 있습니다. 예: `node_modules/@withwiz/mcp/prisma/fragment.prisma`), `user` relation 의 대상을 앱의 사용자 모델로 바꾸고, 그 모델에 `apiKeys ApiKey[]` 를 추가합니다. 호출별 기록 표는 없으므로 `recordCall` 에서 앱의 표에 저장합니다.

## 라이선스

MIT
