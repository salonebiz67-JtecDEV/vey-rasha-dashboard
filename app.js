/* VEY RASHA Owner Dashboard — static frontend talking directly to Supabase.
   Security model: this page holds ONLY the public publishable key. Every read/write is checked by
   Supabase Row Level Security using the signed-in user's token and the database 'owner' role. */
(() => {
  'use strict';

  if (window.top !== window.self) { window.top.location = window.self.location; return; } // anti-clickjacking

  const BUCKET = 'boutique-media';
  const CATEGORIES = [['dresses','Dresses'],['tailoring','Tailoring'],['outerwear','Outerwear'],['separates','Separates'],['handbags','Handbags'],['jewellery','Jewellery']];
  const ORDER_STATUSES = ['PENDING_REVIEW','CONFIRMED','PROCESSING','READY_FOR_DISPATCH','SHIPPED','DELIVERED','CANCELLED'];
  const PAYMENT_STATUSES = ['UNPAID','PAYMENT_PENDING','PAID','REFUNDED'];
  const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

  let sb = null, user = null, view = 'overview';
  let products = [], orders = [], alerts = [], stats = { customers: 0 };
  let orderFilter = 'ALL', sheetOpen = false, channel = null;

  /* ---------- helpers (all DOM is built with textContent: no HTML injection) ---------- */
  const $ = (s) => document.querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const label = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^\w|\s\w/g, (c) => c.toUpperCase());
  const cleanHex = (x) => (/^#[0-9a-fA-F]{6}$/.test(String(x || '')) ? x : '#D8C3A5');
  const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
  const ago = (iso) => {
    const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago';
  };
  function toast(msg, bad) {
    const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
    $('#toast-root').append(t); setTimeout(() => t.remove(), bad ? 6000 : 3500);
  }
  const fail = (e, ctx) => { console.error(ctx, e); toast((ctx ? ctx + ': ' : '') + (e && e.message ? e.message : String(e)), true); };
  window.addEventListener('error', (e) => toast('Unexpected error: ' + e.message, true));
  window.addEventListener('unhandledrejection', (e) => toast('Unexpected error: ' + (e.reason && e.reason.message || e.reason), true));
  const mediaUrl = (path) => (path && sb ? sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : '');

  function openSheet(title, body) {
    closeSheet(); sheetOpen = true;
    const root = $('#sheet-root');
    root.append(h('div', { class: 'overlay' },
      h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
        h('div', { class: 'sheet-head' }, h('h2', null, title), h('button', { class: 'btn sm', onclick: closeSheet }, 'Close')), body)));
  }
  function closeSheet() { sheetOpen = false; $('#sheet-root').replaceChildren(); }

  /* ---------- config + boot ---------- */
  function jwtRole(key) {
    try { const p = key.split('.')[1]; return JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))).role; } catch { return ''; }
  }
  function getConfig() {
    const c = window.DASHBOARD_CONFIG || {};
    let url = (c.SUPABASE_URL || '').trim(), key = (c.SUPABASE_PUBLISHABLE_KEY || '').trim();
    if (!url || !key) { try { url = localStorage.getItem('vr_dash_url') || ''; key = localStorage.getItem('vr_dash_key') || ''; } catch { /* ignore */ } }
    return { url: url.replace(/\/+$/, ''), key: key.trim() };
  }
  function configProblem(cfg) {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cfg.url)) return 'Project URL must look like https://xxxx.supabase.co';
    if (/^sb_secret_/.test(cfg.key) || jwtRole(cfg.key) === 'service_role') return 'That is a SECRET key. Never use it here. Use the publishable (anon) key.';
    if (cfg.key.length < 20) return 'Paste the publishable key from Supabase → Settings → API.';
    return '';
  }

  function renderSetup(msg) {
    const url = h('input', { type: 'text', placeholder: 'https://xxxx.supabase.co', autocomplete: 'off' });
    const key = h('input', { type: 'text', placeholder: 'sb_publishable_… or anon key', autocomplete: 'off' });
    const err = h('p', { class: 'small', style: 'color:var(--bad)' }, msg || '');
    $('#app').replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card' },
      h('h2', null, 'Connect Supabase'),
      h('p', { class: 'muted' }, 'Paste your Project URL and PUBLISHABLE key. Both are public values. Never paste a secret key.'),
      h('label', { class: 'f' }, 'Project URL'), url, h('label', { class: 'f' }, 'Publishable key'), key, err, h('div', { class: 'sp' }),
      h('button', { class: 'btn primary', onclick: () => {
        const cfg = { url: url.value.trim().replace(/\/+$/, ''), key: key.value.trim() };
        const p = configProblem(cfg); if (p) { err.textContent = p; return; }
        try { localStorage.setItem('vr_dash_url', cfg.url); localStorage.setItem('vr_dash_key', cfg.key); } catch { /* ignore */ }
        boot();
      } }, 'Save and continue'))));
  }

  function renderLogin(note) {
    const email = h('input', { type: 'text', inputmode: 'email', autocomplete: 'username', placeholder: 'owner email' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
    const err = h('p', { class: 'small', style: 'color:var(--bad)' }, note || '');
    const btn = h('button', { class: 'btn primary', type: 'button' }, 'Sign in');
    const submit = async () => {
      if (!email.value.trim() || !pass.value) { err.textContent = 'Enter your email and password.'; return; }
      btn.disabled = true; err.textContent = '';
      const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
      if (error) { err.textContent = 'Sign-in failed. Check your email and password.'; btn.disabled = false; return; }
      await enter();
    };
    btn.addEventListener('click', submit);
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    $('#app').replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card' },
      h('div', { class: 'brand' }, 'VEY RASHA'), h('h2', { style: 'margin-top:6px' }, 'Owner Dashboard'),
      h('p', { class: 'muted' }, 'Owner sign-in only.'),
      h('label', { class: 'f' }, 'Email'), email, h('label', { class: 'f' }, 'Password'), pass, err, h('div', { class: 'sp' }), btn)));
  }

  function renderDenied() {
    const sql = `insert into public.user_roles (user_id, role)\nvalues ('${user.id}', 'owner')\non conflict (user_id, role) do nothing;`;
    $('#app').replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card' },
      h('h2', null, 'Owner access needed'),
      h('p', { class: 'muted' }, 'You are signed in as ' + (user.email || 'this account') + ', but it is not marked as the boutique owner. If this is YOUR account, run this once in Supabase → SQL Editor, then reload:'),
      h('pre', null, sql),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn sm', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(sql).then(() => toast('SQL copied')); } }, 'Copy SQL'),
        h('button', { class: 'btn sm', onclick: () => location.reload() }, 'Reload'),
        h('button', { class: 'btn sm', onclick: () => sb.auth.signOut() }, 'Sign out')))));
  }

  async function boot() {
    const cfg = getConfig();
    if (!cfg.url || !cfg.key) return renderSetup();
    const problem = configProblem(cfg);
    if (problem) return renderSetup(problem);
    if (!window.supabase) return renderSetup('Could not load the Supabase library. Check your internet connection.');
    sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_OUT') { teardown(); renderLogin(); } });
    await enter();
  }

  async function enter() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return renderLogin();
    user = session.user;
    const { data, error } = await sb.from('user_roles').select('role').eq('user_id', user.id).eq('role', 'owner').maybeSingle();
    if (error) { fail(error, 'Role check'); return renderLogin('Could not verify your role.'); }
    if (!data) return renderDenied();
    startApp();
  }

  function teardown() { if (channel) { sb.removeChannel(channel); channel = null; } user = null; products = []; orders = []; alerts = []; }

  /* ---------- data ---------- */
  async function loadProducts() {
    const { data, error } = await sb.from('products').select('*, product_images(*), product_variants(*)').order('created_at', { ascending: false });
    if (error) return fail(error, 'Loading products'); products = data || [];
  }
  async function loadOrders() {
    const { data, error } = await sb.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }).limit(200);
    if (error) return fail(error, 'Loading orders'); orders = data || [];
  }
  async function loadAlerts() {
    const { data, error } = await sb.from('notifications').select('*').eq('target_role', 'owner').order('created_at', { ascending: false }).limit(60);
    if (error) return fail(error, 'Loading alerts'); alerts = data || [];
  }
  async function loadStats() {
    const { count, error } = await sb.from('profiles').select('id', { count: 'exact', head: true });
    if (!error) stats.customers = count || 0;
  }
  const unread = () => alerts.filter((a) => !a.is_read).length;
  const pendingCount = () => orders.filter((o) => o.order_status === 'PENDING_REVIEW').length;

  async function startApp() {
    $('#app').replaceChildren(h('div', { class: 'shell' },
      h('div', { class: 'topbar' },
        h('div', { class: 'brand' }, 'VEY RASHA', h('small', null, 'Owner Dashboard')),
        h('button', { class: 'btn sm', onclick: () => sb.auth.signOut() }, 'Sign out')),
      h('main', { id: 'main' }, h('p', { class: 'muted' }, 'Loading…')),
      h('nav', { class: 'nav', id: 'nav' })));
    await Promise.all([loadProducts(), loadOrders(), loadAlerts(), loadStats()]);
    render(); subscribe();
  }

  function subscribe() {
    channel = sb.channel('owner-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, async () => { await loadOrders(); if (!sheetOpen) render(); else renderNav(); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, async (p) => {
        if (p.new && p.new.target_role === 'owner') { toast('🔔 ' + p.new.title); await loadAlerts(); if (!sheetOpen) render(); else renderNav(); }
      })
      .subscribe();
  }

  /* ---------- shell ---------- */
  function renderNav() {
    const items = [['overview', 'Overview', 0], ['products', 'Products', 0], ['orders', 'Orders', pendingCount()], ['alerts', 'Alerts', unread()]];
    $('#nav').replaceChildren(...items.map(([id, name, n]) =>
      h('button', { class: view === id ? 'on' : '', onclick: () => go(id) }, name, n ? h('span', { class: 'badge' }, n) : null)));
  }
  function go(v) { view = v; render(); window.scrollTo(0, 0); }
  function render() {
    renderNav();
    const main = $('#main'); if (!main) return;
    document.querySelectorAll('.fab').forEach((n) => n.remove());
    ({ overview: viewOverview, products: viewProducts, orders: viewOrders, alerts: viewAlerts }[view])(main);
  }

  /* ---------- overview ---------- */
  function viewOverview(main) {
    const published = products.filter((p) => p.is_published).length;
    const stat = (n, t) => h('div', { class: 'card stat' }, h('b', null, n), h('span', null, t));
    main.replaceChildren(
      h('h1', null, 'Overview'), h('div', { class: 'sp' }),
      h('div', { class: 'grid stats' },
        stat(products.length, 'Products (' + published + ' live)'), stat(pendingCount(), 'Orders to review'),
        stat(orders.length, 'Total orders'), stat(stats.customers, 'Customers signed up')),
      h('div', { class: 'sp' }),
      h('div', { class: 'card' }, h('h3', null, 'Recent orders'), h('div', { class: 'sp' }),
        orders.length ? h('div', { class: 'list' }, orders.slice(0, 5).map(orderRow)) : h('p', { class: 'muted' }, 'No orders yet.')),
      h('div', { class: 'sp' }),
      h('div', { class: 'card' }, h('h3', null, 'Coming next'),
        h('p', { class: 'muted' }, 'Likes and views per product, live app errors, and active users will be added in the next step.')));
  }

  /* ---------- products ---------- */
  function viewProducts(main) {
    main.replaceChildren(h('h1', null, 'Products'), h('div', { class: 'sp' }),
      products.length ? h('div', { class: 'list' }, products.map(productRow))
        : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No products yet. Tap “+ New product” to post your first one.')));
    document.body.append(h('button', { class: 'btn primary fab', onclick: () => openProductForm(null) }, '+ New product'));
  }
  function primaryImage(p) {
    const imgs = [...(p.product_images || [])].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.sort_order - b.sort_order);
    return imgs[0] ? mediaUrl(imgs[0].storage_path) : '';
  }
  function productRow(p) {
    const url = primaryImage(p), stock = (p.product_variants || []).reduce((s, v) => s + (v.stock_count || 0), 0);
    return h('div', { class: 'card item', onclick: () => openProductForm(p) },
      url ? h('img', { class: 'thumb', src: url, alt: '' }) : h('div', { class: 'thumb' }, 'No photo'),
      h('div', { class: 'grow' }, h('b', null, p.name), h('div', { class: 'muted small' }, p.category_label + ' · ' + money.format(Number(p.price_usd)) + ' · stock ' + stock)),
      h('span', { class: 'chip ' + (p.is_published ? 'ok' : 'warn') }, p.is_published ? 'Live' : 'Draft'));
  }

  function resizeImage(file) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!/^image\//.test(file.type)) throw new Error('Only image files are allowed.');
        if (file.size > 25 * 1024 * 1024) throw new Error('Image is too large (max 25 MB).');
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        c.toBlob((b) => b ? resolve({ blob: b, type: b.type }) : reject(new Error('Could not process image.')), 'image/webp', 0.85);
      } catch (e) { reject(e); }
    });
  }
  const parseList = (s, max, len) => [...new Set(String(s).split(',').map((x) => x.trim().slice(0, len)).filter(Boolean))].slice(0, max);

  function openProductForm(p) {
    const isNew = !p;
    const stock = new Map(); // "size|color" -> number
    (p?.product_variants || []).forEach((v) => stock.set(v.size + '|' + v.color_name, v.stock_count));
    const images = (p?.product_images || []).sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.sort_order - b.sort_order)
      .map((i) => ({ id: i.id, path: i.storage_path, url: mediaUrl(i.storage_path) }));
    const removed = [];
    const colors = [];
    const seen = new Set(); (p?.product_variants || []).forEach((v) => { if (!seen.has(v.color_name)) { seen.add(v.color_name); colors.push({ name: v.color_name, hex: cleanHex(v.color_hex) }); } });
    if (!colors.length) colors.push({ name: '', hex: '#D8C3A5' });
    const sizesInit = [...new Set((p?.product_variants || []).map((v) => v.size))].join(', ');

    const f = {
      name: h('input', { type: 'text', maxlength: 120, value: p?.name || '' }),
      subtitle: h('input', { type: 'text', maxlength: 160, value: p?.subtitle || '' }),
      category: h('select', null, CATEGORIES.map(([s, l]) => h('option', { value: s, selected: (p?.category_slug || 'dresses') === s }, l))),
      price: h('input', { type: 'number', min: 0, step: '0.01', inputmode: 'decimal', value: p ? Number(p.price_usd) : '' }),
      desc: h('textarea', { maxlength: 2000 }, p?.description || ''),
      material: h('input', { type: 'text', maxlength: 160, value: p?.material || '' }),
      care: h('input', { type: 'text', maxlength: 200, value: p?.care || '' }),
      isNew: h('input', { type: 'checkbox', checked: p?.is_new_arrival }),
      isBest: h('input', { type: 'checkbox', checked: p?.is_best_seller }),
      pub: h('input', { type: 'checkbox', checked: p ? p.is_published : false }),
      sizes: h('input', { type: 'text', placeholder: 'S, M, L  (or: One Size)', value: sizesInit }),
    };
    const imgBox = h('div', { class: 'imgs' }), colorBox = h('div'), gridBox = h('div');
    const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, onchange: () => {
      for (const file of fileInput.files) images.push({ file, url: URL.createObjectURL(file) });
      fileInput.value = ''; drawImages();
    } });

    function drawImages() {
      imgBox.replaceChildren(...images.map((im, idx) => h('div', { class: 'img' },
        h('img', { src: im.url, alt: '' }), idx === 0 ? h('span', { class: 'cover' }, 'Cover') : null,
        idx !== 0 ? h('button', { class: 'btn', type: 'button', onclick: () => { images.splice(idx, 1); images.unshift(im); drawImages(); } }, 'Make cover') : null,
        h('button', { class: 'btn danger', type: 'button', onclick: () => { if (im.id) removed.push(im); images.splice(idx, 1); drawImages(); } }, 'Remove'))));
      if (!images.length) imgBox.append(h('p', { class: 'muted small' }, 'No photos yet.'));
    }
    function drawColors() {
      colorBox.replaceChildren(...colors.map((c, i) => h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('span', { class: 'swatch', style: 'background:' + cleanHex(c.hex) }),
        h('input', { type: 'text', placeholder: 'Colour name (e.g. Ivory)', maxlength: 30, value: c.name, oninput: (e) => { c.name = e.target.value; drawGrid(); } }),
        h('input', { type: 'text', style: 'width:96px', maxlength: 7, value: c.hex, oninput: (e) => { c.hex = e.target.value; } }),
        colors.length > 1 ? h('button', { class: 'btn sm danger', type: 'button', onclick: () => { colors.splice(i, 1); drawColors(); drawGrid(); } }, '✕') : null)));
    }
    function currentVariants() {
      const sizes = parseList(f.sizes.value, 12, 20), names = [...new Set(colors.map((c) => c.name.trim()).filter(Boolean))].slice(0, 12);
      const out = []; for (const s of sizes) for (const n of names) { const c = colors.find((x) => x.name.trim() === n); out.push({ size: s, color_name: n, color_hex: cleanHex(c.hex) }); }
      return out;
    }
    function drawGrid() {
      const vs = currentVariants();
      if (!vs.length) { gridBox.replaceChildren(h('p', { class: 'muted small' }, 'Add at least one size and one colour to set stock.')); return; }
      gridBox.replaceChildren(h('table', { class: 'vt' }, h('tr', null, h('th', null, 'Size'), h('th', null, 'Colour'), h('th', null, 'Stock')),
        vs.map((v) => { const k = v.size + '|' + v.color_name; return h('
