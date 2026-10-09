export interface LocalPromptOptions { includeInitialization: boolean }
export interface PromptAttachment { id: string; name: string; size: number; mediaType: string }
export interface PromptAttachmentData extends PromptAttachment { stream: () => AsyncIterable<Uint8Array> }
export interface LocalPromptInput { requirement: string; root: string | null; skills: string[]; attachments?: string[] }
export interface LocalPromptResult { ok: boolean; length?: number; error?: string; uncertain?: boolean }
