import { useEffect } from 'react';

// iOS Safari ignores overflow:hidden on the body behind a fixed layer, so the
// page is pinned in place while a layer is open and restored on close.
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const scrollY = window.scrollY;
    const { style } = document.body;
    const previous = { position: style.position, top: style.top, width: style.width, overflow: style.overflow };
    style.position = 'fixed';
    style.top = `-${scrollY}px`;
    style.width = '100%';
    style.overflow = 'hidden';
    return () => {
      style.position = previous.position;
      style.top = previous.top;
      style.width = previous.width;
      style.overflow = previous.overflow;
      window.scrollTo({ top: scrollY, left: 0, behavior: 'auto' });
    };
  }, [active]);
}
