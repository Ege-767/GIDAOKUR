'use strict';

// GIDAOKUR local learning prototype. Requires Node.js 24.15+ (built-in node:sqlite).
// Keep this server.js private: the static-file allow-list below never serves it or the database.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const PORT = 3000;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const DB = new DatabaseSync(path.join(ROOT, 'gidaokur.sqlite'));
const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const BODY_LIMIT = 64 * 1024;
const ALLOWED_ALLERGENS = new Set(['gluten', 'milk', 'egg', 'soy', 'peanuts', 'nuts', 'sesame', 'fish', 'mustard', 'celery']);
const rateBuckets = new Map();

DB.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
DB.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0 CHECK(points >= 0),
    allergens_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS scans (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    barcode TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, barcode)
  );
  CREATE TABLE IF NOT EXISTS coupons (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1))
  );
`);
DB.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

function sendJSON(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(body);
}
function cookieValue(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function publicUser(row) {
  if (!row) return null;
  let allergens = [];
  try { allergens = JSON.parse(row.allergens_json || '[]'); } catch (_) { allergens = []; }
  return { email: row.email, points: row.points, allergens };
}
function userById(id) { return DB.prepare('SELECT id,email,points,allergens_json FROM users WHERE id = ?').get(id); }
function currentUser(req) {
  const token = cookieValue(req, 'gidaokur_session');
  if (!token || token.length > 200) return null;
  const hash = tokenHash(token);
  const session = DB.prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash = ?').get(hash);
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    DB.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  return userById(session.user_id);
}
function setSessionCookie(req, res, token) {
  const secure = Boolean(req.socket.encrypted);
  const flags = ['gidaokur_session=' + encodeURIComponent(token), 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=' + (SESSION_DAYS * 86400)];
  if (secure) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'gidaokur_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch (_) { return false; }
}
function rateAllowed(req, bucket, limit, windowMs) {
  const ip = req.socket.remoteAddress || 'local';
  const key = bucket + ':' + ip;
  const now = Date.now();
  let entry = rateBuckets.get(key);
  if (!entry || entry.reset < now) entry = { count: 0, reset: now + windowMs };
  entry.count += 1;
  rateBuckets.set(key, entry);
  if (rateBuckets.size > 2000) {
    for (const [entryKey, value] of rateBuckets) if (value.reset < now) rateBuckets.delete(entryKey);
  }
  return entry.count <= limit;
}
async function readJSON(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('Gönderilen veri çok büyük.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw Object.assign(new Error('Gönderilen veri okunamadı.'), { status: 400 }); }
}
function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) sendJSON(res, 401, { error: 'Bu işlem için giriş yapmalısın.' });
  return user;
}
function contentType(file) {
  const extension = path.extname(file).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' })[extension] || 'application/octet-stream';
}
const PUBLIC_FILES = new Map([
  ['/', 'index.html'], ['/index.html', 'index.html'], ['/style.css', 'style.css'], ['/app.js', 'app.js'], ['/gidaokur-logo.png', 'gidaokur-logo.png']
]);
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Method not allowed');
  }
  const filename = PUBLIC_FILES.get(pathname);
  if (!filename) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    return res.end('Bu sayfa bulunamadı.');
  }
  const fullPath = path.join(ROOT, filename);
  fs.readFile(fullPath, (error, contents) => {
    if (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Dosya okunamadı: ' + filename);
    }
    res.writeHead(200, { 'Content-Type': contentType(filename), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    res.end(contents);
  });
}
function validBarcode(value) { return /^\d{8,14}$/.test(String(value || '')); }
function productFields() {
  return 'code,product_name,product_name_tr,product_name_en,brands,quantity,image_front_url,image_url,allergens,allergens_tags,traces,traces_tags,ingredients_text,ingredients_text_en,nutriments,nutriscore_grade,categories_tags';
}
async function offJSON(url, { notFoundIsNull = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'GIDAOKUR/1.0 (student educational prototype)', 'Accept': 'application/json' },
      signal: controller.signal
    });
    if (notFoundIsNull && response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error('Ürün veri kaynağı şu anda yanıt vermiyor (' + response.status + '). Biraz sonra yeniden dene.'), { status: 502 });
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('Ürün veri kaynağından yanıt geç geldi. Yeniden deneyebilirsin.'), { status: 504 });
    if (error.status) throw error;
    throw Object.assign(new Error('Ürün veri kaynağına bağlanılamadı. İnternet bağlantısını kontrol et.'), { status: 502 });
  } finally { clearTimeout(timeout); }
}
async function findProduct(barcode) {
  if (!validBarcode(barcode)) throw Object.assign(new Error('Barkod 8–14 rakam olmalı.'), { status: 400 });
  const fields = encodeURIComponent(productFields());
  const result = await offJSON('https://world.openfoodfacts.org/api/v3/product/' + encodeURIComponent(barcode) + '?product_type=food&lc=tr&tags_lc=tr&fields=' + fields, { notFoundIsNull: true });
  if (!result || !result.product) return null;
  return result.product;
}
async function handleAPI(req, res, url) {
  const pathname = url.pathname;
  if (req.method !== 'GET' && !sameOrigin(req)) return sendJSON(res, 403, { error: 'Güvenlik nedeniyle bu istek kabul edilmedi.' });

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    return sendJSON(res, 200, { user: publicUser(currentUser(req)) });
  }
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    if (!rateAllowed(req, 'register', 8, 60 * 60 * 1000)) return sendJSON(res, 429, { error: 'Çok sayıda hesap denemesi yapıldı. Bir süre sonra tekrar dene.' });
    const data = await readJSON(req);
    const email = String(data.email || '').trim().toLowerCase();
    const password = String(data.password || '');
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJSON(res, 400, { error: 'Geçerli bir e-posta adresi yaz.' });
    if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 256) return sendJSON(res, 400, { error: 'Şifre 10–256 karakter aralığında olmalı.' });
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try {
      DB.prepare('INSERT INTO users(id,email,salt,password_hash,created_at) VALUES(?,?,?,?,?)').run(id, email, salt, Buffer.from(derived).toString('hex'), Date.now());
    } catch (error) {
      if (String(error.message).toLowerCase().includes('unique')) return sendJSON(res, 409, { error: 'Bu e-posta ile bir hesap zaten var. Giriş yapmayı dene.' });
      throw error;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash(token), id, Date.now() + SESSION_DAYS * 86400000);
    setSessionCookie(req, res, token);
    return sendJSON(res, 201, { user: publicUser(userById(id)) });
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!rateAllowed(req, 'login', 12, 15 * 60 * 1000)) return sendJSON(res, 429, { error: 'Çok fazla giriş denemesi yapıldı. 15 dakika sonra tekrar dene.' });
    const data = await readJSON(req);
    const email = String(data.email || '').trim().toLowerCase();
    const password = String(data.password || '');
    if (Buffer.byteLength(password, 'utf8') > 256) return sendJSON(res, 401, { error: 'E-posta veya şifre doğru değil.' });
    const row = DB.prepare('SELECT id,email,salt,password_hash FROM users WHERE email = ? COLLATE NOCASE').get(email);
    if (!row) return sendJSON(res, 401, { error: 'E-posta veya şifre doğru değil.' });
    const candidate = Buffer.from(await scrypt(password, row.salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
    const stored = Buffer.from(row.password_hash, 'hex');
    if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) return sendJSON(res, 401, { error: 'E-posta veya şifre doğru değil.' });
    const token = crypto.randomBytes(32).toString('base64url');
    DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash(token), row.id, Date.now() + SESSION_DAYS * 86400000);
    setSessionCookie(req, res, token);
    return sendJSON(res, 200, { user: publicUser(userById(row.id)) });
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = cookieValue(req, 'gidaokur_session');
    if (token) DB.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    clearSessionCookie(res);
    return sendJSON(res, 200, { ok: true });
  }
  if (pathname === '/api/profile/allergens' && req.method === 'PUT') {
    const user = requireUser(req, res);
    if (!user) return;
    const data = await readJSON(req);
    if (!Array.isArray(data.allergens) || data.allergens.length > ALLOWED_ALLERGENS.size || data.allergens.some(item => !ALLOWED_ALLERGENS.has(item))) return sendJSON(res, 400, { error: 'Alerjen seçimini kontrol et.' });
    const unique = [...new Set(data.allergens)];
    DB.prepare('UPDATE users SET allergens_json = ? WHERE id = ?').run(JSON.stringify(unique), user.id);
    return sendJSON(res, 200, { user: publicUser(userById(user.id)) });
  }
  if (pathname === '/api/product/lookup' && req.method === 'POST') {
    if (!rateAllowed(req, 'product', 12, 60 * 1000)) return sendJSON(res, 429, { error: 'Kısa sürede çok fazla ürün arandı. Bir dakika bekleyip yeniden dene.' });
    const data = await readJSON(req);
    const barcode = String(data.barcode || '');
    try {
      const product = await findProduct(barcode);
      if (!product) return sendJSON(res, 404, { error: 'Bu barkod için ürün kaydı bulunamadı.' });
      let reward = null;
      const user = currentUser(req);
      if (user) {
        const inserted = DB.prepare('INSERT OR IGNORE INTO scans(user_id,barcode,created_at) VALUES(?,?,?)').run(user.id, barcode, Date.now());
        if (inserted.changes) DB.prepare('UPDATE users SET points = points + 1 WHERE id = ?').run(user.id);
        reward = { awarded: Boolean(inserted.changes), user: publicUser(userById(user.id)) };
      }
      return sendJSON(res, 200, { product, reward });
    } catch (error) { return sendJSON(res, error.status || 502, { error: error.message }); }
  }
  if (pathname === '/api/search' && req.method === 'GET') {
    if (!rateAllowed(req, 'search', 8, 60 * 1000)) return sendJSON(res, 429, { error: 'Kısa sürede çok fazla ürün arandı. Bir dakika bekleyip yeniden dene.' });
    const query = String(url.searchParams.get('q') || '').trim().slice(0, 80);
    if (query.length < 3) return sendJSON(res, 400, { error: 'Ürün araması için en az 3 karakter yaz.' });
    const params = new URLSearchParams({ search_terms: query, search_simple: '1', action: 'process', json: '1', page_size: '6', fields: productFields() });
    try {
      // Open Food Facts full-text search is currently a legacy endpoint; product-name matches can be incomplete.
      const result = await offJSON('https://world.openfoodfacts.org/cgi/search.pl?' + params.toString());
      const products = Array.isArray(result.products) ? result.products.filter(item => item && item.code).slice(0, 6) : [];
      return sendJSON(res, 200, { products });
    } catch (error) { return sendJSON(res, error.status || 502, { error: error.message }); }
  }
  if (pathname === '/api/rewards/redeem' && req.method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return;
    const code = 'GIDA-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    try {
      DB.exec('BEGIN IMMEDIATE');
      const updated = DB.prepare('UPDATE users SET points = points - 20 WHERE id = ? AND points >= 20').run(user.id);
      if (!updated.changes) {
        DB.exec('ROLLBACK');
        return sendJSON(res, 400, { error: 'Demo kuponu için 20 yıldız gerekli.' });
      }
      DB.prepare('INSERT INTO coupons(code,user_id,created_at) VALUES(?,?,?)').run(code, user.id, Date.now());
      DB.exec('COMMIT');
      return sendJSON(res, 200, { code, value: 40, user: publicUser(userById(user.id)) });
    } catch (error) {
      try { if (DB.isTransaction) DB.exec('ROLLBACK'); } catch (_) { /* transaction already ended */ }
      throw error;
    }
  }
  return sendJSON(res, 404, { error: 'API yolu bulunamadı.' });
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || '127.0.0.1';
  let url;
  try { url = new URL(req.url, 'http://' + host); }
  catch (_) { return sendJSON(res, 400, { error: 'İstek adresi okunamadı.' }); }
  if (url.pathname.startsWith('/api/')) {
    try { return await handleAPI(req, res, url); }
    catch (error) {
      console.error('API error:', error.message);
      if (!res.headersSent) return sendJSON(res, error.status || 500, { error: error.status ? error.message : 'Sunucu beklenmeyen bir sorunla karşılaştı.' });
      return res.end();
    }
  }
  return serveStatic(req, res, url.pathname);
});
server.listen(PORT, HOST, () => {
  console.log('GIDAOKUR hazır: http://' + HOST + ':' + PORT);
  console.log('Kapatmak için bu pencerede Ctrl+C tuşlarına bas.');
});
