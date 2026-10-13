import type { ToolRequest } from './toolProtocol';

export const MAX_MANUAL_TOOL_JSON_LENGTH = 200_000;
export type ManualToolJsonPreview = { ok: true; token: string; batch_id: string; project: string; requests: ToolRequest[] } | { ok: false; error: string };
export type ManualToolJsonExecution = { ok: boolean; error?: string };
