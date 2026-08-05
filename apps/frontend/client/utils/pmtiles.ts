import * as maplibregl from 'maplibre-gl';
import {
  FetchSource,
  PMTiles,
  Protocol,
  SharedPromiseCache,
} from 'pmtiles';
import type { Source } from 'pmtiles';
import { createAbortError, isAbortError } from './retryable-task';
import {
  getPmtilesRequestKind,
  isEmptyPmtilesArchive,
} from './zone-source-transition';
import type { PmtilesRequestKind } from './zone-source-transition';

export const zonePmtilesProtocol = new Protocol();
export interface PmtilesStatus {
  failed: boolean;
  requestUrl: string;
  requestKind: PmtilesRequestKind;
}

type PmtilesStatusListener = (status: PmtilesStatus) => void;
const statusListeners = new Set<PmtilesStatusListener>();
let protocolRegistered = false;

export const ensureZonePmtilesProtocol = (): void => {
  if (protocolRegistered) {
    return;
  }
  maplibregl.addProtocol('pmtiles', async (request, abortController) => {
    const requestKind = getPmtilesRequestKind(request.type);
    try {
      const response = await zonePmtilesProtocol.tilev4(
        request,
        abortController,
      );
      if (!abortController.signal.aborted) {
        statusListeners.forEach((listener) =>
          listener({ failed: false, requestUrl: request.url, requestKind }),
        );
      }
      return response;
    } catch (error) {
      if (!abortController.signal.aborted && !isAbortError(error)) {
        statusListeners.forEach((listener) =>
          listener({ failed: true, requestUrl: request.url, requestKind }),
        );
      }
      throw error;
    }
  });
  protocolRegistered = true;
};

export const subscribeZonePmtilesStatus = (
  listener: PmtilesStatusListener,
): (() => void) => {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
};

export interface PreflightPmtilesResult {
  archive: PMTiles;
  empty: boolean;
}

export const preflightPmtiles = async (
  url: string,
  signal: AbortSignal,
): Promise<PreflightPmtilesResult> => {
  if (signal.aborted) {
    throw createAbortError();
  }

  const source = new FetchSource(url);
  const cache = new SharedPromiseCache();
  const preflightSource: Source = {
    getKey: () => source.getKey(),
    getBytes: (offset, length, _signal, etag) =>
      source.getBytes(offset, length, signal, etag),
  };
  const candidate = new PMTiles(preflightSource, cache);

  const header = await candidate.getHeader();
  const empty = isEmptyPmtilesArchive(header);
  if (empty) {
    await candidate.getMetadata();
  }
  if (signal.aborted) {
    throw createAbortError();
  }

  return {
    archive: new PMTiles(source, cache),
    empty,
  };
};
