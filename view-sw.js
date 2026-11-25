const encoder = new TextEncoder();
const until = 12 * 60 * 60 * 1000;
const types = {
  html: 'text/html; charset=utf-8', rsc: 'text/x-component',
  js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpeg: 'image/jpeg',
  webp: 'image/webp', mp4: 'video/mp4', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8',
};

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function session(mode, operation) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('tianxi-share', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('session');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('session', mode);
      const request = operation(transaction.objectStore('session'));
      transaction.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}

async function readContent(path, key) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(path));
  const name = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const response = await fetch('/content/' + name + '.enc', { cache: 'no-cache' });
  if (!response.ok) return null;
  const sealed = new Uint8Array(await response.arrayBuffer());
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.subarray(0, 12), additionalData: encoder.encode(path) },
    key, sealed.subarray(12),
  );
}

self.addEventListener('message', event => {
  if (!event.ports[0] || typeof event.data !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(event.data)) return;
  event.waitUntil((async () => {
    try {
      const encoded = event.data.replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt']);
      if (!await readContent('/index.html', key)) throw new Error('missing entry');
      await session('readwrite', store => store.put({ key, expires: Date.now() + until }, 'active'));
      event.ports[0].postMessage(true);
    } catch {
      event.ports[0].postMessage(false);
    }
  })());
});

function contentPath(request, url) {
  const path = url.pathname.replace(/\/$/, '');
  if (request.headers.get('RSC') === '1' || request.headers.get('Accept')?.includes('text/x-component')) {
    return path.endsWith('.rsc') ? path : (path || '/index') + '.rsc';
  }
  if (request.mode === 'navigate' && !/\.[^/]+$/.test(path)) return (path || '/index') + '.html';
  return path;
}

function isTianxiPath(path) {
  return path === '/index.html' || path === '/index.rsc' || path === '/favicon.svg'
    || /^\/projects\/[a-z0-9-]+\.(html|rsc)$/.test(path)
    || path.startsWith('/_next/static/') || path.startsWith('/assets/tianxi/')
    || /^\/assets\/chick-(run|trip|recover)-crossbody\.png$/.test(path);
}

function responseFor(request, path, bytes) {
  const headers = new Headers({
    'Content-Type': types[path.split('.').at(-1)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  const size = bytes.byteLength;
  const range = request.headers.get('Range');
  if (path.endsWith('.mp4')) headers.set('Accept-Ranges', 'bytes');
  if (range && path.endsWith('.mp4')) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      const start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
      const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start < size && start <= end) {
        headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
        headers.set('Content-Length', end - start + 1);
        return new Response(request.method === 'HEAD' ? null : bytes.slice(start, end + 1), { status: 206, headers });
      }
    }
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Length', size);
  return new Response(request.method === 'HEAD' ? null : bytes, { headers });
}

async function openRequest(request, path) {
  try {
    const active = await session('readonly', store => store.get('active'));
    if (active && active.expires > Date.now()) {
      const bytes = await readContent(path, active.key);
      if (bytes) return responseFor(request, path, bytes);
      if (request.mode === 'navigate') {
        const page = await readContent('/404.html', active.key);
        if (page) {
          const response = responseFor(request, '/404.html', page);
          return new Response(response.body, { status: 404, headers: response.headers });
        }
      }
    }
  } catch {
    // A replaced deployment or cleared browser session requires the share link again.
  }
  return request.mode === 'navigate' ? fetch('/index.html') : new Response(null, { status: 404 });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname === '/index.html' || url.searchParams.has('unlock')) return;
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
  const path = contentPath(event.request, url);
  if (isTianxiPath(path)) event.respondWith(openRequest(event.request, path));
});
