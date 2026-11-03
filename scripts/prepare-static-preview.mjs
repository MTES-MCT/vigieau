import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep the generated app runnable without the monorepo source directory.
// Nginx continues to serve only .output/public in Scalingo.
copyFileSync(new URL('./preview-static.mjs', import.meta.url), resolve('.output/preview.mjs'));
