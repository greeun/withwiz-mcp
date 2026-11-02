# @withwiz/mcp

withwiz 앱을 위한 표준 MCP 서버 연결과 인증 패키지입니다. 도구는 각 앱이 직접 제공하며, 이 패키지는 도구를 서비스하는 방식과 호출 권한을 고정합니다.

## 빠른 시작

```bash
pnpm add @withwiz/mcp @modelcontextprotocol/sdk zod
```

```ts
// app/api/mcp/route.ts (Next.js)
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
  // 오류 변환은 앱 책임이다: 5xx 상세는 여기서 숨긴다.
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
- `authorize` 는 fail-closed 입니다. 거부하거나 예외가 나면 호출이 차단됩니다.
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

## 라이선스

MIT
