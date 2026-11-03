import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "./build-server.js";
import type { AnyMcpTool, McpPrincipal, McpServerOptions } from "./types.js";

export interface McpHandlerOptions<D = unknown> extends McpServerOptions<D> {
  tools: AnyMcpTool<D>[];
  /** 토큰 원문을 받는 유일한 지점이다. 유효하지 않으면 null. */
  authenticate(rawToken: string, request: Request): McpPrincipal<D> | null | Promise<McpPrincipal<D> | null>;
  responses?: McpServerOptions<D>["responses"] & {
    unauthorized?: unknown;
    invalidToken?: unknown;
    methodNotAllowed?: unknown;
  };
}

const BEARER = /^Bearer\s+(\S+)$/i;

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function createMcpHandler<D>(options: McpHandlerOptions<D>) {
  const { tools, authenticate, responses, ...serverOptions } = options;

  const methodNotAllowed = () =>
    json(responses?.methodNotAllowed ?? { error: "Method not allowed" }, 405, { allow: "POST" });

  return {
    async POST(request: Request): Promise<Response> {
      // 쿠키 세션은 받지 않는다: Authorization Bearer 만 읽는다.
      const match = BEARER.exec(request.headers.get("authorization") ?? "");
      if (!match) return json(responses?.unauthorized ?? { error: "Unauthorized" }, 401);

      let principal: McpPrincipal<D> | null;
      try {
        principal = await authenticate(match[1], request);
      } catch {
        return json({ error: "Internal error" }, 500);
      }
      if (!principal) return json(responses?.invalidToken ?? { error: "Invalid token" }, 401);

      // stateless: 요청마다 전송과 서버를 새로 만들고 끝나면 닫는다.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = buildMcpServer(tools, { ...serverOptions, responses }, principal);
      try {
        await server.connect(transport);
        return await transport.handleRequest(request);
      } finally {
        await server.close();
      }
    },
    GET: methodNotAllowed,
    DELETE: methodNotAllowed,
  };
}
