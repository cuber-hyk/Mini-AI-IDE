/** 本地编辑器、官方网页、变更列表的几何；不持有 Electron 或文件能力。 */
export const EDITOR_MIN_WIDTH = 360;
export const WEB_MIN_WIDTH = 420;
export const PREVIEW_MIN_WIDTH = 260;
export const PREVIEW_DEFAULT_WIDTH = 300;
export const WEB_BAR_HEIGHT = 40;
export const WORKSPACE_DEFAULT_WIDTH = 240;
export const FILE_DEFAULT_WIDTH = 700;
export const TREE_DEFAULT_WIDTH = 190;
export const FILE_HEADER_HEIGHT = 36;
export const TREE_HEADER_HEIGHT = 108;
export const DOCK_DEFAULT_HEIGHT = 100;

export interface WorkspaceLayoutOptions {
  workspaceWidth?: number;
  workspaceVisible?: boolean;
  fileWidth?: number;
  fileVisible?: boolean;
  treeWidth?: number;
  treeVisible?: boolean;
  dockHeight?: number;
  previewVisible?: boolean;
  toolsVisible?: boolean;
  fileMaximized?: boolean;
}

interface Bounds { x: number; y: number; width: number; height: number }
export interface Layout {
  editorBounds: Bounds;
  workspaceBounds: Bounds;
  fileBounds: Bounds;
  contentBounds: Bounds;
  treeBounds: Bounds;
  treePaneBounds: Bounds;
  dockBounds: Bounds;
  webBounds: Bounds;
  webBarBounds: Bounds;
  previewBounds: Bounds;
  dividerX: number;
  workspaceVisible: boolean;
  fileVisible: boolean;
  treeVisible: boolean;
  previewVisible: boolean;
  toolsVisible: boolean;
  workspaceWidth: number;
  fileWidth: number;
  treeWidth: number;
  dockHeight: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
const rounded = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? Math.round(value) : fallback;

export function computeLayout(
  width: number, height: number, options: WorkspaceLayoutOptions = {},
): Layout {
  const w = Math.max(0, rounded(width, 0));
  const h = Math.max(0, rounded(height, 0));
  const workspaceVisible = options.workspaceVisible !== false;
  const fileVisible = options.fileVisible !== false;
  const maximized = fileVisible && options.fileMaximized === true;
  const treeVisible = fileVisible && options.treeVisible !== false;
  const toolsVisible = fileVisible && options.toolsVisible === true;
  const previewVisible = fileVisible && !toolsVisible && options.previewVisible === true;
  // 窄窗口优先保护 AI 与编辑正文；极小窗口同比缩减下限。
  const workspaceMinimum = workspaceVisible ? 120 : 0;
  const fileMinimum = fileVisible ? EDITOR_MIN_WIDTH : 0;
  const scale = Math.min(1, w / (workspaceMinimum + (maximized ? 0 : WEB_MIN_WIDTH) + fileMinimum));
  const minWorkspace = Math.floor(workspaceMinimum * scale);
  const minFile = Math.floor(fileMinimum * scale);
  const minWeb = maximized ? 0 : Math.floor(WEB_MIN_WIDTH * scale);
  const workspaceWidth = workspaceVisible
    ? clamp(rounded(options.workspaceWidth, WORKSPACE_DEFAULT_WIDTH), minWorkspace, w - minFile - minWeb)
    : 0;
  const fileWidth = fileVisible
    ? clamp((maximized ? w : rounded(options.fileWidth, FILE_DEFAULT_WIDTH)), minFile, w - workspaceWidth - minWeb)
    : minFile;
  const centerWidth = w - workspaceWidth - fileWidth;
  const fileX = workspaceWidth + centerWidth;
  const barH = Math.min(WEB_BAR_HEIGHT, h);
  const bodyHeight = h - barH;
  const dockHeight = maximized ? 0 : clamp(rounded(options.dockHeight, DOCK_DEFAULT_HEIGHT), 0, bodyHeight - Math.min(120, Math.floor(bodyHeight / 2)));
  const webHeight = maximized ? 0 : bodyHeight - dockHeight;
  const headerHeight = Math.min(FILE_HEADER_HEIGHT, h);
  const treeHeaderHeight = Math.min(TREE_HEADER_HEIGHT, h);
  const treeWidth = treeVisible
    ? clamp(rounded(options.treeWidth, TREE_DEFAULT_WIDTH), Math.min(120, Math.max(0, fileWidth - 240)), Math.max(0, fileWidth - 240))
    : 0;
  const contentBounds = {
    x: fileX, y: headerHeight, width: fileVisible ? fileWidth - treeWidth : 0,
    height: fileVisible ? h - headerHeight : 0,
  };
  return {
    editorBounds: { x: 0, y: 0, width: w, height: h },
    workspaceBounds: { x: 0, y: 0, width: workspaceWidth, height: h },
    webBarBounds: { x: workspaceWidth, y: 0, width: centerWidth, height: barH },
    webBounds: { x: workspaceWidth, y: barH, width: centerWidth, height: webHeight },
    dockBounds: { x: workspaceWidth, y: barH + webHeight, width: centerWidth, height: dockHeight },
    fileBounds: { x: fileX, y: 0, width: fileWidth, height: h },
    contentBounds,
    treePaneBounds: { x: fileX + fileWidth - treeWidth, y: 0, width: treeWidth, height: treeWidth > 0 ? h : 0 },
    treeBounds: { x: fileX + fileWidth - treeWidth, y: treeHeaderHeight, width: treeWidth, height: treeWidth > 0 ? h - treeHeaderHeight : 0 },
    previewBounds: previewVisible ? { ...contentBounds } : { x: fileX, y: headerHeight, width: 0, height: 0 },
    dividerX: fileX,
    workspaceVisible,
    fileVisible,
    treeVisible,
    previewVisible,
    toolsVisible,
    workspaceWidth,
    fileWidth,
    treeWidth,
    dockHeight,
  };
}
