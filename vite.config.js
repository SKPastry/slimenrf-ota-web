import { Readable } from 'node:stream';

import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

import { onRequestGet, onRequestOptions } from './functions/api/proxy.js';

function pagesFunctionsProxy() {
  return {
    name: 'pages-functions-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
        if (url.pathname !== '/api/proxy') return next();

        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) {
            if (name.startsWith(':')) continue;
            if (Array.isArray(value)) {
              for (const item of value) headers.append(name, item);
            } else if (value !== undefined) {
              headers.set(name, value);
            }
          }

          const request = new Request(url, { method: req.method, headers });
          let response;
          if (req.method === 'GET') response = await onRequestGet({ request });
          else if (req.method === 'OPTIONS') response = await onRequestOptions({ request });
          else response = new Response('Method Not Allowed', { status: 405 });

          res.statusCode = response.status;
          for (const [name, value] of response.headers) res.setHeader(name, value);
          if (!response.body) return res.end();
          Readable.fromWeb(response.body).pipe(res);
        } catch (error) {
          server.config.logger.error(`Local /api/proxy failed: ${error.stack || error}`);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
          }
          res.end(JSON.stringify({ error: 'Local proxy failure' }));
        }
      });
    },
  };
}

export default {
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  plugins: [
    pagesFunctionsProxy(),
    tailwindcss(),
    basicSsl(),
  ],
};
