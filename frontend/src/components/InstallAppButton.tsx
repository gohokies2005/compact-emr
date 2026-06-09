import { Download } from 'lucide-react';
import { Button } from './ui/Button';
import { usePwaInstall } from '../hooks/usePwaInstall';

// "Install Aegis" affordance for the top bar. Renders nothing until the browser fires
// `beforeinstallprompt` (and never when already running standalone), so it stays invisible on
// platforms/sessions where install isn't available — zero layout impact in those cases.
export function InstallAppButton() {
  const { canInstall, promptInstall } = usePwaInstall();
  if (!canInstall) return null;
  return (
    <Button variant="ghost" size="sm" onClick={promptInstall} title="Install Aegis as an app">
      <Download size={16} /> Install Aegis
    </Button>
  );
}
