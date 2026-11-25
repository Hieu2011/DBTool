import { useLayoutEffect, useState, type RefObject } from 'react';

/** Height of a connection's header: it stays stuck at the top of the sidebar while its tree scrolls under it. */
export const TREE_STICKY_TOP = 36;

/**
 * For a list virtualized inside a scroller it does not own (the sidebar scrolls every connection's tree as one):
 * that scroller (the nearest `data-tree-scroll`) and how far down its content this list starts.
 */
export function useOuterScroll(refList: RefObject<HTMLElement | null>) {
  const [objOuter, setObjOuter] = useState<{ element: HTMLElement; margin: number } | null>(null);
  useLayoutEffect(() => {
    const objList = refList.current;
    const objScroller = objList?.closest<HTMLElement>('[data-tree-scroll]');
    if (!objList || !objScroller) return;
    const measure = () => {
      if (objList.offsetParent === null) return; // hidden (collapsed group): measured again when shown
      const intMargin = Math.round(objList.getBoundingClientRect().top - objScroller.getBoundingClientRect().top + objScroller.scrollTop);
      setObjOuter(objPrev => (objPrev?.element === objScroller && objPrev.margin === intMargin ? objPrev : { element: objScroller, margin: intMargin }));
    };
    measure();
    // Anything above growing or shrinking (another tree opening a folder) moves this list.
    const objObserver = new ResizeObserver(measure);
    if (objScroller.firstElementChild) objObserver.observe(objScroller.firstElementChild);
    objObserver.observe(objList);
    return () => objObserver.disconnect();
  }, [refList]);
  return objOuter;
}
