const NEW_WINDOW_TEXT = 'nouvelle fenêtre';
const NEW_WINDOW_SUFFIX = ` (${NEW_WINDOW_TEXT})`;
const SUFFIX_ATTRIBUTE = 'data-vigieau-new-window-suffix';
const ORIGINAL_ARIA_LABEL_ATTRIBUTE =
  'data-vigieau-new-window-original-aria-label';
const GENERATED_ARIA_LABEL_ATTRIBUTE =
  'data-vigieau-new-window-generated-aria-label';

let suffixId = 0;

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('fr');
}

function announcesNewWindow(value: string): boolean {
  return normalizeText(value).includes('nouvelle fenetre');
}

function collectLinkContentText(node: Node, parts: string[]): void {
  if (node.nodeType === 3) {
    parts.push(node.textContent || '');
    return;
  }

  if (node.nodeType !== 1) {
    return;
  }

  const element = node as Element;
  if (
    element.hasAttribute(SUFFIX_ATTRIBUTE) ||
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true'
  ) {
    return;
  }

  const nestedLabel = element.getAttribute('aria-label');
  if (nestedLabel) {
    parts.push(nestedLabel);
    return;
  }

  if (element.tagName === 'IMG') {
    parts.push(element.getAttribute('alt') || '');
    return;
  }

  element.childNodes.forEach((child) => collectLinkContentText(child, parts));
}

