import { dismissToast, useToasts } from '../toast';
import { IconCheck, IconClose, IconInfo } from './icons';

const COLOR = { success: 'var(--success)', error: 'var(--danger)', info: 'var(--accent)' };

/** Popups of `showToast`, stacked in the bottom right corner. */
export function Toaster() {
  const arrToasts = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
      {arrToasts.map(objToast => (
        <div key={objToast.id} role={objToast.kind === 'error' ? 'alert' : 'status'}
          className="toast pointer-events-auto flex items-start gap-2.5 rounded-md border border-line bg-raised py-2.5 pl-3 pr-1.5 shadow-xl"
          style={{ borderLeft: `3px solid ${COLOR[objToast.kind]}` }}>
          <span className="mt-0.5" style={{ color: COLOR[objToast.kind] }}>
            {objToast.kind === 'success' ? <IconCheck /> : <IconInfo />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{objToast.title}</div>
            {objToast.text && <div className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-xs text-muted select-text">{objToast.text}</div>}
          </div>
          <button className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => dismissToast(objToast.id)}>
            <IconClose intSize={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
