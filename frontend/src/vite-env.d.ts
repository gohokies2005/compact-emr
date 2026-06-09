/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Not yet in the standard DOM lib — fired before the browser shows its install prompt.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}
interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent;
}