function getLinkContentText(link: HTMLAnchorElement): string {
  const parts: string[] = [];
  link.childNodes.forEach((child) => collectLinkContentText(child, parts));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function getLabelledByText(link: HTMLAnchorElement): string {
  const labelledBy = link.getAttribute('aria-labelledby');
  if (!labelledBy) {
    return '';
  }

  return labelledBy
    .split(/\s+/)
    .map((id) => link.ownerDocument.getElementById(id)?.textContent || '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureSecureRel(link: HTMLAnchorElement): void {
  const tokens: string[] = [];
  const normalizedTokens = new Set<string>();
  for (const rawToken of (link.getAttribute('rel') || '').split(/\s+/)) {
    const normalizedToken = rawToken.toLocaleLowerCase();
    if (
      !normalizedToken ||
      normalizedToken === 'opener' ||
      normalizedTokens.has(normalizedToken)
    ) {
      continue;
    }

    tokens.push(
      ['noopener', 'noreferrer'].includes(normalizedToken)
        ? normalizedToken
        : rawToken,
    );
    normalizedTokens.add(normalizedToken);
  }

  for (const requiredToken of ['noopener', 'noreferrer']) {
    if (!normalizedTokens.has(requiredToken)) {
      tokens.push(requiredToken);
      normalizedTokens.add(requiredToken);
    }
  }

  const rel = tokens.join(' ');
  if (link.getAttribute('rel') !== rel) {
    link.setAttribute('rel', rel);
  }
}

function getOrCreateSuffix(link: HTMLAnchorElement): HTMLSpanElement {
  const existingSuffix = link.querySelector<HTMLSpanElement>(
    `span[${SUFFIX_ATTRIBUTE}]`,
  );
  if (existingSuffix) {
    return existingSuffix;
  }

  const suffix = link.ownerDocument.createElement('span');
  suffix.className = 'fr-sr-only';
  suffix.setAttribute(SUFFIX_ATTRIBUTE, '');
  suffix.textContent = NEW_WINDOW_SUFFIX;
  link.append(suffix);
  return suffix;
}

function createSuffixId(document: Document): string {
  let candidate: string;
  do {
    suffixId += 1;
    candidate = `vigieau-new-window-${suffixId}`;
  } while (document.getElementById(candidate));
  return candidate;
}

function getStoredOriginalAriaLabel(
  link: HTMLAnchorElement,
): string | null {
  const serializedLabel = link.getAttribute(ORIGINAL_ARIA_LABEL_ATTRIBUTE);
  if (serializedLabel === null) {
    return null;
  }

  try {
    const label = JSON.parse(serializedLabel) as unknown;
    return typeof label === 'string' ? label : null;
  } catch {
    return null;
  }
}

function ensureAriaLabel(
  link: HTMLAnchorElement,
  currentLabel: string,
  newOriginalLabel: string | null = currentLabel,
): void {
  const previousGeneratedLabel = link.getAttribute(
    GENERATED_ARIA_LABEL_ATTRIBUTE,
  );
  let originalLabel: string | null;

  if (previousGeneratedLabel !== null && currentLabel === previousGeneratedLabel) {
    originalLabel = getStoredOriginalAriaLabel(link);
  } else {
    originalLabel = newOriginalLabel;
    link.setAttribute(
      ORIGINAL_ARIA_LABEL_ATTRIBUTE,
      JSON.stringify(originalLabel),
    );
  }

  const contentLabel = getLinkContentText(link);
  let accessibleLabel =
    originalLabel?.trim() ||
    contentLabel ||
    link.getAttribute('title')?.trim() ||
    link.href;
  if (
    contentLabel &&
    !normalizeText(accessibleLabel).includes(normalizeText(contentLabel))
  ) {
    accessibleLabel = accessibleLabel
      ? `${contentLabel} – ${accessibleLabel}`
      : contentLabel;
  }

  if (!announcesNewWindow(accessibleLabel)) {
    accessibleLabel += NEW_WINDOW_SUFFIX;
  }

  if (link.getAttribute(GENERATED_ARIA_LABEL_ATTRIBUTE) !== accessibleLabel) {
    link.setAttribute(GENERATED_ARIA_LABEL_ATTRIBUTE, accessibleLabel);
  }
  if (link.getAttribute('aria-label') !== accessibleLabel) {
    link.setAttribute('aria-label', accessibleLabel);
  }
}

function ensureAccessibleAnnouncement(link: HTMLAnchorElement): void {
  const ariaLabel = link.getAttribute('aria-label');
  if (ariaLabel !== null) {
    ensureAriaLabel(link, ariaLabel);
    return;
  }

  const labelledBy = link.getAttribute('aria-labelledby');
  if (labelledBy) {
    if (announcesNewWindow(getLabelledByText(link))) {
      return;
    }

    const suffix = getOrCreateSuffix(link);
    if (!suffix.id) {
      suffix.id = createSuffixId(link.ownerDocument);
    }

    const ids = new Set(labelledBy.split(/\s+/).filter(Boolean));
    ids.add(suffix.id);
    const nextLabelledBy = [...ids].join(' ');
    if (link.getAttribute('aria-labelledby') !== nextLabelledBy) {
      link.setAttribute('aria-labelledby', nextLabelledBy);
    }
    return;
  }

  const contentLabel = getLinkContentText(link);
  if (announcesNewWindow(contentLabel)) {
    return;
  }

  if (!contentLabel) {
    const title = link.getAttribute('title')?.trim() || link.href;
    ensureAriaLabel(link, title, null);
    return;
  }

  getOrCreateSuffix(link);
}

function restoreNonBlankLink(link: HTMLAnchorElement): void {
  const suffix = link.querySelector<HTMLSpanElement>(
    `span[${SUFFIX_ATTRIBUTE}]`,
  );
  if (suffix?.id) {
    const labelledBy = (link.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter((id) => id && id !== suffix.id);
    if (labelledBy.length > 0) {
      link.setAttribute('aria-labelledby', labelledBy.join(' '));
    } else {
      link.removeAttribute('aria-labelledby');
    }
  }
  suffix?.remove();

  if (link.hasAttribute(ORIGINAL_ARIA_LABEL_ATTRIBUTE)) {
    const originalLabel = getStoredOriginalAriaLabel(link);
    if (originalLabel === null) {
      link.removeAttribute('aria-label');
    } else {
      link.setAttribute('aria-label', originalLabel);
    }
    link.removeAttribute(ORIGINAL_ARIA_LABEL_ATTRIBUTE);
    link.removeAttribute(GENERATED_ARIA_LABEL_ATTRIBUTE);
  }
}

export function enhanceNewWindowLink(link: HTMLAnchorElement): boolean {
  if (link.getAttribute('target')?.trim().toLocaleLowerCase() !== '_blank') {
    restoreNonBlankLink(link);
    return false;
  }

  ensureSecureRel(link);
  if (
    !link.hasAttribute('aria-label') &&
    link.hasAttribute(GENERATED_ARIA_LABEL_ATTRIBUTE)
  ) {
    link.setAttribute(ORIGINAL_ARIA_LABEL_ATTRIBUTE, 'null');
    link.removeAttribute(GENERATED_ARIA_LABEL_ATTRIBUTE);
  }
  ensureAccessibleAnnouncement(link);
  return true;
}

function isAnchorElement(node: Node): node is HTMLAnchorElement {
  return node.nodeType === 1 && (node as Element).tagName === 'A';
}

export function enhanceNewWindowLinks(root: ParentNode): number {
  const links: HTMLAnchorElement[] = [];
  if (isAnchorElement(root as Node)) {
    links.push(root as HTMLAnchorElement);
  }
  links.push(
    ...root.querySelectorAll<HTMLAnchorElement>('a[target]'),
  );

  let enhancedCount = 0;
  for (const link of links) {
    if (enhanceNewWindowLink(link)) {
      enhancedCount += 1;
    }
  }
  return enhancedCount;
}

export function observeNewWindowLinks(document: Document): () => void {
  enhanceNewWindowLinks(document);

  const Observer = document.defaultView?.MutationObserver;
  if (!Observer || !document.documentElement) {
    return () => undefined;
  }

  const observer = new Observer((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && isAnchorElement(mutation.target)) {
        enhanceNewWindowLink(mutation.target);
        continue;
      }

      if (mutation.type !== 'childList') {
        continue;
      }

      if (isAnchorElement(mutation.target)) {
        enhanceNewWindowLink(mutation.target);
      }
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) {
          enhanceNewWindowLinks(node as Element);
        }
      });
    }
  });

  observer.observe(document.documentElement, {
    attributeFilter: [
      'aria-label',
      'aria-labelledby',
      'href',
      'rel',
      'target',
      'title',
    ],
    attributes: true,
    childList: true,
    subtree: true,
  });

  return () => observer.disconnect();
}
