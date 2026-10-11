/** 官网平台仅接受固定 ID，不接收网页提供的 URL 或分区。 */
export const WEB_PLATFORMS = {
  deepseek: { url: 'https://chat.deepseek.com/', partition: 'persist:postcheck' },
  chatgpt: { url: 'https://chatgpt.com/', partition: 'persist:postcheck-02' },
} as const;

export type WebPlatform = keyof typeof WEB_PLATFORMS;
export interface WebPlatformState { platform: WebPlatform; switching: boolean; error?: string }
