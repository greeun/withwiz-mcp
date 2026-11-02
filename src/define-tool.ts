import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { AnyMcpTool, McpTool } from "./types.js";

/** 도구를 정의한다. input 형상에서 handler 인자 타입이 추론된다. */
export function defineTool<D, Shape extends ZodRawShapeCompat>(tool: McpTool<D, Shape>): AnyMcpTool<D> {
  return tool as unknown as AnyMcpTool<D>;
}
