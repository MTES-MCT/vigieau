import html2canvas from 'html2canvas';
import type { Options } from 'html2canvas';
import * as Sentry from '@sentry/vue';

type CaptureElement = (
  element: HTMLElement,
  options?: Partial<Options>,
) => Promise<HTMLCanvasElement>;

const canvasToPngBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error('Impossible de convertir la capture en image PNG.'));
    }, 'image/png');
  });

export async function downloadElementAsPng(
  element: HTMLElement | null | undefined,
  filename: string,
  options: Partial<Options> = {},
  captureElement: CaptureElement = html2canvas,
): Promise<void> {
  if (!element) {
    throw new Error('La zone à télécharger est introuvable.');
  }

  const ownerDocument = element.ownerDocument;
  const urlApi = ownerDocument.defaultView?.URL ?? URL;
  const hadCaptureAttribute = element.hasAttribute('data-png-capture');
  const previousCaptureAttribute = element.getAttribute('data-png-capture');
  let anchor: HTMLAnchorElement | null = null;
  let objectUrl: string | null = null;

  element.setAttribute('data-png-capture', '');

  try {
    const canvas = await captureElement(element, options);
    const blob = await canvasToPngBlob(canvas);

    objectUrl = urlApi.createObjectURL(blob);
    anchor = ownerDocument.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    ownerDocument.body.appendChild(anchor);
    anchor.click();
  } catch (error) {
    Sentry.captureException(error, {
      tags: { feature: 'png-download' },
    });
    throw error;
  } finally {
    anchor?.remove();
    if (objectUrl) {
      const urlToRevoke = objectUrl;
      const revokeUrl = () => urlApi.revokeObjectURL(urlToRevoke);
      if (ownerDocument.defaultView) {
        ownerDocument.defaultView.setTimeout(revokeUrl, 0);
      } else {
        setTimeout(revokeUrl, 0);
      }
    }
    if (hadCaptureAttribute) {
      element.setAttribute('data-png-capture', previousCaptureAttribute ?? '');
    } else {
      element.removeAttribute('data-png-capture');
    }
  }
}
