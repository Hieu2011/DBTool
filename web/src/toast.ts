import { useSyncExternalStore } from 'react';

export interface Toast { id: number; kind: 'success' | 'error' | 'info'; title: string; text?: string }

let arrToasts: Toast[] = [];
let intNextId = 1;
const hsListeners = new Set<() => void>();

const publish = (arrNext: Toast[]) => {
  arrToasts = arrNext;
  hsListeners.forEach(fnListener => fnListener());
};

export const dismissToast = (intId: number) => publish(arrToasts.filter(objItem => objItem.id !== intId));

/** Popup in the corner of the window. The same message already on screen is not stacked again. */
export function showToast(strKind: Toast['kind'], strTitle: string, strText?: string) {
  if (arrToasts.some(objItem => objItem.kind === strKind && objItem.title === strTitle && objItem.text === strText)) return;
  const intId = intNextId++;
  publish([...arrToasts.slice(-4), { id: intId, kind: strKind, title: strTitle, text: strText }]);
  setTimeout(() => dismissToast(intId), strKind === 'error' ? 10000 : 4000);
}

const subscribe = (fnListener: () => void) => {
  hsListeners.add(fnListener);
  return () => { hsListeners.delete(fnListener); };
};

export const useToasts = () => useSyncExternalStore(subscribe, () => arrToasts);
