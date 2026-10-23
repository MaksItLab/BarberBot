/**
 * U04: the on-screen keyboard shrinks only the visual viewport (Chrome 108+, iOS; `interactive-widget`
 * has no effect in a WebView). When the field being edited ends up under the keyboard, bring it back into
 * view. Nothing is done while the field is visible, so the WebView's own scrolling is not fought.
 */
const editable = 'input:not([type=checkbox]):not([type=radio]), textarea, select';
const margin = 12;

function revealFocused() {
  const viewport = window.visualViewport;
  const field = document.activeElement;
  if (!viewport || !(field instanceof HTMLElement) || !field.matches(editable)) return;
  const box = field.getBoundingClientRect();
  const top = viewport.offsetTop + margin, bottom = viewport.offsetTop + viewport.height - margin;
  if (box.top >= top && box.bottom <= bottom) return;
  // Up for a field below the visible area, down for one above it; the field is at most as tall as the area.
  window.scrollBy(0, box.bottom > bottom ? Math.min(box.bottom - bottom, box.top - top) : box.top - top);
}

/** Keeps the focused field visible when the keyboard opens or the visible area changes. Returns the undo. */
export function keepFocusedFieldVisible(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  // The keyboard animates; the last resize event is the settled size.
  let frame = 0;
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(revealFocused); };
  viewport.addEventListener('resize', schedule);
  return () => { cancelAnimationFrame(frame); viewport.removeEventListener('resize', schedule); };
}
