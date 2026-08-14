export const TALLY_FEEDBACK_FORM_ID = 'w881YY';
export const TALLY_FEEDBACK_IFRAME_TITLE =
  'VigiEau - retours utilisateurs';

const TALLY_WIDGET_SCRIPT_SELECTOR =
  'script[src^="https://tally.so/widgets/embed.js"]';
const TALLY_WAIT_TIMEOUT_MS = 5000;
const OBSOLETE_IFRAME_PRESENTATION_ATTRIBUTES = [
  'align',
  'frameborder',
  'marginheight',
  'marginwidth',
  'scrolling',
] as const;

interface TallyPopupOptions {
  width: number;
  autoClose: number;
  emoji: {
    text: string;
    animation: string;
  };
  onOpen: () => void;
  onClose: () => void;
}

interface TallyApi {
  openPopup: (formId: string, options: TallyPopupOptions) => void;
}

type WindowWithTally = Window & {
  Tally?: TallyApi;
};

function getTallyApi(window: Window): TallyApi | null {
  const tally = (window as WindowWithTally).Tally;
  return tally && typeof tally.openPopup === 'function' ? tally : null;
}

function getTallyPopupIframe(
  document: Document,
  formId: string,
): HTMLIFrameElement | null {
  const popup = Array.from(
    document.querySelectorAll<HTMLElement>('.tally-popup'),
  ).find((element) => element.classList.contains(`tally-form-${formId}`));

  return popup?.querySelector<HTMLIFrameElement>('iframe') ?? null;
}

function restoreFocus(element: HTMLElement | null): void {
  if (element?.isConnected) {
    element.focus();
  }
}

export function enhanceAndFocusTallyPopup(
  document: Document,
  formId = TALLY_FEEDBACK_FORM_ID,
  title = TALLY_FEEDBACK_IFRAME_TITLE,
): HTMLIFrameElement | null {
  const iframe = getTallyPopupIframe(document, formId);
  if (!iframe) {
    return null;
  }

  iframe.title = title;
  OBSOLETE_IFRAME_PRESENTATION_ATTRIBUTES.forEach((attribute) => {
    iframe.removeAttribute(attribute);
  });
  iframe.focus();

  return iframe;
}

export function observeTallyPopup(
  document: Document,
  formId = TALLY_FEEDBACK_FORM_ID,
  title = TALLY_FEEDBACK_IFRAME_TITLE,
): () => void {
  const view = document.defaultView;
  let observer: MutationObserver | null = null;
  let timeoutId: number | undefined;

  const stop = (): void => {
    observer?.disconnect();
    observer = null;
    if (view && timeoutId !== undefined) {
      view.clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };

  if (enhanceAndFocusTallyPopup(document, formId, title)) {
    return stop;
  }

  if (!view || !document.body) {
    return stop;
  }

  observer = new view.MutationObserver(() => {
    if (enhanceAndFocusTallyPopup(document, formId, title)) {
      stop();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  timeoutId = view.setTimeout(stop, TALLY_WAIT_TIMEOUT_MS);

  return stop;
}

export function openAccessibleTallyPopup(window: Window): boolean {
  const { document } = window;
  const activeElement = document.activeElement;
  const trigger =
    activeElement instanceof window.HTMLElement ? activeElement : null;
  let stopObserving = (): void => {};

  const open = (): boolean => {
    const tally = getTallyApi(window);
    if (!tally) {
      return false;
    }

    stopObserving = observeTallyPopup(document);

    try {
      tally.openPopup(TALLY_FEEDBACK_FORM_ID, {
        width: 376,
        autoClose: 2000,
        emoji: {
          text: '👋',
          animation: 'wave',
        },
        onOpen: () => {
          if (enhanceAndFocusTallyPopup(document)) {
            stopObserving();
          }
        },
        onClose: () => {
          stopObserving();
          restoreFocus(trigger);
        },
      });
      return true;
    } catch {
      stopObserving();
      restoreFocus(trigger);
      return false;
    }
  };

  if (open()) {
    return true;
  }

  const widgetScript =
    document.querySelector<HTMLScriptElement>(TALLY_WIDGET_SCRIPT_SELECTOR);
  if (!widgetScript) {
    return false;
  }

  let timeoutId: number | undefined;
  const stopWaiting = (): void => {
    widgetScript.removeEventListener('load', handleLoad);
    widgetScript.removeEventListener('error', handleError);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  };
  const handleLoad = (): void => {
    stopWaiting();
    if (trigger && !trigger.isConnected) {
      return;
    }
    if (!open()) {
      restoreFocus(trigger);
    }
  };
  const handleError = (): void => {
    stopWaiting();
    restoreFocus(trigger);
  };

  widgetScript.addEventListener('load', handleLoad, { once: true });
  widgetScript.addEventListener('error', handleError, { once: true });
  timeoutId = window.setTimeout(handleError, TALLY_WAIT_TIMEOUT_MS);

  return true;
}
