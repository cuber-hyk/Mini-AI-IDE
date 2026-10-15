/** 本地只读附件预览的类型分流与 IPC 结果。 */
export type FilePreviewKind = 'image' | 'pdf' | 'docx' | 'unsupported';

export interface FilePreviewZoom { direction: 'in' | 'out'; x: number; y: number }

export function filePreviewKind(filePath: string): FilePreviewKind | null {
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
  if (extension && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return 'image';
  if (extension === 'pdf' || extension === 'docx') return extension;
  if (extension === 'doc') return 'unsupported';
  return null;
}

export type FilePreviewResult =
  | { ok: true; kind: 'image' | 'pdf' | 'docx'; mimeType: string; bytes: Uint8Array; relPath: string }
  | { ok: false; error: string };

export const FILE_PREVIEW_BYTE_LIMIT = 32 * 1024 * 1024;
export const DOCUMENT_PREVIEW_BYTE_LIMIT = 128 * 1024 * 1024;
export const DOCX_EXPANDED_BYTE_LIMIT = 100 * 1024 * 1024;
export const DOCX_ENTRY_LIMIT = 5_000;
