import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnyMcpTool, McpErrorResult, McpPrincipal, McpServerOptions } from "./types.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const DEFAULT_FORBIDDEN = { error: "Forbidden" };
const DEFAULT_ERROR: McpErrorResult = { status: 500, body: { error: "Internal error" } };

function text(value: unknown, isError: boolean): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text: JSON.stringify(value ?? null) }] };
  if (isError) result.isError = true;
  return result;
}

/** 도구 단위 인가. 판정기가 없으면 principal.actions 로만 허용하고, 둘 다 없으면 거부한다. */
async function isAllowed<D>(
  options: McpServerOptions<D>,
  principal: McpPrincipal<D>,
  tool: AnyMcpTool<D>,
): Promise<boolean> {
  if (options.authorize) return options.authorize(principal, tool);
  return principal.actions?.includes(tool.action) ?? false;
}

export function buildMcpServer<D>(
  tools: AnyMcpTool<D>[],
  options: McpServerOptions<D>,
  principal: McpPrincipal<D>,
): McpServer {
  const server = new McpServer({ name: options.server.name, version: options.server.version });

  const settle = (tool: AnyMcpTool<D>, status: number, error?: unknown) => {
    try {
      // async 훅의 reject 도 흡수한다(unhandled rejection 방지).
      void Promise.resolve(options.onToolSettled?.({ tool, principal, status, error })).catch(() => {});
    } catch {
      // 기록 훅 실패가 도구 결과를 바꾸지 않는다.
    }
  };

  const execute = async (tool: AnyMcpTool<D>, args: unknown): Promise<ToolResult> => {
    try {
      if (!(await isAllowed(options, principal, tool))) {
        settle(tool, 403);
        return text(options.responses?.forbidden ?? DEFAULT_FORBIDDEN, true);
      }
      const run = () => tool.handler(args as never, { principal });
      const result = options.runTool ? await options.runTool(principal, tool, run) : await run();
      const serialized = text(result, false);
      settle(tool, 200);
      return serialized;
    } catch (error) {
      let mapped = DEFAULT_ERROR;
      try {
        if (options.mapError) mapped = options.mapError(error);
      } catch {
        // mapError 자체가 실패하면 기본 500 으로 수렴한다.
      }
      settle(tool, mapped.status, error);
      return text(mapped.body, true);
    }
  };

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
      (async (args: unknown) => execute(tool, args)) as never,
    );
  }
  return server;
}
