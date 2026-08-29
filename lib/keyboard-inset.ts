// iOS never resizes the layout viewport for the on-screen keyboard, so fixed
// sheets and dialogs must learn the keyboard height from the visual viewport
// and reserve space above it via the --keyboard-inset custom property.
export function trackKeyboardInset(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const update = () => {
    // Sheets are positioned against the layout viewport, so measure the overlap
    // from the same box rather than from window.innerHeight, which counts the
    // area behind Safari's toolbars on iOS.
    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    const overlap = Math.round(layoutHeight - viewport.height - viewport.offsetTop);
    // Small differences come from browser chrome, not a keyboard.
    const inset = overlap > 60 ? overlap : 0;
    document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
}
