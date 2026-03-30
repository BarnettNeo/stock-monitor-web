import { ref } from 'vue';

// Shared reactive flag backed by matchMedia.
// We keep this as a singleton so multiple pages can consume it consistently.
const isMobile = ref(false);

let initialized = false;

function initOnce(): void {
  if (initialized) return;
  initialized = true;

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

  const mql = window.matchMedia('(max-width: 768px)');
  isMobile.value = mql.matches;

  const onChange = (e: MediaQueryListEvent) => {
    isMobile.value = e.matches;
  };

  // Safari < 14 fallback
  if ('addEventListener' in mql) mql.addEventListener('change', onChange);
  else (mql as any).addListener(onChange);
}

export function useIsMobile() {
  initOnce();
  return { isMobile };
}

