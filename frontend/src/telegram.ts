type StorageCallback<T> = (error: string | null, value?: T) => void;
/** Bot API 9.0: up to 5 MB per user on the device itself, never synced to Telegram servers. */
export type TelegramDeviceStorage = {
  setItem: (key: string, value: string, callback?: StorageCallback<boolean>) => void;
  getItem: (key: string, callback: StorageCallback<string>) => void;
  removeItem: (key: string, callback?: StorageCallback<boolean>) => void;
};

type TelegramWebApp = {
  initData?: string;
  isVersionAtLeast?: (version: string) => boolean;
  DeviceStorage?: TelegramDeviceStorage;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  ready: () => void;
  expand: () => void;
  colorScheme: 'light' | 'dark';
  BackButton?: { show: () => void; hide: () => void; onClick: (callback: () => void) => void; offClick: (callback: () => void) => void };
  onEvent: (event: 'themeChanged', callback: () => void) => void;
  offEvent: (event: 'themeChanged', callback: () => void) => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

// Same launch parameter consumed by Telegram's SDK. Keep it in memory across SPA navigation.
// This is untrusted input; only the server may validate it and assign a role.
const launchParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
const launchInitData = launchParams.get('tgWebAppData') || undefined;
export const hasTelegramLaunch = launchParams.has('tgWebAppPlatform') || launchParams.has('tgWebAppData');
export function getTelegramInitData(): string | undefined {
  return window.Telegram?.WebApp?.initData || launchInitData;
}

export function connectBackButton(visible: boolean, callback: () => void): () => void {
  const button = window.Telegram?.WebApp?.BackButton;
  if (!button) return () => {};
  if (visible) { button.show(); button.onClick(callback); }
  else button.hide();
  return () => { button.offClick(callback); button.hide(); };
}

export function connectTelegram(): () => void {
  const webApp = window.Telegram?.WebApp;
  if (!webApp) return () => {};
  const updateTheme = () => {
    document.documentElement.dataset.theme = webApp.colorScheme;
  };
  updateTheme();
  webApp.ready();
  webApp.expand();
  webApp.onEvent('themeChanged', updateTheme);
  return () => webApp.offEvent('themeChanged', updateTheme);
}

/** Asks before closing the Mini App while a form has unsaved changes (Bot API 6.2+). Returns the undo. */
export function confirmClosing(): () => void {
  const webApp = window.Telegram?.WebApp;
  if (!webApp?.enableClosingConfirmation || !webApp.isVersionAtLeast?.('6.2')) return () => {};
  webApp.enableClosingConfirmation();
  return () => webApp.disableClosingConfirmation?.();
}
