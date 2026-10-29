'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const state = { user: null, authMode: 'login', searchBusy: false, toastTimer: null, currentProduct: null, currentBarcode: '', previewURL: '', pendingImage: null, scanToken: 0, scanBusy: false, searchAttempts: Object.create(null), searchCandidates: Object.create(null), searchCache: Object.create(null) };
const USERS_KEY = 'gidaokur.accounts.v1';
const SESSION_KEY = 'gidaokur.session.v1';
const OFF_ROOT = 'https://world.openfoodfacts.org';
const PRODUCT_FIELDS = 'code,product_name,product_name_tr,product_name_en,brands,quantity,image_front_url,image_url,allergens,allergens_tags,traces,traces_tags,ingredients_text,ingredients_text_en,nutriments,nutriscore_grade,categories_tags';
const allergenNames = {
  gluten: { label: 'gluten / buğday', terms: ['gluten', 'wheat', 'buğday', 'barley', 'arpa', 'rye', 'çavdar', 'oat', 'yulaf'] },
  milk: { label: 'süt', terms: ['milk', 'milk powder', 'whey', 'casein', 'lactose', 'süt', 'süt tozu', 'peynir altı suyu', 'kazein', 'laktoz'] },
  egg: { label: 'yumurta', terms: ['egg', 'albumin', 'yumurta', 'albümin'] },
  soy: { label: 'soya', terms: ['soy', 'soya'] },
  peanuts: { label: 'yer fıstığı', terms: ['peanut', 'groundnut', 'yer fıstığı', 'fıstık'] },
  nuts: { label: 'sert kabuklu yemiş', terms: ['almond', 'hazelnut', 'walnut', 'cashew', 'pistachio', 'pecan', 'badem', 'fındık', 'ceviz', 'kaju', 'antep fıstığı'] },
  sesame: { label: 'susam', terms: ['sesame', 'susam', 'tahini', 'tahin'] },
  fish: { label: 'balık', terms: ['fish', 'balık'] },
  mustard: { label: 'hardal', terms: ['mustard', 'hardal'] },
  celery: { label: 'kereviz', terms: ['celery', 'kereviz'] }
};

