import type { ToolConfig } from './toolProtocol';

export type ToolSettingsPatch = Partial<Pick<ToolConfig, 'sendIntervalSeconds' | 'dirtyPolicy' | 'completionSound' | 'autoCopyResults'>>;
export interface ToolSettingsState { config: ToolConfig; busy: boolean; hasProject: boolean; storageError?: string }
export interface ToolSettingsAnchor { x: number; y: number; width: number; height: number }
export interface ToolSettingsVisibility { open: boolean; restoreFocus: boolean }
