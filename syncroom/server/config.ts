import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  port: Number(process.env.PORT ?? 4300),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: process.env.SYNCROOM_DATA_DIR ?? path.join(root, 'data'),
  /** Folder of your own video files (movies + series). Configurable at runtime from Settings too. */
  mediaDir: process.env.SYNCROOM_MEDIA_DIR ?? path.join(root, 'media'),
  production: process.env.NODE_ENV === 'production',
  /** Public URL used in invitation links when running behind a proxy/tunnel. Defaults to the request host. */
  publicUrl: process.env.SYNCROOM_PUBLIC_URL,
  tmdbKey: process.env.TMDB_API_KEY ?? process.env.TMDB_READ_TOKEN,
};
