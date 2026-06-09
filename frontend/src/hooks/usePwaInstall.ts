import { useEffect, useState } from 'react';

// Captures the browser's deferred `beforeinstallprompt` event so we can offer an in-app
// "Install Aegis" button. Returns `canInstall:false` until the browser actually fires the event
// (Chromium only, served over HTTPS, not already installed) and also stays false once the app is
// running in standalone display mode (already installed / launched from the home screen).
export function usePwaInstall(): { canInstall: boolean; promptInstall: () => void } {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // If we're already running as an installed PWA, never offer install.
    const isStandalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      // iOS Safari legacy flag.
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (isStandalone) return;

    const onBeforeInstall = (event: BeforeInstallPromptEvent) => {
      event.preventDefault();
      setDeferred(event);
    };
    const onInstalled = () => setDeferred(null);

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = () => {
    if (!deferred) return;
    void deferred.prompt();
    void deferred.userChoice.finally(() => setDeferred(null));
  };

  return { canInstall: deferred !== null, promptInstall };
}
