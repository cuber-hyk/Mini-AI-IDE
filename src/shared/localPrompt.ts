export interface LocalPromptOptions { includeInitialization: boolean; sendOnEnter: boolean }
export interface LocalPromptInput { requirement: string; root: string | null; skills: string[] }
export interface LocalPromptResult { ok: boolean; prompt?: string; length?: number; error?: string; uncertain?: boolean }
