/**
 * «Acba Self» — Cloudflare Worker.
 *
 * Делает две вещи:
 *  1. Отдаёт само приложение (страницу, манифест и иконки для iPhone).
 *  2. Пересылает запросы приложения в API банка ACBA: браузер не может ходить туда
 *     напрямую, банк разрешает запросы только со своего сайта.
 *
 * Пересылаются только перечисленные ниже запросы. Пароль, код из SMS и данные
 * банка Worker нигде не сохраняет и не пишет в логи.
 */

const BANK = 'https://www.acbadigital.am';
const API_PREFIX = '/api/ru/v2/service/';

// Запросы, которые разрешено пересылать в банк, и с какой страницы банка они «приходят»
const ALLOWED = {
  'Authorization/AuthorizeByPassword': '/ru/login',
  'Authorization/AuthorizeByToken':    '/ru/login',
  'rates/getrates':                    '/ru/dashboard',
  'HomePage/GetCards':                 '/ru/dashboard',
  'Card/GetCardStatement':             '/ru/dashboard',
  'Card/GetPendingTransactions':       '/ru/dashboard',
};
const FORWARD_HEADERS = ['Authorization', 'SessionId', 'Content-Type', 'API-Version', 'Request-Id', 'User-Agent'];
const COOKIE_PREFIX = 'acba_';
const MAX_BODY = 16 * 1024;

const APP_HTML = __APP_HTML__;
const BUILD = '__BUILD__';   // версия сборки: приложение сверяет её и обновляется само
const ICON_180 = __ICON_180__;
const ICON_512 = __ICON_512__;

const MANIFEST = JSON.stringify({
  name: 'Acba Self',
  short_name: 'Acba Self',
  lang: 'ru',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#121316',
  theme_color: '#741B31',
  icons: [
    { src: '/icon-__ICON_VER__-180.png', sizes: '180x180', type: 'image/png' },
    { src: '/icon-__ICON_VER__-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-__ICON_VER__-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https://acbadigital.am https://www.acbadigital.am",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/_logout') return logout(request);
    if (url.pathname.startsWith('/api/')) return proxy(request, url, env);

    if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405);
    // иконки: совпадают и с версией в имени (/icon-<ver>-180.png), и без — так новый логотип
    // получает новый путь, который iOS никогда не видел и берёт заново, минуя кэш
    if (/^\/(apple-touch-icon|favicon)\b/.test(url.pathname) || /^\/icon(-[0-9a-f]+)?-180\.png$/.test(url.pathname)) return png(ICON_180);
    if (/^\/icon(-[0-9a-f]+)?-512\.png$/.test(url.pathname)) return png(ICON_512);
    switch (url.pathname) {
      case '/':
      case '/index.html':
        return new Response(APP_HTML, { headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': CSP,
          ...SECURITY_HEADERS,
        } });
      case '/manifest.webmanifest':
        return new Response(MANIFEST, { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ...SECURITY_HEADERS } });
      case '/version':
        return new Response(BUILD, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS } });
      case '/robots.txt':
        return text('User-agent: *\nDisallow: /\n', 200);
      default:
        return text('Not found', 404);
    }
  },
};

async function proxy(request, url, env) {
  if (request.method !== 'POST') return jsonError('Разрешены только POST-запросы', 405);
  if (!url.pathname.startsWith(API_PREFIX)) return jsonError('Неизвестный запрос', 404);
  const endpoint = url.pathname.slice(API_PREFIX.length);
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, endpoint)) return jsonError('Этот запрос не пересылается', 404);

  // Только страницы с этого же адреса — чтобы чужие сайты не пользовались Worker'ом
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return jsonError('Чужой источник запроса', 403);
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return jsonError('Чужой источник запроса', 403);

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY) return jsonError('Слишком большой запрос', 413);

  const upstream = (env && env.BANK_URL) || BANK; // BANK_URL задаётся только для проверки на имитации банка
  const headers = new Headers({
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Origin': BANK,
    'Referer': BANK + ALLOWED[endpoint],
  });
  for (const name of FORWARD_HEADERS) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  const bankCookies = readCookies(request.headers.get('Cookie'))
    .filter(([k]) => k.startsWith(COOKIE_PREFIX))
    .map(([k, v]) => `${k.slice(COOKIE_PREFIX.length)}=${v}`);
  if (bankCookies.length) headers.set('Cookie', bankCookies.join('; '));

  let res;
  try {
    res = await fetch(upstream + url.pathname, {
      method: 'POST',
      headers,
      body: body.byteLength ? body : undefined,
      redirect: 'manual',
    });
  } catch (err) {
    return jsonError('Банк не отвечает. Попробуйте позже.', 502);
  }

  const out = new Headers({
    'Content-Type': res.headers.get('Content-Type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  for (const raw of setCookies(res.headers)) {
    const c = rewriteCookie(raw);
    if (c) out.append('Set-Cookie', c);
  }
  if (res.status >= 300 && res.status < 400) return jsonError('Банк перенаправил запрос — возможно, сессия закончилась', 401, out);
  return new Response(res.body, { status: res.status, headers: out });
}

function logout(request) {
  const out = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const [k] of readCookies(request.headers.get('Cookie'))) {
    if (k.startsWith(COOKIE_PREFIX)) out.append('Set-Cookie', `${k}=; Path=/api/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`);
  }
  return new Response('{"ok":true}', { headers: out });
}

function readCookies(header) {
  if (!header) return [];
  return header.split(/;\s*/).map(p => {
    const i = p.indexOf('=');
    return i > 0 ? [p.slice(0, i).trim(), p.slice(i + 1).trim()] : null;
  }).filter(Boolean);
}
function setCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  if (typeof headers.getAll === 'function') return headers.getAll('Set-Cookie');
  const one = headers.get('Set-Cookie');
  return one ? [one] : [];
}
// Cookie банка → cookie на адресе Worker'а (с префиксом, только для /api/, недоступна скриптам)
function rewriteCookie(raw) {
  const parts = raw.split(';').map(s => s.trim());
  const first = parts.shift() || '';
  const i = first.indexOf('=');
  if (i <= 0) return null;
  const name = first.slice(0, i), value = first.slice(i + 1);
  if (!/^[A-Za-z0-9_\-.]+$/.test(name)) return null;
  const keep = parts.filter(p => /^(expires|max-age)=/i.test(p));
  return [`${COOKIE_PREFIX}${name}=${value}`, 'Path=/api/', ...keep, 'Secure', 'HttpOnly', 'SameSite=Strict'].join('; ');
}

function png(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', ...SECURITY_HEADERS } });
}
function text(body, status) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
}
function jsonError(message, status, headers) {
  const h = headers || new Headers();
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify({ ResultCode: -1, Description: message, Result: null }), { status, headers: h });
}
