import { useRef, useState } from 'react';
import { ContextMenu, type MenuItem } from './ContextMenu';

export interface MenuDef { label: string; items: MenuItem[] }

/** The application menu (File, Edit...) across the top of the window. */
export function MenuBar({ arrMenus }: { arrMenus: MenuDef[] }) {
  const [objOpen, setObjOpen] = useState<{ index: number; x: number; y: number } | null>(null);
  // A click on the open menu's own label closes it: the menu's outside-click handler runs first, so remember what it closed.
  const refClosed = useRef<{ index: number; at: number } | null>(null);

  const openAt = (intIndex: number, objButton: HTMLElement) => {
    const objRect = objButton.getBoundingClientRect();
    setObjOpen({ index: intIndex, x: objRect.left, y: objRect.bottom + 2 });
  };

  const close = () => setObjOpen(objPrev => {
    if (objPrev) refClosed.current = { index: objPrev.index, at: Date.now() };
    return null;
  });

  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line bg-bg px-1.5 text-[13px]" role="menubar">
      {arrMenus.map((objMenu, intIndex) => (
        <button key={objMenu.label} role="menuitem" aria-haspopup="menu" aria-expanded={objOpen?.index === intIndex}
          className={`h-6 rounded px-2.5 ${objOpen?.index === intIndex ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg'}`}
          onClick={objEvent => {
            const objClosed = refClosed.current;
            if (objClosed && objClosed.index === intIndex && Date.now() - objClosed.at < 300) return;
            openAt(intIndex, objEvent.currentTarget);
          }}
          // With one menu open, moving along the bar opens the others, as menus do.
          onPointerEnter={objEvent => { if (objOpen && objOpen.index !== intIndex) openAt(intIndex, objEvent.currentTarget); }}>
          {objMenu.label}
        </button>
      ))}
      {objOpen && (
        <ContextMenu key={objOpen.index} intX={objOpen.x} intY={objOpen.y} arrItems={arrMenus[objOpen.index].items} onClose={close} />
      )}
    </div>
  );
}
