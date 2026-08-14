interface ScrollLockState {
  bodyTop: string;
  rootScrollBehavior: string;
  scrollbarWidth: string;
  scrollY: number;
}

let modalLockCount = 0;
let scrollLockState: ScrollLockState | null = null;

export function lockModalPageScroll() {
  modalLockCount += 1;
  if (modalLockCount > 1) {
    return;
  }

  const root = document.documentElement;
  if (root.hasAttribute('data-fr-scrolling')) {
    scrollLockState = null;
    return;
  }

  const scrollY = window.scrollY;
  const scrollbarWidth = window.innerWidth - root.clientWidth;
  scrollLockState = {
    bodyTop: document.body.style.top,
    rootScrollBehavior: root.style.scrollBehavior,
    scrollbarWidth: root.style.getPropertyValue('--scrollbar-width'),
    scrollY,
  };

  root.setAttribute('data-fr-scrolling', 'false');
  document.body.style.top = `${-scrollY}px`;
  if (getComputedStyle(root).scrollBehavior === 'smooth') {
    root.style.scrollBehavior = 'auto';
  }
  if (scrollbarWidth > 0) {
    root.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
  }
}

export function unlockModalPageScroll() {
  if (modalLockCount === 0) {
    return;
  }

  modalLockCount -= 1;
  if (modalLockCount > 0 || !scrollLockState) {
    return;
  }

  const root = document.documentElement;
  const { bodyTop, rootScrollBehavior, scrollbarWidth, scrollY }
    = scrollLockState;
  scrollLockState = null;

  root.removeAttribute('data-fr-scrolling');
  document.body.style.top = bodyTop;
  if (scrollbarWidth) {
    root.style.setProperty('--scrollbar-width', scrollbarWidth);
  } else {
    root.style.removeProperty('--scrollbar-width');
  }
  window.scrollTo(0, scrollY);
  root.style.scrollBehavior = rootScrollBehavior;
}
