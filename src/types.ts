import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

export type McpAction = "READ" | "WRITE" | "DELETE";

export interface McpPrincipal<D = unknown> {
  userId: string;
  tokenId: string;
  actions?: McpAction[];
  data?: D;
}

export interface McpToolContext<D = unknown> {
  principal: McpPrincipal<D>;
}

/** input 형상에서 추론한 핸들러 인자 타입(zod 3·4 공통). */
export type McpToolArgs<Shape extends ZodRawShapeCompat> = Parameters<ToolCallback<Shape>>[0];

export interface McpTool<D, Shape extends ZodRawShapeCompat> {
  name: string;
  description: string;
  action: McpAction;
  /** 액션은 WRITE 여도 조회만 하는 도구 표시(사용 기록 판단은 앱 몫). */
  readOnly?: boolean;
  /** 입력이 없으면 `{}`. */
  input: Shape;
  annotations?: ToolAnnotations;
  handler(args: McpToolArgs<Shape>, ctx: McpToolContext<D>): Promise<unknown>;
}

/** 입력 타입을 지운, 배열에 담기 위한 도구 타입. */
export type AnyMcpTool<D = unknown> = McpTool<D, ZodRawShapeCompat>;

export interface McpErrorResult {
  status: number;
  body: unknown;
}

export interface McpToolSettled<D = unknown> {
  tool: AnyMcpTool<D>;
  principal: McpPrincipal<D>;
  status: number;
  /** 원본 예외(응답에는 노출되지 않는다). */
  error?: unknown;
}

export interface McpServerOptions<D = unknown> {
  server: { name: string; version: string };
  authorize?(principal: McpPrincipal<D>, tool: AnyMcpTool<D>): boolean | Promise<boolean>;
  runTool?(principal: McpPrincipal<D>, tool: AnyMcpTool<D>, execute: () => Promise<unknown>): Promise<unknown>;
  mapError?(error: unknown): McpErrorResult;
  onToolSettled?(event: McpToolSettled<D>): void;
  responses?: { forbidden?: unknown };
}
