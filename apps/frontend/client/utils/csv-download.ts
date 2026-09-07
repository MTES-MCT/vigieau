import { json2csv } from 'json-2-csv';
import * as Sentry from '@sentry/vue';

export async function downloadCsvFile(rows: object[], filename: string): Promise<boolean> {
  let url: string | undefined;
  try {
    const csv = await json2csv(rows, { expandArrayObjects: true });
    url = window.URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    return true;
  } catch (error) {
    Sentry.captureException(error, { tags: { action: 'csv_download' } });
    return false;
  } finally {
    if (url) {
      const completedUrl = url;
      window.setTimeout(() => window.URL.revokeObjectURL(completedUrl), 0);
    }
  }
}
