import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type MenuItem =
  | { kind: 'separator' }
  | { kind: 'header'; label: string }
  | { kind?: 'item'; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onSelect?: () => void;
    /** A submenu: opens beside the item while the pointer is on it (the item itself then does nothing). */
    items?: MenuItem[];
    /** Keyboard shortcut shown at the right, e.g. Ctrl+S. */
    hint?: string };

interface Props {
  intX: number;
  intY: number;
  arrItems: MenuItem[];
  onClose: () => void;
}

const PANEL = 'min-w-48 rounded-md border border-line bg-raised py-1 text-[13px] shadow-xl';

/** The rows of one menu panel; an item with `items` carries its own panel. */
function MenuRows({ arrItems, onClose, boolFlip, boolUp }: { arrItems: MenuItem[]; onClose: () => void; boolFlip: boolean; boolUp: boolean }) {
  const [intOpen, setIntOpen] = useState<number | null>(null);
  return (
    <>
      {arrItems.map((objItem, intIndex) => {
        if (objItem.kind === 'separator') return <div key={intIndex} className="my-1 h-px bg-line" role="separator" />;
        if (objItem.kind === 'header') {
          return (
            <div key={intIndex} className="px-3 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              {objItem.label}
            </div>
          );
        }
        const boolSub = !!objItem.items && !objItem.disabled;
        return (
          <div key={intIndex} className="relative" onMouseEnter={() => setIntOpen(boolSub ? intIndex : null)}
            onMouseLeave={() => setIntOpen(intPrev => (intPrev === intIndex ? null : intPrev))}>
            <button role="menuitem" disabled={objItem.disabled} aria-haspopup={boolSub ? 'menu' : undefined} aria-expanded={boolSub ? intOpen === intIndex : undefined}
              onClick={() => { if (boolSub) return setIntOpen(intIndex); onClose(); objItem.onSelect?.(); }}
              className={`flex w-full items-center gap-2.5 px-3 py-1 text-left hover:bg-hover disabled:opacity-40 ${
                objItem.danger ? 'text-danger' : ''} ${intOpen === intIndex ? 'bg-hover' : ''}`}>
              <span className="flex w-4 justify-center text-muted">{objItem.icon}</span>
              <span className="whitespace-nowrap">{objItem.label}</span>
              {objItem.hint && <span className="ml-auto whitespace-nowrap pl-8 text-[11.5px] text-muted">{objItem.hint}</span>}
              {objItem.items && <span className="ml-auto pl-6 text-[10px] text-muted">▶</span>}
            </button>
            {boolSub && intOpen === intIndex && (
              <div role="menu" className={`absolute z-10 ${PANEL} ${boolFlip ? 'right-full' : 'left-full'} ${boolUp ? 'bottom-0' : '-top-1'}`}>
                <MenuRows arrItems={objItem.items!} onClose={onClose} boolFlip={boolFlip} boolUp={boolUp} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Right-click menu at a screen position. Closes on a pick, an outside click, Escape, scroll or resize. */
export function ContextMenu({ intX, intY, arrItems, onClose }: Props) {
  const refMenu = useRef<HTMLDivElement>(null);
  const [objPosition, setObjPosition] = useState({ left: intX, top: intY });

  // Keep the whole menu on screen: flip it to the other side of the pointer when it would overflow.
  useLayoutEffect(() => {
    const objRect = refMenu.current?.getBoundingClientRect();
    if (!objRect) return;
    setObjPosition({
      left: intX + objRect.width > window.innerWidth - 4 ? Math.max(4, intX - objRect.width) : intX,
      top: intY + objRect.height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - objRect.height - 4) : intY,
    });
  }, [intX, intY, arrItems]);

  useEffect(() => {
    const onPointerDown = (objEvent: PointerEvent) => {
      if (!refMenu.current?.contains(objEvent.target as Node)) onClose();
    };
    const onKeyDown = (objEvent: KeyboardEvent) => {
      if (objEvent.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    window.addEventListener('wheel', onClose, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('wheel', onClose, true);
    };
  }, [onClose]);

  return (
    <div ref={refMenu} role="menu" style={objPosition} onContextMenu={objEvent => objEvent.preventDefault()}
      className={`fixed z-50 ${PANEL}`}>
      {/* submenus open to the left / upwards when the menu sits near the right / bottom edge (two levels deep) */}
      <MenuRows arrItems={arrItems} onClose={onClose} boolFlip={objPosition.left > window.innerWidth - 560} boolUp={objPosition.top > window.innerHeight - 260} />
    </div>
  );
}
