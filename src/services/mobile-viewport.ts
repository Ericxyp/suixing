export const SUIXING_KEYBOARD_INSET_VAR = '--suixing-keyboard-inset';
export const SHEET_SCROLL_LOCK_QUERY = '(max-width: 899px)';
export const SHEET_SCROLL_LOCK_CLASS = 'suixing-sheet-scroll-lock';

export interface VisualViewportLike {
  height: number;
  offsetTop: number;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export interface WindowLike {
  innerHeight: number;
  visualViewport?: VisualViewportLike | null;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  matchMedia?: (query: string) => { matches: boolean };
  scrollY?: number;
  scrollTo?: (x: number, y: number) => void;
}

/** Keyboard occlusion height in CSS pixels. Safe when visualViewport is missing. */
export function computeKeyboardInsetPx(
  win: Pick<WindowLike, 'innerHeight' | 'visualViewport'> | null | undefined,
): number {
  if (!win || typeof win.innerHeight !== 'number') {
    return 0;
  }
  const viewport = win.visualViewport;
  if (!viewport || typeof viewport.height !== 'number') {
    return 0;
  }
  const offsetTop = typeof viewport.offsetTop === 'number' ? viewport.offsetTop : 0;
  return Math.max(0, win.innerHeight - viewport.height - offsetTop);
}

export function formatKeyboardInsetCss(px: number): string {
  const safe = Number.isFinite(px) ? Math.max(0, Math.round(px)) : 0;
  return `${safe}px`;
}

export function isUsableMapContainer(
  element: Pick<HTMLElement, 'clientWidth' | 'clientHeight'> | null | undefined,
  minSize = 8,
): boolean {
  if (!element) {
    return false;
  }
  return element.clientWidth >= minSize && element.clientHeight >= minSize;
}

export interface KeyboardInsetSubscription {
  disconnect: () => void;
}

/**
 * Writes --suixing-keyboard-inset on documentElement via visualViewport listeners.
 * Coalesces updates with rAF. No-op without window / visualViewport / document.
 */
export function subscribeKeyboardInset(
  win: WindowLike | null | undefined = typeof window === 'undefined' ? undefined : window,
  root: { style: { setProperty: (name: string, value: string) => void } } | null | undefined = typeof document === 'undefined'
    ? undefined
    : document.documentElement,
): KeyboardInsetSubscription {
  const noop = { disconnect() {} };
  if (!win || !root) {
    return noop;
  }

  let frame: number | null = null;
  let disconnected = false;

  const apply = () => {
    if (disconnected) {
      return;
    }
    root.style.setProperty(
      SUIXING_KEYBOARD_INSET_VAR,
      formatKeyboardInsetCss(computeKeyboardInsetPx(win)),
    );
  };

  const schedule = () => {
    if (disconnected) {
      return;
    }
    if (typeof win.requestAnimationFrame !== 'function') {
      apply();
      return;
    }
    if (frame !== null) {
      return;
    }
    frame = win.requestAnimationFrame(() => {
      frame = null;
      apply();
    });
  };

  apply();

  const viewport = win.visualViewport;
  if (viewport?.addEventListener) {
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
  }

  return {
    disconnect() {
      if (disconnected) {
        return;
      }
      disconnected = true;
      if (frame !== null && typeof win.cancelAnimationFrame === 'function') {
        win.cancelAnimationFrame(frame);
        frame = null;
      }
      if (viewport?.removeEventListener) {
        viewport.removeEventListener('resize', schedule);
        viewport.removeEventListener('scroll', schedule);
      }
      root.style.setProperty(SUIXING_KEYBOARD_INSET_VAR, '0px');
    },
  };
}

export interface BackgroundScrollLock {
  unlock: () => void;
}

/**
 * Narrow-viewport only scroll lock. Restores scrollY on unlock.
 * Does not install touchmove preventDefault listeners.
 */
export function lockBackgroundScroll(
  win: WindowLike | null | undefined = typeof window === 'undefined' ? undefined : window,
  body: HTMLElement | null | undefined = typeof document === 'undefined' ? undefined : document.body,
  query: string = SHEET_SCROLL_LOCK_QUERY,
): BackgroundScrollLock {
  const noop = { unlock() {} };
  if (!win || !body) {
    return noop;
  }
  if (typeof win.matchMedia === 'function' && !win.matchMedia(query).matches) {
    return noop;
  }

  const scrollY = typeof win.scrollY === 'number' ? win.scrollY : 0;
  const previous = {
    overflow: body.style.overflow,
    position: body.style.position,
    top: body.style.top,
    width: body.style.width,
  };
  body.classList.add(SHEET_SCROLL_LOCK_CLASS);
  body.style.overflow = 'hidden';
  body.style.position = 'fixed';
  body.style.top = `-${scrollY}px`;
  body.style.width = '100%';

  let unlocked = false;
  return {
    unlock() {
      if (unlocked) {
        return;
      }
      unlocked = true;
      body.classList.remove(SHEET_SCROLL_LOCK_CLASS);
      body.style.overflow = previous.overflow;
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.width = previous.width;
      win.scrollTo?.(0, scrollY);
    },
  };
}
