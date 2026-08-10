const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isElementRendered(element: HTMLElement): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) {
    return false;
  }

  const view = element.ownerDocument.defaultView;
  if (!view) {
    return true;
  }

  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    const style = view.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
  }

  return true;
}

function canReceiveFocus(element: HTMLElement): boolean {
  const tabIndex = element.getAttribute('tabindex');
  if (tabIndex !== null && Number.parseInt(tabIndex, 10) < 0) {
    return false;
  }

  return isElementRendered(element);
}

export function getFocusableElements(container: ParentNode): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(focusableSelector),
  ).filter(canReceiveFocus);
}

export function trapTabKey(
  event: KeyboardEvent,
  container: HTMLElement,
): boolean {
  if (event.key !== 'Tab') {
    return false;
  }

  const focusableElements = getFocusableElements(container);
  if (focusableElements.length === 0) {
    return false;
  }

  const firstElement = focusableElements[0];
  const lastElement = focusableElements.at(-1) as HTMLElement;
  const activeElement = container.ownerDocument.activeElement;

  if (
    event.shiftKey &&
    (activeElement === firstElement || !container.contains(activeElement))
  ) {
    event.preventDefault();
    lastElement.focus();
    return true;
  }

  if (
    !event.shiftKey &&
    (activeElement === lastElement || !container.contains(activeElement))
  ) {
    event.preventDefault();
    firstElement.focus();
    return true;
  }

  return false;
}

export function focusRouteContent(document: Document): HTMLElement | null {
  const main = document.getElementById('main-content');
  if (!main) {
    return null;
  }

  const target = Array.from(
    main.querySelectorAll<HTMLElement>('h1'),
  ).find(isElementRendered) || main;
  target.setAttribute('tabindex', '-1');
  target.focus();
  return target;
}

export function ensureButtonAccessibleText(
  document: Document,
  buttonId: string,
  label: string,
): HTMLButtonElement | null {
  const button = document.getElementById(buttonId);
  if (!button || button.tagName !== 'BUTTON') {
    return null;
  }

  const target = button as HTMLButtonElement;

  if (!target.textContent?.trim()) {
    const accessibleText = document.createElement('span');
    accessibleText.className = 'fr-sr-only';
    accessibleText.textContent = label;
    target.append(accessibleText);
  }

  return target;
}

export function focusFirstBreadcrumbLink(
  container: ParentNode,
): HTMLElement | null {
  const firstLink = container.querySelector<HTMLElement>(
    '.fr-breadcrumb__link[href]',
  );
  firstLink?.focus();
  return firstLink;
}