function normalizedEmail(email) { return String(email || '').trim().toLocaleLowerCase('en-US'); }
function readAccounts() {
  let raw;
  try { raw = localStorage.getItem(USERS_KEY); }
  catch (_) { throw new Error('Tarayıcı bu dosya için yerel kayıt alanını kapatmış. Güncel Chrome veya Edge ile tekrar açmayı dene.'); }
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(item => item && item.emailKey && item.passwordHash) : [];
  } catch (_) { throw new Error('Yerel hesap verisi okunamadı. Tarayıcı kayıtlarını kontrol et.'); }
}
function writeAccounts(accounts) {
  try { localStorage.setItem(USERS_KEY, JSON.stringify(accounts)); }
  catch (_) { throw new Error('Hesap bu tarayıcıya kaydedilemedi. Tarayıcı depolama alanı kapalı veya dolu olabilir.'); }
}
function currentAccountRecord() {
  let key;
  try { key = localStorage.getItem(SESSION_KEY); }
  catch (_) { throw new Error('Tarayıcı oturum kaydına erişilemiyor.'); }
  if (!key) return null;
  return readAccounts().find(account => account.emailKey === key) || null;
}
function publicUser(account) {
  if (!account) return null;
  return { email: account.email, allergens: Array.isArray(account.allergens) ? account.allergens : [], points: Math.max(0, Number(account.points) || 0), scannedCodes: Array.isArray(account.scannedCodes) ? account.scannedCodes : [], couponsRedeemed: Math.max(0, Number(account.couponsRedeemed) || 0), recentCoupon: account.recentCoupon || '' };
}
function saveAccount(account, startSession = false) {
  const accounts = readAccounts();
  const index = accounts.findIndex(item => item.emailKey === account.emailKey);
  if (index < 0) accounts.push(account); else accounts[index] = account;
  writeAccounts(accounts);
  if (startSession) {
    try { localStorage.setItem(SESSION_KEY, account.emailKey); }
    catch (_) { throw new Error('Hesap kaydedildi ancak oturum açılamadı. Tarayıcı depolama iznini kontrol et.'); }
  }
  return publicUser(account);
}
function encodeBase64(bytes) { return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')); }
function decodeBase64(value) { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
async function passwordHash(password, saltText) {
  if (!window.crypto || !window.crypto.subtle || !window.crypto.getRandomValues) {
    throw new Error('Bu tarayıcı yerel şifre korumasını desteklemiyor. Güncel Chrome veya Edge ile açmayı dene.');
  }
  const salt = saltText ? decodeBase64(saltText) : window.crypto.getRandomValues(new Uint8Array(16));
  const key = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await window.crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, key, 256);
  return { salt: saltText || encodeBase64(salt), hash: encodeBase64(new Uint8Array(bits)) };
}
function sameHash(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string' || first.length !== second.length) return false;
  let mismatch = 0;
  for (let index = 0; index < first.length; index += 1) mismatch |= first.charCodeAt(index) ^ second.charCodeAt(index);
  return mismatch === 0;
}
async function remoteJSON(url, { notFoundIsNull = false } = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok && !(notFoundIsNull && response.status === 404)) throw new Error('Ürün veri kaynağı şu anda yanıt vermiyor (' + response.status + '). Biraz sonra yeniden dene.');
    if (!response.ok) return { product: null };
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Ürün veri kaynağından yanıt geç geldi. Yeniden deneyebilirsin.');
    if (error instanceof TypeError) throw new Error('Ürün bilgisi için internete bağlanılamadı. İnternetini kontrol edip tekrar dene.');
    throw error;
  } finally { window.clearTimeout(timeout); }
}
async function localAPIJSON(url, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      signal: controller.signal,
      cache: 'no-store'
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    // Static hosts and file:// previews have no local API; use the public data API below.
    return null;
  } finally { window.clearTimeout(timeout); }
}
function requestBody(options) {
  if (!options.body) return {};
  try { return JSON.parse(options.body); } catch (_) { throw new Error('Gönderilen bilgiler okunamadı. Alanları kontrol et.'); }
}
async function appRequest(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (url === '/api/auth/me') return { user: publicUser(currentAccountRecord()) };
  if (url === '/api/auth/register' && method === 'POST') {
    const { email, password } = requestBody(options);
    const cleanEmail = String(email || '').trim();
    const emailKey = normalizedEmail(cleanEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Geçerli bir e-posta adresi yaz.');
    if (String(password || '').length < 10) throw new Error('Şifre en az 10 karakter olmalı.');
    const accounts = readAccounts();
    if (accounts.some(account => account.emailKey === emailKey)) throw new Error('Bu e-posta ile bu tarayıcıda zaten bir hesap var. Giriş yapmayı dene.');
    const digest = await passwordHash(password);
    const account = { email: cleanEmail, emailKey, salt: digest.salt, passwordHash: digest.hash, allergens: [], points: 0, scannedCodes: [], couponsRedeemed: 0, recentCoupon: '', createdAt: Date.now() };
    return { user: saveAccount(account, true) };
  }
  if (url === '/api/auth/login' && method === 'POST') {
    const { email, password } = requestBody(options);
    const emailKey = normalizedEmail(email);
    const account = readAccounts().find(item => item.emailKey === emailKey);
    if (!account || !String(password || '')) throw new Error('E-posta veya şifre hatalı. Bu hesap bu tarayıcıda oluşturulmuş olmalı.');
    const digest = await passwordHash(password, account.salt);
    if (!sameHash(digest.hash, account.passwordHash)) throw new Error('E-posta veya şifre hatalı.');
    try { localStorage.setItem(SESSION_KEY, account.emailKey); }
    catch (_) { throw new Error('Oturum açılamadı. Tarayıcı depolama iznini kontrol et.'); }
    return { user: publicUser(account) };
  }
  if (url === '/api/auth/logout' && method === 'POST') {
    try { localStorage.removeItem(SESSION_KEY); } catch (_) { /* UI still exits */ }
    return { ok: true };
  }
  if (url === '/api/profile/allergens' && method === 'PUT') {
    const account = currentAccountRecord();
    if (!account) throw new Error('Tercihleri kaydetmek için önce giriş yap.');
    const allowed = new Set(['gluten', 'milk', 'egg', 'soy', 'peanuts', 'nuts', 'sesame', 'fish', 'mustard', 'celery']);
    const allergens = requestBody(options).allergens;
    if (!Array.isArray(allergens) || allergens.some(item => !allowed.has(item))) throw new Error('Alerjen seçimlerini kontrol et.');
    account.allergens = [...new Set(allergens)];
    return { user: saveAccount(account) };
  }
  if (url === '/api/rewards/redeem' && method === 'POST') {
    const account = currentAccountRecord();
    if (!account) throw new Error('Ödül için giriş yapmalısın.');
    if (Number(account.points) < 20) throw new Error('Demo kuponu için 20 yıldız gerekiyor.');
    const random = window.crypto.getRandomValues(new Uint8Array(4));
    const code = 'GO40-' + Array.from(random, value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
    account.points -= 20;
    account.couponsRedeemed = (Number(account.couponsRedeemed) || 0) + 1;
    account.recentCoupon = code;
    return { user: saveAccount(account), code };
  }
  if (url === '/api/product/lookup' && method === 'POST') {
    const barcode = String(requestBody(options).barcode || '');
    if (!/^\d{8,14}$/.test(barcode)) throw new Error('Barkod 8–14 rakamdan oluşmalı.');
    let result = await localAPIJSON('/api/product/lookup', options);
    if (!result || !Object.prototype.hasOwnProperty.call(result, 'product')) {
      result = await remoteJSON(OFF_ROOT + '/api/v3/product/' + encodeURIComponent(barcode) + '?product_type=food&lc=tr&tags_lc=tr&fields=' + encodeURIComponent(PRODUCT_FIELDS), { notFoundIsNull: true });
    }
    if (!result || !result.product) return { product: null, reward: null };
    let reward = null;
    const account = currentAccountRecord();
    if (account) {
      const codes = Array.isArray(account.scannedCodes) ? account.scannedCodes : [];
      const awarded = !codes.includes(barcode);
      if (awarded) { codes.push(barcode); account.scannedCodes = codes; account.points = (Number(account.points) || 0) + 1; }
      reward = { awarded, user: saveAccount(account) };
    }
    return { product: result.product, reward };
  }
  if (url.startsWith('/api/search?') && method === 'GET') {
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('q') || '';
    const params = new URLSearchParams({ search_terms: query.trim().slice(0, 80), search_simple: '1', action: 'process', json: '1', page_size: '6', fields: PRODUCT_FIELDS });
    let result = await localAPIJSON(url, { headers: {} });
    if (!result || !Array.isArray(result.products)) result = await remoteJSON(OFF_ROOT + '/cgi/search.pl?' + params.toString());
    return { products: Array.isArray(result.products) ? result.products.filter(item => item && item.code).slice(0, 6) : [] };
  }
  throw new Error('Bu işlem bu bağımsız sürümde desteklenmiyor.');
}
function escapeHTML(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}
function safeImage(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && (url.hostname === 'images.openfoodfacts.org' || url.hostname === 'world.openfoodfacts.org')) return url.href;
  } catch (_) { /* invalid image URL */ }
  return '';
}
function showToast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => node.classList.remove('show'), 3200);
}
function setSearchMessage(message, kind = 'info') {
  const box = $('#resultsMessage');
  box.hidden = !message;
  box.textContent = message || '';
  box.style.borderLeftColor = kind === 'error' ? '#c9503d' : kind === 'success' ? '#347c44' : '';
}
function setBusy(busy) {
  state.searchBusy = busy;
  $('#resultsRegion').setAttribute('aria-busy', String(busy));
  $('#searchForm button[type="submit"]').disabled = busy;
  $('#searchForm button[type="submit"] span:first-child').textContent = busy ? 'Bakılıyor…' : 'Ara';
}
function openAuth(mode = 'login') {
  setAuthMode(mode);
  const dialog = $('#authDialog');
  if (!dialog.open) dialog.showModal();
  window.setTimeout(() => $('#authEmail').focus(), 40);
}
function setAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === 'register';
  $('#loginTab').classList.toggle('active', !registering);
  $('#registerTab').classList.toggle('active', registering);
  $('#loginTab').setAttribute('aria-selected', String(!registering));
  $('#registerTab').setAttribute('aria-selected', String(registering));
  $('#authTitle').textContent = registering ? 'Kendi hesabını oluştur.' : 'Tekrar merhaba.';
  $('#authSubmit').innerHTML = registering ? 'Hesap oluştur <span aria-hidden="true">↗</span>' : 'Giriş yap <span aria-hidden="true">↗</span>';
  $('#confirmField').hidden = !registering;
  $('#authPassword').autocomplete = registering ? 'new-password' : 'current-password';
  $('#authMessage').hidden = true;
  $('#authMessage').textContent = '';
}
function authMessage(message, success = false) {
  const node = $('#authMessage');
  node.hidden = false;
  node.textContent = message;
  node.classList.toggle('success', success);
}
function updateProfileUI() {
  const loggedIn = Boolean(state.user);
  $('#accountButton').textContent = loggedIn ? 'Hesabım' : 'Giriş yap';
  $('#createAccountButton').hidden = loggedIn;
  $('#profileTitle').textContent = loggedIn ? state.user.email : 'Henüz giriş yapılmadı';
  $('#profileHint').hidden = loggedIn;
  $('#allergenForm').hidden = !loggedIn;
  $('#rewardPanel').hidden = !loggedIn;
  $('#logoutButton').hidden = !loggedIn;
  if (!loggedIn) return;
  const selected = new Set(state.user.allergens || []);
  $$('.allergen-options input').forEach(input => { input.checked = selected.has(input.value); });
  const points = Math.max(0, Number(state.user.points) || 0);
  $('#pointsCount').textContent = points;
  const remainder = points % 20;
  const progress = remainder === 0 && points > 0 ? 20 : remainder;
  $('#rewardProgress').style.width = (progress / 20 * 100) + '%';
  $('.reward-track').setAttribute('aria-valuenow', String(progress));
  $('#redeemButton').disabled = points < 20;
  $('#rewardHint').textContent = points >= 20 ? '20 yıldız tamamlandı. Her yıldız 2 TL değerinde; bir 40 TL demo kuponu oluşturabilirsin.' : 'Her farklı ve veri tabanında bulunan barkod taraması 1 yıldız kazandırır. 1 yıldız = 2 TL; 20 yıldız = 40 TL demo kuponu.';
}
async function refreshMe() {
  try {
    const result = await appRequest('/api/auth/me', { headers: {} });
    state.user = result.user || null;
  } catch (_) { state.user = null; }
  updateProfileUI();
}
function getSelectedAllergens() {
  return $$('.allergen-options input:checked').map(input => input.value);
}
function normalizedText(value) {
  return String(value || '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
}
function allergenAssessment(product) {
  const selected = state.user && Array.isArray(state.user.allergens) ? state.user.allergens : [];
  if (!selected.length) return { kind: 'alert-unknown', title: 'Kişisel alerjen listen ayarlı değil', text: state.user ? 'Alerjen tercihlerini yukarıdaki hesabım bölümünden kaydedebilirsin.' : 'Kişisel alerjen uyarısı için giriş yapıp profilinde alerjenlerini seçebilirsin.', foot: 'Alerji şüphen varsa ambalajdaki tüm uyarıları kontrol et.' };
  const ingredientText = [product.ingredients_text, product.ingredients_text_en].filter(Boolean).join(' ');
  const tags = [product.allergens || '', Array.isArray(product.allergens_tags) ? product.allergens_tags.join(' ') : ''].join(' ');
  const traces = [product.traces, Array.isArray(product.traces_tags) ? product.traces_tags.join(' ') : ''].filter(Boolean).join(' ');
  const sourceText = normalizedText(ingredientText + ' ' + tags + ' ' + traces);
  const hasTerm = term => {
    const escaped = normalizedText(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)', 'i').test(sourceText);
  };
  const found = [];
  for (const key of selected) {
    const definition = allergenNames[key];
    if (definition && definition.terms.some(hasTerm)) found.push(definition.label);
  }
  const hasAny = Boolean(ingredientText || tags || traces);
  if (found.length) return { kind: 'alert-danger', title: 'Olası alerjen eşleşmesi bulundu', text: 'Seçtiğin alerjenlerle eşleşen ifade: ' + found.join(', ') + '.', foot: 'Bu metin eşleştirmesi ambalaj kontrolünün yerine geçmez. Çapraz bulaşma veya eksik veri olabilir.' };
  if (!hasAny) return { kind: '', title: 'Alerjen bilgisi bulunmuyor', text: 'Bu üründe içerik/alergen metni bulunmadığı için kişisel eşleşme kontrol edilemiyor.', foot: 'Veri yok = güvenli demek değildir. Satın almadan önce ambalajı kontrol et.' };
  return { kind: 'alert-ok', title: 'Metinde seçili alerjen eşleşmesi görülmedi', text: 'Kaydedilmiş alerjenlerinle içerik metni arasında otomatik bir eşleşme bulunamadı.', foot: 'Bu bir güvenlik garantisi değildir. “İz miktarda içerebilir” ve çapraz bulaşma uyarılarını paketten kontrol et.' };
}
function numberFrom(product, key) {
  const value = product.nutriments && product.nutriments[key];
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function formatNutrient(product, key, suffix) {
  let number = numberFrom(product, key);
  if (number === null && isDrinkProduct(product) && key.endsWith('_100g')) number = numberFrom(product, key.replace(/_100g$/, '_100ml'));
  return number === null ? 'Veri yok' : new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(number) + ' ' + suffix;
}
function isDrinkProduct(product) {
  const tags = Array.isArray(product.categories_tags) ? product.categories_tags.join(' ') : '';
  const quantity = String(product.quantity || '');
  return /beverages|drinks|soft-drinks|water/i.test(tags) || /\b\d+(?:[.,]\d+)?\s*(?:ml|cl|litre|liter|l)\b/i.test(quantity);
}
function trafficValue(product, nutrient, liquid) {
  const values = product.nutriments || {};
  const keys = liquid ? [nutrient + '_100ml', nutrient + '_100g'] : [nutrient + '_100g'];
  for (const key of keys) {
    const value = Number(values[key]);
    if (values[key] !== undefined && values[key] !== null && values[key] !== '' && Number.isFinite(value)) return value;
  }
  return null;
}
function nutritionTrafficHTML(product) {
  const liquid = isDrinkProduct(product);
  const unit = liquid ? '100 ml' : '100 g';
  const scale = liquid ? [
    { key: 'fat', label: 'Toplam yağ', low: 1.5, medium: 8.75 },
    { key: 'saturated-fat', label: 'Doymuş yağ', low: 0.75, medium: 2.5 },
    { key: 'sugars', label: 'Şeker', low: 2.5, medium: 11.25 },
    { key: 'salt', label: 'Tuz', low: 0.3, medium: 0.75 }
  ] : [
    { key: 'fat', label: 'Toplam yağ', low: 3, medium: 17.5 },
    { key: 'saturated-fat', label: 'Doymuş yağ', low: 1.5, medium: 5 },
    { key: 'sugars', label: 'Şeker', low: 5, medium: 22.5 },
    { key: 'salt', label: 'Tuz', low: 0.3, medium: 1.5 }
  ];
  const items = scale.map(item => {
    const value = trafficValue(product, item.key, liquid);
    const status = value === null ? 'unknown' : value <= item.low ? 'green' : value <= item.medium ? 'amber' : 'red';
    const label = status === 'unknown' ? 'VERİ YOK' : status === 'green' ? 'DÜŞÜK' : status === 'amber' ? 'ORTA' : 'YÜKSEK';
    const amount = value === null ? 'Bilgi yok' : new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(value) + ' g';
    return { ...item, status, label, amount };
  });
  const known = items.filter(item => item.status !== 'unknown');
  let summaryClass = 'unknown';
  let summary = 'Besin verisi eksik';
  if (items.some(item => item.status === 'red')) { summaryClass = 'red'; summary = 'Yüksek miktarlı değer var'; }
  else if (items.some(item => item.status === 'amber')) { summaryClass = 'amber'; summary = 'Bazı değerler orta düzeyde'; }
  else if (known.length === items.length) { summaryClass = 'green'; summary = 'Bu dört değer düşük'; }
  return '<section class="nutrition-traffic" aria-labelledby="trafficTitle">' +
    '<div class="traffic-heading"><div><h4 id="trafficTitle">Besin ışıkları</h4><p>Değerler ürün başına ' + unit + ' üzerinden</p></div><strong class="traffic-summary is-' + summaryClass + '">' + summary + '</strong></div>' +
    '<div class="traffic-grid">' + items.map(item => '<div class="traffic-item is-' + item.status + '"><span>' + escapeHTML(item.label) + '</span><b>' + escapeHTML(item.amount) + '</b><small>' + escapeHTML(item.label === 'YÜKSEK' ? 'Azaltmaya çalış' : item.label === 'ORTA' ? 'Ölçülü tüket' : item.label === 'DÜŞÜK' ? 'Düşük miktar' : 'Değerlendirilemiyor') + '</small></div>').join('') + '</div>' +
    '<div class="traffic-legend"><span><i class="legend-dot legend-nutrition-red"></i>Kırmızı: yüksek miktar</span><span><i class="legend-dot legend-amber"></i>Sarı: orta miktar</span><span><i class="legend-dot legend-green"></i>Yeşil: düşük miktar</span><span><i class="legend-dot legend-missing"></i>Gri: veri yok</span></div>' +
    '<p class="traffic-note">Renkler yalnızca bu dört besin öğesinin miktarını gösterir; ürünün tamamına “sağlıklı” damgası vurmaz ve alerji güvenliği sağlamaz. Öğretici eşikler, <a href="https://www.gov.uk/government/publications/front-of-pack-nutrition-labelling-guidance" target="_blank" rel="noreferrer">ön yüz trafik ışığı rehberindeki</a> 100 g / 100 ml değerlerine dayanır.</p>' +
  '</section>';
}
function splitIngredients(text) {
  const source = String(text || '').replace(/\u0000/g, ' ').replace(/^(?:içindekiler|ingredients)\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
  const groups = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1] || '';
    if ((char === ',' && !/\d/.test(next)) || char === ';' || char === '•') {
      if (depth === 0) {
        groups.push(current);
        current = '';
      } else if (char !== ',' || !/\d/.test(next)) {
        current += ' · ';
      } else {
        current += char;
      }
      continue;
    }
    current += char;
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
  }
  if (current) groups.push(current);
  return groups.map(item => item.replace(/_/g, '').trim().replace(/^[\s.\-]+|[\s.]+$/g, '')).filter(item => item.length > 1);
}
function ingredientMatchesProfile(ingredient) {
  const selected = state.user && Array.isArray(state.user.allergens) ? state.user.allergens : [];
  const normalized = ' ' + normalizedText(ingredient).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  return selected.some(key => {
    const definition = allergenNames[key];
    return definition && definition.terms.some(term => {
      const value = normalizedText(term).replace(/[^a-z0-9]+/g, ' ').trim();
      return value && normalized.includes(' ' + value + ' ');
    });
  });
}
function ingredientsHTML(text) {
  const ingredients = splitIngredients(text);
  if (!ingredients.length) return '<p class="ingredients-empty">İçindekiler bilgisi paylaşılmamış. Ambalajı kontrol et.</p>';
  const visible = ingredients.slice(0, 36);
  const list = '<ol class="ingredient-list">' + visible.map((item, index) => {
    const match = ingredientMatchesProfile(item);
    return '<li class="ingredient-item' + (match ? ' is-allergen' : '') + '"><span class="ingredient-number">' + String(index + 1).padStart(2, '0') + '</span><span class="ingredient-name">' + escapeHTML(item) + '</span>' + (match ? '<small>OLASI ALERJEN</small>' : '') + '</li>';
  }).join('') + '</ol>';
  const more = ingredients.length > visible.length ? '<p class="ingredient-count">İlk ' + visible.length + ' içerik gösteriliyor; tam metin aşağıda.</p>' : '';
  const source = '<details class="ingredient-source"><summary>Kaynak metnin tamamını gör</summary><p>' + escapeHTML(text) + '</p></details>';
  return list + more + source;
}
function gradeHTML(product) {
  const grade = String(product.nutriscore_grade || '').toLowerCase();
  if (/^[a-e]$/.test(grade)) {
    return '<div class="nutriscore-display"><span class="nutri-grade grade-' + grade + '" aria-label="Nutri-Score ' + grade.toUpperCase() + '">' + grade.toUpperCase() + '</span><span>Kaynak kaydındaki Nutri-Score harfi. GIDAOKUR puanı veya indirim yıldızı değildir.</span></div>';
  }
  return '<span class="nutri-unknown">Bu ürün kaydında Nutri-Score yok; GIDAOKUR eksik veriden puan oluşturmaz.</span>';
}
function productTitle(product) {
  const name = String(product.product_name_tr || product.product_name || product.product_name_en || '').trim();
  if (!name) return 'Ürün adı veri tabanında yok';
  const brand = String(product.brands || '').split(',')[0].trim();
  return brand && !normalizedText(name).includes(normalizedText(brand)) ? brand + ' ' + name : name;
}
function productImage(product) {
  return safeImage(product.image_front_url || product.image_url || '');
}
function renderSearchResults(products) {
  const list = $('#resultsList');
  list.replaceChildren();
  if (!products.length) {
    setSearchMessage('Kaynakta eşleşen ürün bulunamadı. Marka ve ürün adını kısaltarak tekrar ara ya da aşağıdan etiketi elle değerlendir.', 'error');
    return;
  }
  setSearchMessage(products.length === 1 ? 'Bir ürün bulundu. Ürün adı, marka ve fotoğrafı kaynak kayıttan gelir.' : products.length + ' ürün bulundu. Tam marka ve ürün adını kontrol edip doğru sonucu seç.', 'success');
  products.forEach(product => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'product-option';
    const image = productImage(product);
    const name = productTitle(product);
    const brand = product.brands || 'Marka bilgisi yok';
    const barcode = String(product.code || '');
    const nameNote = product.product_name_tr ? '' : ' · Türkçe ad alanı boş; varsayılan ürün adı gösteriliyor';
    button.innerHTML = (image ? '<img src="' + escapeHTML(image) + '" alt="" loading="lazy">' : '<span class="upload-icon" aria-hidden="true">▧</span>') + '<span><b>' + escapeHTML(name) + '</b><small>' + escapeHTML(brand) + (barcode ? ' · Barkod ' + escapeHTML(barcode) : '') + escapeHTML(nameNote) + '</small></span>';
    button.addEventListener('click', () => loadProduct(barcode));
    list.appendChild(button);
  });
}
function addAlternativeSearchForm(panel) {
  const form = document.createElement('form');
  form.className = 'repeat-search-form';
  const label = document.createElement('label');
  label.htmlFor = 'repeatSearchInput';
  label.textContent = 'Hayırsa, ne aradığını yaz:';
  const controls = document.createElement('div');
  controls.className = 'repeat-search-controls';
  const input = document.createElement('input');
  input.id = 'repeatSearchInput';
  input.type = 'search';
  input.name = 'alternative-query';
  input.placeholder = 'Ürün adı veya marka';
  input.required = true;
  input.minLength = 3;
  input.maxLength = 120;
  const button = document.createElement('button');
  button.className = 'button repeat-search-submit';
  button.type = 'submit';
  button.textContent = 'Yeni arama';
  controls.append(input, button);
  form.append(label, controls);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const nextQuery = input.value.trim();
    if (nextQuery.length < 3) { input.reportValidity(); return; }
    $('#productQuery').value = nextQuery;
    $('#repeatSearchPrompt').hidden = true;
    searchProducts(nextQuery);
  });
  panel.appendChild(form);
  input.focus();
}
function showRepeatSearchPrompt(query, attempts, candidate) {
  const panel = $('#repeatSearchPrompt');
  panel.replaceChildren();
  panel.hidden = false;
  const kicker = document.createElement('span');
  kicker.className = 'repeat-search-kicker';
  kicker.textContent = 'ARAMA YARDIMI · ' + attempts + ' DENEME';
  const heading = document.createElement('h3');
  const description = document.createElement('p');
  if (candidate && candidate.code) {
    heading.textContent = 'Şunu mu arıyorsunuz?';
    description.textContent = '“' + query + '” aramasını ' + attempts + ' kez yaptın. Bu kayıt aradığın ürün olabilir mi?';
    const product = document.createElement('div');
    product.className = 'repeat-search-product';
    const productName = document.createElement('strong');
    productName.textContent = productTitle(candidate);
    const productBrand = document.createElement('span');
    productBrand.textContent = candidate.brands || 'Marka bilgisi yok';
    product.append(productName, productBrand);
    const actions = document.createElement('div');
    actions.className = 'repeat-search-actions';
    const yes = document.createElement('button');
    yes.className = 'button repeat-search-yes';
    yes.type = 'button';
    yes.textContent = 'Evet, bu ürünü aç';
    yes.addEventListener('click', () => {
      panel.hidden = true;
      loadProduct(String(candidate.code));
    });
    const no = document.createElement('button');
    no.className = 'button repeat-search-no';
    no.type = 'button';
    no.textContent = 'Hayır';
    no.addEventListener('click', () => {
      actions.hidden = true;
      addAlternativeSearchForm(panel);
    });
    actions.append(yes, no);
    panel.append(kicker, heading, description, product, actions);
  } else {
    heading.textContent = 'Aradığın ürünü bulamadık.';
    description.textContent = '“' + query + '” araması bu oturumda ' + attempts + ' kez denendi. Başka bir ürün adı ya da marka yazıp yeniden arayabilirsin.';
    panel.append(kicker, heading, description);
    addAlternativeSearchForm(panel);
  }
}function renderProduct(product, barcode, shouldScroll = true) {
  state.currentProduct = product;
  state.currentBarcode = barcode;
  const panel = $('#productDetail');
  const isManual = Boolean(product.manual_entry);
  const title = productTitle(product);
  const image = productImage(product);
  const allergen = allergenAssessment(product);
  const ingredients = product.ingredients_text || product.ingredients_text_en || '';
  const quantity = product.quantity || '';
  const measureUnit = isDrinkProduct(product) ? '100 ml' : '100 g';
  const grade = gradeHTML(product);
  const alertClass = allergen.kind ? ' ' + allergen.kind : '';
  const rawNutrients = [
    ['Enerji', formatNutrient(product, 'energy-kcal_100g', 'kcal')],
    ['Karbonhidrat', formatNutrient(product, 'carbohydrates_100g', 'g')],
    ['Protein', formatNutrient(product, 'proteins_100g', 'g')],
    ['Lif', formatNutrient(product, 'fiber_100g', 'g')]
  ];
  panel.innerHTML = '<div class="product-topline"><span>' + (isManual ? 'ETİKET MERCEĞİ / ELLE GİRİLEN BİLGİ' : 'ETİKET MERCEĞİ / ÜRÜN KAYDI') + '</span><span>' + (barcode ? 'BARKOD ' + escapeHTML(barcode) : (isManual ? 'KULLANICI GİRİŞİ' : 'BARKOD YOK')) + '</span></div>' +
    '<div class="product-body">' +
      '<div class="product-overview">' +
        (image ? '<img class="product-picture" src="' + escapeHTML(image) + '" alt="' + escapeHTML(title) + ' ürün görseli" loading="lazy">' : '<div class="product-picture product-picture-empty">Ürün görseli yok</div>') +
        '<div class="product-title"><span class="product-brand">' + escapeHTML(product.brands || (isManual ? 'Elle girilen etiket' : 'Marka bilgisi paylaşılmamış')) + '</span><h3 id="productName">' + escapeHTML(title) + '</h3><p>' + escapeHTML(quantity || 'Miktar bilgisi yok') + '</p>' + (!isManual && !product.product_name_tr && (product.product_name || product.product_name_en) ? '<p class="source-language-note">Türkçe ad alanı boş; varsayılan ürün adı gösteriliyor.</p>' : '') + '<div class="product-tags"><span class="product-tag">' + (isManual ? 'AMBALAJDAN ELLE GİRİLDİ' : 'OPEN FOOD FACTS KAYDI') + '</span></div><div class="nutri-box"><h4>NUTRI-SCORE · KAYITTA VARSA</h4>' + grade + '</div><p class="product-data-note">Kaynakta bulunmayan Nutri-Score tahmin edilmez.</p></div>' +
      '</div>' +
      '<div class="profile-alert' + alertClass + '"><b>' + escapeHTML(allergen.title) + '</b><p>' + escapeHTML(allergen.text) + '</p><small>' + escapeHTML(allergen.foot) + '</small></div>' +
      nutritionTrafficHTML(product) +
      '<div class="nutrient-grid">' + rawNutrients.map(item => '<div class="nutrient-cell"><span>' + escapeHTML(item[0]) + ' / ' + measureUnit + '</span><b>' + escapeHTML(item[1]) + '</b></div>').join('') + '</div>' +
      '<section class="ingredient-section" aria-labelledby="ingredientTitle"><div class="ingredient-heading"><div><h4 id="ingredientTitle">İÇİNDEKİLER</h4><p>Ambalajdaki kaynak sırasına göre düzenlendi.</p></div><span>' + splitIngredients(ingredients).length + ' satır</span></div>' + ingredientsHTML(ingredients) + '</section>' +
      '<div class="detail-footer"><span>' + (isManual ? 'Kaynak: senin ambalajdan girdiğin bilgiler · bağımsız doğrulama yapılmadı.' : 'Veri kaynağı: Open Food Facts · Topluluk tarafından eklenir, eksik/hatalı olabilir.') + '</span>' + (barcode ? '<a class="off-link" href="https://world.openfoodfacts.org/product/' + encodeURIComponent(barcode) + '" target="_blank" rel="noreferrer">Kaynak kaydı ↗</a>' : '') + '</div>' +
    '</div>';
  panel.hidden = false;
  if (shouldScroll) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function loadProduct(barcode) {
  if (!/^\d{8,14}$/.test(String(barcode || ''))) {
    setSearchMessage('Bu sonuçta kullanılabilir barkod numarası yok. Ürün adını kontrol ederek tekrar deneyebilirsin.', 'error');
    return;
  }
  setBusy(true);
  setSearchMessage('Ürün etiketi getiriliyor…');
  $('#productDetail').hidden = true;
  try {
    const result = await appRequest('/api/product/lookup', { method: 'POST', body: JSON.stringify({ barcode }) });
    if (!result.product) throw new Error('Bu barkod için ürün kaydı bulunamadı.');
    renderProduct(result.product, barcode);
    setSearchMessage('Ürün kaydı bulundu. Bilgiler veri tabanındaki mevcut kayıtla sınırlıdır.', 'success');
    if (result.reward && result.reward.user) {
      state.user = result.reward.user;
      updateProfileUI();
      showToast(result.reward.awarded ? 'Bu ürün için 1 yıldız kazandın.' : 'Bu barkodu daha önce taramıştın; yıldız tekrar eklenmedi.');
    }
  } catch (error) {
    setSearchMessage((error.message || 'Ürün bilgisi alınamadı. İnternet bağlantısını ve barkodu kontrol et.') + ' Veri yoksa aşağıdaki formdan etiketi elle değerlendirebilirsin.', 'error');
  } finally { setBusy(false); }
}
async function searchProducts(query) {
  const cleaned = String(query || '').trim();
  $('#repeatSearchPrompt').hidden = true;
  $('#searchError').hidden = true;
  $('#productDetail').hidden = true;
  $('#resultsList').replaceChildren();
  if (!cleaned) {
    $('#searchError').textContent = 'Bir barkod numarası veya ürün adı yaz.';
    $('#searchError').hidden = false;
    $('#productQuery').focus();
    return;
  }
  if (cleaned.length < 3) {
    $('#searchError').textContent = 'Ürün araması için en az 3 karakter yaz.';
    $('#searchError').hidden = false;
    $('#productQuery').focus();
    return;
  }
  const isTextSearch = !/^\d+$/.test(cleaned);
  const searchKey = isTextSearch ? cleaned.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim() : '';
  const attempts = isTextSearch ? (state.searchAttempts[searchKey] = (state.searchAttempts[searchKey] || 0) + 1) : 0;
  let textSearchSucceeded = false;
  setBusy(true);
  setSearchMessage('Veri tabanında aranıyor…');
  try {
    if (!isTextSearch) {
      if (!/^\d{8,14}$/.test(cleaned)) throw new Error('Barkod 8–14 rakamdan oluşmalı. Numaranın başındaki sıfırları silme.');
      await loadProduct(cleaned);
    } else {
      let result;
      if (Object.prototype.hasOwnProperty.call(state.searchCache, searchKey)) {
        result = { products: state.searchCache[searchKey] };
      } else {
        result = await appRequest('/api/search?q=' + encodeURIComponent(cleaned), { headers: {} });
        state.searchCache[searchKey] = Array.isArray(result.products) ? result.products : [];
      }
      const products = Array.isArray(result.products) ? result.products : [];
      textSearchSucceeded = true;
      if (products.length) state.searchCandidates[searchKey] = products[0];
      renderSearchResults(products);
    }
  } catch (error) { setSearchMessage((error.message || 'Arama başarısız oldu. Bağlantını kontrol edip tekrar dene.') + ' Ürün kaydı yoksa etiketi aşağıdaki formdan elle değerlendirebilirsin.', 'error'); }
  finally {
    setBusy(false);
    if (isTextSearch && textSearchSucceeded && attempts >= 10) showRepeatSearchPrompt(cleaned, attempts, state.searchCandidates[searchKey] || null);
  }
}function ocrProductQuery(text) {
  const ignored = /^(içindekiler|ingredients|besin değerleri|nutrition|nutrition facts|enerji|energy|şeker|sugars|yağ|fat|protein|karbonhidrat|carbohydrate|tuz|salt|net miktar|net weight|son tüketim|best before)\b/i;
  const lines = String(text || '').split(/\r?\n/)
    .map(line => line.replace(/[^A-Za-z0-9ÇĞİÖŞÜçğıöşü% ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(line => line.length >= 3 && !ignored.test(line) && !/^\d+(?:[.,]\d+)?\s?(?:g|kg|ml|cl|l|kcal)$/i.test(line));
  return lines.slice(0, 3).join(' ').slice(0, 80).trim();
}
function prepareImageFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 10 * 1024 * 1024) {
    state.scanToken += 1;
    state.scanBusy = false;
    state.pendingImage = null;
    if (state.previewURL) URL.revokeObjectURL(state.previewURL);
    state.previewURL = '';
    $('#imagePreview').removeAttribute('src');
    $('#imagePreviewWrap').hidden = true;
    $('#scanStatus').textContent = 'PNG, JPG veya WebP biçiminde en fazla 10 MB bir fotoğraf seç.';
    $('#barcodeImage').value = '';
    $('#scanImageButton').disabled = true;
    return;
  }
  state.scanToken += 1;
  state.scanBusy = false;
  state.pendingImage = file;
  if (state.previewURL) URL.revokeObjectURL(state.previewURL);
  state.previewURL = URL.createObjectURL(file);
  $('#imagePreview').src = state.previewURL;
  $('#imagePreviewWrap').hidden = false;
  $('#scanImageButton').disabled = false;
  $('#scanButtonLabel').textContent = 'Taramayı başlat';
  $('#scanStatus').textContent = 'Fotoğraf hazır. Barkodu ve ürün adını okumak için “Taramayı başlat” düğmesine bas.';
}
async function handleImageFile() {
  const file = state.pendingImage;
  if (!file || state.scanBusy) return;
  const scanToken = ++state.scanToken;
  const scanURL = URL.createObjectURL(file);
  state.scanBusy = true;
  $('#scanImageButton').disabled = true;
  $('#scanButtonLabel').textContent = 'Taranıyor…';
  $('#scanStatus').textContent = 'Önce barkod, sonra ambalaj yazısı taranıyor…';
  const finishScan = () => {
    URL.revokeObjectURL(scanURL);
    if (scanToken !== state.scanToken) return;
    state.scanBusy = false;
    $('#scanImageButton').disabled = !state.pendingImage;
    $('#scanButtonLabel').textContent = 'Yeniden tara';
  };
  const image = new Image();
  image.onload = async () => {
    try {
      if (window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) {
        try {
          const reader = new window.ZXingBrowser.BrowserMultiFormatReader();
          const result = await reader.decodeFromImageElement(image);
          if (scanToken !== state.scanToken) return;
          const code = result.getText().trim();
          if (/^\d{8,14}$/.test(code)) {
            $('#productQuery').value = code;
            $('#scanStatus').textContent = 'Barkod okundu: ' + code + ' · ürün aranıyor…';
            await searchProducts(code);
            if (scanToken !== state.scanToken) return;
            if (!$('#productDetail').hidden || $('#resultsList').children.length) return;
            $('#scanStatus').textContent = 'Barkod okundu ancak veri tabanında ürün eşleşmedi; şimdi ambalaj yazısı da taranıyor…';
          }
        } catch (_) { /* No readable barcode; try package text next. */ }
      }
      if (scanToken !== state.scanToken) return;
      if (!window.Tesseract || !window.Tesseract.createWorker) {
        $('#scanStatus').textContent = 'Barkod taraması yapıldı ama metin okuyucu yüklenemedi; OCR denenemedi. İnternet bağlantını kontrol et ya da ürün adını elle ara.';
        return;
      }
      $('#scanStatus').textContent = 'Barkod bulunamadı; Türkçe ambalaj yazısı okunuyor. İlk kullanımda biraz sürebilir…';
      const worker = await window.Tesseract.createWorker('tur+eng');
      let recognizedText = '';
      try {
        const result = await worker.recognize(image);
        if (scanToken !== state.scanToken) return;
        recognizedText = result && result.data ? result.data.text : '';
      } finally { await worker.terminate(); }
      const query = ocrProductQuery(recognizedText);
      if (query.length < 3) {
        $('#scanStatus').textContent = 'Barkod taraması ve ambalaj yazısı OCR denendi; okunabilir ürün adı çıkarılamadı. Daha net ve yakın bir fotoğraf çek ya da ürün adını elle yaz.';
        return;
      }
      $('#productQuery').value = query;
      $('#scanStatus').textContent = 'Barkod bulunamadı; ambalaj yazısı OCR ile “' + query + '” tahmini verdi. OCR yanlış okuyabilir, çıkan ürünü doğrula.';
      await searchProducts(query);
      if (scanToken === state.scanToken && !$('#resultsList').children.length && $('#resultsMessage').textContent.includes('eşleşen ürün bulunamadı')) {
        $('#scanStatus').textContent = 'Barkod taraması ve OCR denendi. Okunan “' + query + '” ifadesi veri tabanında eşleşmedi. Daha net fotoğrafla tekrar dene ya da ürün adını elle ara.';
      }
    } catch (_) {
      if (scanToken === state.scanToken) $('#scanStatus').textContent = 'Fotoğraf okunamadı. Daha net bir barkod/ambalaj fotoğrafı dene veya ürün adını elle yaz.';
    } finally {
      finishScan();
    }
  };
  image.onerror = () => {
    if (scanToken === state.scanToken) $('#scanStatus').textContent = 'Fotoğraf açılamadı. Başka bir JPG veya PNG dosyası dene.';
    finishScan();
  };
  image.src = scanURL;
}async function submitAuth(event) {
  event.preventDefault();
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const confirm = $('#authConfirm').value;
  if (!email || !password) { authMessage('E-posta ve şifre alanlarını doldur.'); return; }
  if (state.authMode === 'register' && password !== confirm) { authMessage('Şifreler aynı değil.'); return; }
  if (state.authMode === 'register' && password.length < 10) { authMessage('Şifre en az 10 karakter olmalı.'); return; }
  const button = $('#authSubmit');
  button.disabled = true;
  button.textContent = 'İşleniyor…';
  try {
    const endpoint = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const result = await appRequest(endpoint, { method: 'POST', body: JSON.stringify({ email, password }) });
    state.user = result.user;
    updateProfileUI();
    $('#authDialog').close();
    $('#authForm').reset();
    showToast(state.authMode === 'register' ? 'Hesabın bu prototipte oluşturuldu.' : 'Giriş yaptın.');
    if (document.body.dataset.page !== 'allergens') { window.location.href = './alerjenlerim.html'; } else { document.querySelector('#hesabim').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  } catch (error) { authMessage(error.message || 'Giriş yapılamadı.'); }
  finally {
    button.disabled = false;
    button.innerHTML = state.authMode === 'register' ? 'Hesap oluştur <span aria-hidden="true">↗</span>' : 'Giriş yap <span aria-hidden="true">↗</span>';
  }
}

$('#searchForm').addEventListener('submit', event => { event.preventDefault(); searchProducts($('#productQuery').value); });
$('#manualLabelForm').addEventListener('submit', event => {
  event.preventDefault();
  const error = $('#manualError');
  error.hidden = true;
  error.textContent = '';
  const form = event.currentTarget;
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const type = $('#manualType').value;
  const drink = type === 'drink';
  const suffix = drink ? '_100ml' : '_100g';
  const amountFields = [
    ['fat', '#manualFat'], ['saturated-fat', '#manualSatFat'], ['sugars', '#manualSugar'], ['salt', '#manualSalt'],
    ['energy-kcal', '#manualEnergy'], ['carbohydrates', '#manualCarbs'], ['proteins', '#manualProtein'], ['fiber', '#manualFiber']
  ];
  const nutrients = {};
  const entered = {};
  for (const [key, selector] of amountFields) {
    const raw = $(selector).value.trim();
    if (!raw) continue;
    const value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) {
      error.textContent = 'Besin değerleri sıfır veya daha büyük sayılar olmalı.';
      error.hidden = false;
      $(selector).focus();
      return;
    }
    entered[key] = value;
    nutrients[key + suffix] = value;
  }
  if (entered['saturated-fat'] !== undefined && entered.fat !== undefined && entered['saturated-fat'] > entered.fat) {
    error.textContent = 'Doymuş yağ, toplam yağ değerinden yüksek olamaz. Ambalajdaki değerleri tekrar kontrol et.';
    error.hidden = false;
    $('#manualSatFat').focus();
    return;
  }
  const ingredients = $('#manualIngredients').value.trim();
  if (!ingredients && !Object.keys(entered).length) {
    error.textContent = 'Etiketi değerlendirmek için en az bir besin değeri veya içerik bilgisi gir.';
    error.hidden = false;
    $('#manualIngredients').focus();
    return;
  }
  const name = $('#manualProductName').value.trim();
  const product = {
    manual_entry: true,
    product_name: name,
    product_name_tr: name,
    brands: $('#manualBrand').value.trim(),
    quantity: drink ? '100 ml etiketi' : '100 g etiketi',
    categories_tags: drink ? ['en:beverages'] : [],
    ingredients_text: ingredients,
    allergens: '',
    traces: '',
    nutriments
  };
  $('#resultsList').replaceChildren();
  setSearchMessage('Elle girdiğin etiket bilgileri görüntüleniyor. Renkler yalnızca yazdığın değerlere göre hesaplanır.', 'success');
  $('#manualEntry').open = false;
  renderProduct(product, '');
});
$('#barcodeImage').addEventListener('change', event => prepareImageFile(event.target.files && event.target.files[0]));
$('#scanImageButton').addEventListener('click', handleImageFile);
$('#clearImageButton').addEventListener('click', () => {
  state.scanToken += 1;
  state.scanBusy = false;
  state.pendingImage = null;
  $('#barcodeImage').value = '';
  $('#imagePreview').removeAttribute('src');
  $('#imagePreviewWrap').hidden = true;
  $('#scanImageButton').disabled = true;
  $('#scanButtonLabel').textContent = 'Taramayı başlat';
  if (state.previewURL) URL.revokeObjectURL(state.previewURL);
  state.previewURL = '';
  $('#scanStatus').textContent = 'Fotoğrafı seçtikten sonra “Taramayı başlat” düğmesine bas. Barkod okunamazsa ambalaj yazısı denenir.';
});
$('#dropZone').addEventListener('dragover', event => { event.preventDefault(); $('#dropZone').classList.add('dragging'); });
$('#dropZone').addEventListener('dragleave', () => $('#dropZone').classList.remove('dragging'));
$('#dropZone').addEventListener('drop', event => { event.preventDefault(); $('#dropZone').classList.remove('dragging'); prepareImageFile(event.dataTransfer.files && event.dataTransfer.files[0]); });
$('#loginTab').addEventListener('click', () => setAuthMode('login'));
$('#registerTab').addEventListener('click', () => setAuthMode('register'));
$('#authForm').addEventListener('submit', submitAuth);
$('#accountButton').addEventListener('click', () => { if (!state.user) openAuth('login'); else if (document.body.dataset.page !== 'allergens') window.location.href = './alerjenlerim.html'; else document.querySelector('#hesabim').scrollIntoView({ behavior: 'smooth' }); });
$('#createAccountButton').addEventListener('click', () => openAuth('register'));
$('#accountSectionButton').addEventListener('click', () => {
  if (state.user) { document.querySelector('#hesabim').scrollIntoView({ behavior: 'smooth' }); return; }
  openAuth('register');
});
$('#dialogCloseButton').addEventListener('click', () => $('#authDialog').close());
$('#authDialog').addEventListener('click', event => { if (event.target === $('#authDialog')) $('#authDialog').close(); });
$('#allergenForm').addEventListener('submit', async event => {
  event.preventDefault();
  const status = $('#profileSaveStatus');
  status.textContent = 'Kaydediliyor…';
  try {
    const result = await appRequest('/api/profile/allergens', { method: 'PUT', body: JSON.stringify({ allergens: getSelectedAllergens() }) });
    state.user = result.user;
    updateProfileUI();
    status.textContent = 'Kaydedildi.';
    if (state.currentProduct && !$('#productDetail').hidden) renderProduct(state.currentProduct, state.currentBarcode, false);
    showToast('Alerjen tercihin kaydedildi.');
  } catch (error) { status.textContent = error.message; }
});
$('#logoutButton').addEventListener('click', async () => {
  try { await appRequest('/api/auth/logout', { method: 'POST', body: '{}' }); }
  catch (_) { /* local UI is cleared even if the server is temporarily unavailable */ }
  state.user = null;
  updateProfileUI();
  if (state.currentProduct && !$('#productDetail').hidden) renderProduct(state.currentProduct, state.currentBarcode, false);
  showToast('Oturum kapatıldı.');
});
$('#redeemButton').addEventListener('click', async () => {
  $('#redeemButton').disabled = true;
  try {
    const result = await appRequest('/api/rewards/redeem', { method: 'POST', body: '{}' });
    state.user = result.user;
    updateProfileUI();
    const coupon = $('#couponResult');
    coupon.hidden = false;
    coupon.textContent = 'DEMO KUPONU · ' + result.code + ' · 40 TL';
  } catch (error) { showToast(error.message); updateProfileUI(); }
});
$('#menuButton').addEventListener('click', () => {
  const nav = $('.main-nav');
  const opened = nav.classList.toggle('open');
  $('#menuButton').setAttribute('aria-expanded', String(opened));
  $('#menuButton').setAttribute('aria-label', opened ? 'Menüyü kapat' : 'Menüyü aç');
});
const activePageLink = document.querySelector('.main-nav [data-page-link="' + document.body.dataset.page + '"]');
if (activePageLink) activePageLink.setAttribute('aria-current', 'page');
$$('.main-nav a').forEach(link => link.addEventListener('click', () => {
  $('.main-nav').classList.remove('open');
  $('#menuButton').setAttribute('aria-expanded', 'false');
  $$('.main-nav a').forEach(item => item.removeAttribute('aria-current'));
  link.setAttribute('aria-current', 'location');
}));
refreshMe();


