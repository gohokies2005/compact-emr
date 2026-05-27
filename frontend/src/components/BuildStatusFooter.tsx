import { buildInfo } from '../build-info';

export function BuildStatusFooter() {
  return (
    <footer className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 text-xs text-slate-400">
      <span>Compact EMR</span>
      <span>
        {buildInfo.apiMode} · {buildInfo.commitSha.slice(0, 7)}
      </span>
    </footer>
  );
}
