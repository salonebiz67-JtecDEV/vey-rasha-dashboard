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
    $('#app').replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card' },
      h('div', { class: 'brand' }, 'VEY RASHA'), h('h2', { style: 'margin-top:6px' }, 'Owner Dashboard'),
      h('p', { class: 'muted' }, 'Sign in with the Google account that owns the boutique.'),
      note ? h('p', { class: 'small', style: 'color:var(--bad)' }, note) : null,
      h('button', { class: 'btn primary', onclick: async () => {
        const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
        if (error) fail(error, 'Sign-in');
      } }, 'Continue with Google'))));
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
    sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_OUT') { teardown(); renderLogin(); } });
    const { data: { session } } = await sb.auth.getSession();
    if (location.search.includes('code=')) history.replaceState(null, '', location.pathname);
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
        vs.map((v) => { const k = v.size + '|' + v.color_name; return h('tr', null, h('td', null, v.size), h('td', null, v.color_name),
          h('td', null, h('input', { type: 'number', min: 0, max: 9999, inputmode: 'numeric', value: stock.has(k) ? stock.get(k) : 1, oninput: (e) => stock.set(k, Math.max(0, parseInt(e.target.value || '0', 10) || 0)) }))); })));
      vs.forEach((v) => { const k = v.size + '|' + v.color_name; if (!stock.has(k)) stock.set(k, 1); });
    }
    f.sizes.addEventListener('input', drawGrid);

    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, isNew ? 'Post product' : 'Save changes');
    saveBtn.addEventListener('click', async () => {
      const name = f.name.value.trim(), price = Number(f.price.value), variants = currentVariants();
      if (!name) return toast('Please enter a product name.', true);
      if (!Number.isFinite(price) || price < 0) return toast('Please enter a valid price.', true);
      if (f.pub.checked && !variants.length) return toast('Add sizes and colours before making it live.', true);
      if (f.pub.checked && !images.length) return toast('Add at least one photo before making it live.', true);
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        await saveProduct(p, {
          name, subtitle: f.subtitle.value.trim(), category: f.category.value, price, description: f.desc.value.trim(),
          material: f.material.value.trim(), care: f.care.value.trim(), isNew: f.isNew.checked, isBest: f.isBest.checked, pub: f.pub.checked,
        }, images, removed, variants.map((v) => ({ ...v, stock_count: stock.get(v.size + '|' + v.color_name) ?? 0 })));
        closeSheet(); await loadProducts(); render(); toast(isNew ? 'Product posted ✔' : 'Saved ✔');
      } catch (e) { fail(e, 'Saving product'); saveBtn.disabled = false; saveBtn.textContent = isNew ? 'Post product' : 'Save changes'; }
    });

    const field = (t, el) => [h('label', { class: 'f' }, t), el];
    const check = (t, el) => h('label', { class: 'row', style: 'margin:8px 0' }, el, h('span', null, t));
    openSheet(isNew ? 'New product' : 'Edit product', h('div', null,
      field('Name', f.name), field('Subtitle (optional)', f.subtitle), field('Category', f.category), field('Price (USD)', f.price),
      field('Description', f.desc), field('Material', f.material), field('Care', f.care),
      h('label', { class: 'f' }, 'Photos'), imgBox, h('div', { class: 'sp' }), fileInput,
      field('Sizes (comma separated)', f.sizes), h('label', { class: 'f' }, 'Colours'), colorBox,
      h('button', { class: 'btn sm', type: 'button', onclick: () => { colors.push({ name: '', hex: '#D8C3A5' }); drawColors(); } }, '+ Add colour'),
      h('label', { class: 'f' }, 'Stock per size & colour'), gridBox, h('hr'),
      check('New arrival', f.isNew), check('Best seller', f.isBest), check('Live in the shop (visible to customers)', f.pub), h('div', { class: 'sp' }),
      h('div', { class: 'row wrap' }, saveBtn,
        !isNew ? h('button', { class: 'btn danger', type: 'button', onclick: () => deleteProduct(p) }, 'Delete') : null)));
    drawImages(); drawColors(); drawGrid();
  }

  async function saveProduct(existing, v, images, removed, variants) {
    const row = {
      name: v.name, subtitle: v.subtitle, category_slug: v.category, category_label: (CATEGORIES.find((c) => c[0] === v.category) || [])[1] || 'Collection',
      description: v.description, material: v.material, care: v.care, price_usd: v.price, is_new_arrival: v.isNew, is_best_seller: v.isBest,
    };
    const uploaded = [];
    let id = existing?.id;
    try {
      if (!existing) {
        const { data, error } = await sb.from('products').insert({ ...row, slug: slugify(v.name) + '-' + Math.random().toString(36).slice(2, 7), is_published: false }).select('id').single();
        if (error) throw error; id = data.id;
      } else {
        const { error } = await sb.from('products').update(row).eq('id', id); if (error) throw error;
      }
      // remove deleted photos
      if (removed.length) {
        const { error } = await sb.from('product_images').delete().in('id', removed.map((r) => r.id)); if (error) throw error;
        await sb.storage.from(BUCKET).remove(removed.map((r) => r.path));
      }
      // upload new photos
      for (const im of images) {
        if (!im.file) continue;
        const { blob, type } = await resizeImage(im.file);
        const path = `products/${id}/${crypto.randomUUID()}.${type === 'image/webp' ? 'webp' : 'png'}`;
        const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: type, cacheControl: '31536000', upsert: false });
        if (error) throw error; uploaded.push(path);
        const ins = await sb.from('product_images').insert({ product_id: id, storage_path: path, alt_text: v.name, sort_order: 0, is_primary: false, mime_type: type, size_bytes: blob.size }).select('id').single();
        if (ins.error) throw ins.error; im.id = ins.data.id; im.path = path;
      }
      // order + cover
      for (let i = 0; i < images.length; i++) {
        const { error } = await sb.from('product_images').update({ sort_order: i, is_primary: i === 0 }).eq('id', images[i].id); if (error) throw error;
      }
      // variants
      const keep = new Set(variants.map((x) => x.size + '|' + x.color_name));
      const old = existing?.product_variants || [];
      const drop = old.filter((o) => !keep.has(o.size + '|' + o.color_name)).map((o) => o.id);
      if (drop.length) { const { error } = await sb.from('product_variants').delete().in('id', drop); if (error) throw error; }
      if (variants.length) {
        const { error } = await sb.from('product_variants').upsert(variants.map((x) => ({ product_id: id, size: x.size, color_name: x.color_name, color_hex: x.color_hex, stock_count: x.stock_count, is_available: true })), { onConflict: 'product_id,size,color_name' });
        if (error) throw error;
      }
      const { error } = await sb.from('products').update({ is_published: v.pub }).eq('id', id); if (error) throw error;
    } catch (e) {
      if (!existing && id) { // roll back a half-created product
        await sb.from('products').delete().eq('id', id);
        if (uploaded.length) await sb.storage.from(BUCKET).remove(uploaded);
      }
      throw e;
    }
  }

  async function deleteProduct(p) {
    if (!confirm('Delete “' + p.name + '” permanently? Past orders keep their saved details.')) return;
    try {
      const paths = (p.product_images || []).map((i) => i.storage_path); if (paths.length) await sb.storage.from(BUCKET).remove(paths);
      const { error } = await sb.from('products').delete().eq('id', p.id); if (error) throw error;
      closeSheet(); await loadProducts(); render(); toast('Product deleted');
    } catch (e) { fail(e, 'Deleting product'); }
  }

  /* ---------- orders ---------- */
  const statusClass = (s) => (s === 'DELIVERED' ? 'ok' : s === 'CANCELLED' ? 'bad' : s === 'PENDING_REVIEW' ? 'warn' : '');
  function orderRow(o) {
    return h('div', { class: 'card item', onclick: () => openOrder(o.id) },
      h('div', { class: 'grow' }, h('b', null, o.order_reference), h('div', { class: 'muted small' }, o.customer_full_name + ' · ' + o.customer_city + ' · ' + ago(o.created_at))),
      h('div', { style: 'text-align:right' }, h('div', null, money.format(Number(o.final_total_usd ?? o.subtotal_usd))), h('span', { class: 'chip ' + statusClass(o.order_status) }, label(o.order_status))));
  }
  function viewOrders(main) {
    const opts = ['ALL', ...ORDER_STATUSES];
    const list = orders.filter((o) => orderFilter === 'ALL' || o.order_status === orderFilter);
    main.replaceChildren(h('h1', null, 'Orders'), h('div', { class: 'sp' }),
      h('div', { class: 'chips' }, opts.map((s) => h('button', { class: 'btn sm' + (orderFilter === s ? ' on' : ''), onclick: () => { orderFilter = s; render(); } }, s === 'ALL' ? 'All' : label(s)))),
      list.length ? h('div', { class: 'list' }, list.map(orderRow)) : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No orders here.')));
  }

  function openOrder(id) {
    const o = orders.find((x) => x.id === id); if (!o) return;
    const items = o.order_items || [];
    const kv = (k, v) => [h('dt', null, k), h('dd', null, v || '—')];
    const fee = h('input', { type: 'number', min: 0, step: '0.01', inputmode: 'decimal', placeholder: 'Delivery fee (USD)', value: o.delivery_fee_usd ?? '' });
    const eta = h('input', { type: 'text', maxlength: 120, placeholder: 'e.g. 2–3 days', value: o.estimated_delivery_time || '' });
    const msg = h('textarea', { maxlength: 600, placeholder: 'Message to the customer (optional)' }, o.owner_message || '');
    const sel = h('select', null, ORDER_STATUSES.map((s) => h('option', { value: s, selected: o.order_status === s }, label(s))));
    const pay = h('select', null, PAYMENT_STATUSES.map((s) => h('option', { value: s, selected: o.payment_status === s }, label(s))));
    const act = async (fn, ok) => { try { await fn(); await loadOrders(); closeSheet(); render(); toast(ok); } catch (e) { fail(e, 'Order update'); } };
    const actions = o.order_status === 'PENDING_REVIEW'
      ? h('div', null, h('h3', null, 'Review this order'), h('p', { class: 'muted small' }, 'Add the delivery fee and delivery time, then accept. The customer is notified instantly.'),
          h('label', { class: 'f' }, 'Delivery fee (USD)'), fee, h('label', { class: 'f' }, 'Estimated delivery'), eta, h('label', { class: 'f' }, 'Message'), msg, h('div', { class: 'sp' }),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn primary', onclick: () => act(() => acceptOrder(o, fee.value, eta.value, msg.value), 'Order accepted ✔') }, 'Accept order'),
            h('button', { class: 'btn danger', onclick: () => confirm('Decline and cancel this order?') && act(() => setStatus(o, 'CANCELLED', eta.value, msg.value), 'Order cancelled') }, 'Decline')))
      : h('div', null, h('h3', null, 'Update progress'), h('label', { class: 'f' }, 'Status'), sel, h('label', { class: 'f' }, 'Estimated delivery'), eta, h('label', { class: 'f' }, 'Message to customer'), msg, h('div', { class: 'sp' }),
          h('button', { class: 'btn primary', onclick: () => act(() => setStatus(o, sel.value, eta.value, msg.value), 'Status updated ✔') }, 'Update & notify customer'));
    openSheet(o.order_reference, h('div', null,
      h('div', { class: 'row wrap' }, h('span', { class: 'chip ' + statusClass(o.order_status) }, label(o.order_status)), h('span', { class: 'chip' }, 'Payment: ' + label(o.payment_status)), h('span', { class: 'muted small' }, ago(o.created_at))),
      h('div', { class: 'sp' }),
      h('dl', { class: 'kv' }, kv('Customer', o.customer_full_name), kv('Phone', o.customer_phone), kv('Address', [o.customer_delivery_address, o.customer_area, o.customer_city, o.customer_country].filter(Boolean).join(', ')),
        kv('Instructions', o.customer_delivery_instructions), kv('Gift wrap', o.gift_presentation ? 'Yes' : 'No')),
      h('hr'), h('h3', null, 'Items'), h('div', { class: 'sp' }),
      h('div', { class: 'list' }, items.map((it) => h('div', { class: 'row spread' },
        h('div', { class: 'grow' }, h('b', null, it.product_name_snapshot), h('div', { class: 'muted small' }, it.size_snapshot + ' · ' + it.color_name_snapshot + ' · ×' + it.quantity)),
        h('div', null, money.format(Number(it.line_total_usd)))))),
      h('hr'),
      h('dl', { class: 'kv' }, kv('Subtotal', money.format(Number(o.subtotal_usd))), kv('Delivery', o.delivery_fee_usd == null ? 'Not set' : money.format(Number(o.delivery_fee_usd))),
        kv('Total', o.final_total_usd == null ? 'Pending your review' : money.format(Number(o.final_total_usd)))),
      h('hr'), actions, h('hr'),
      h('h3', null, 'Payment'), h('label', { class: 'f' }, 'Payment status'), pay, h('div', { class: 'sp' }),
      h('button', { class: 'btn', onclick: () => act(async () => { const { error } = await sb.from('orders').update({ payment_status: pay.value }).eq('id', o.id); if (error) throw error; }, 'Payment updated ✔') }, 'Save payment status')));
  }

  async function notifyCustomer(o, type, typeLabel, title, message, extra) {
    const { error } = await sb.from('notifications').insert({ user_id: o.user_id, target_role: 'customer', order_id: o.id, order_reference: o.order_reference, type, type_label: typeLabel,
      title, message, is_read: false, action_route: 'account', currency_code: o.currency_at_order, ...extra });
    if (error) throw error;
  }
  async function acceptOrder(o, feeRaw, eta, msg) {
    const fee = Number(feeRaw);
    if (feeRaw === '' || !Number.isFinite(fee) || fee < 0) throw new Error('Enter a delivery fee of 0 or more.');
    const f2 = Number(fee.toFixed(2)), total = Number((Number(o.subtotal_usd) + f2).toFixed(2));
    const { data, error } = await sb.from('orders').update({ order_status: 'CONFIRMED', delivery_fee_usd: f2, final_total_usd: total,
      estimated_delivery_time: eta.trim() || null, owner_message: msg.trim() || null, confirmed_at: o.confirmed_at || new Date().toISOString() })
      .eq('id', o.id).eq('order_status', 'PENDING_REVIEW').select('id');
    if (error) throw error; if (!data || !data.length) throw new Error('This order was already handled. Refresh and try again.');
    await notifyCustomer(o, 'order_update', 'Order Update', 'Order Confirmed — ' + o.order_reference,
      msg.trim() || 'VEY RASHA has accepted your order and confirmed your delivery fee and final order total.',
      { confirmed_delivery_fee_usd: f2, confirmed_final_total_usd: total, estimated_delivery_time: eta.trim() || null });
  }
  async function setStatus(o, status, eta, msg) {
    if (!ORDER_STATUSES.includes(status)) throw new Error('Invalid status.');
    const { data, error } = await sb.from('orders').update({ order_status: status, owner_message: msg.trim() || null, estimated_delivery_time: eta.trim() || null,
      confirmed_at: status !== 'PENDING_REVIEW' && status !== 'CANCELLED' && !o.confirmed_at ? new Date().toISOString() : o.confirmed_at }).eq('id', o.id).select('*').single();
    if (error) throw error;
    const milestone = ['READY_FOR_DISPATCH', 'SHIPPED', 'DELIVERED'].includes(status);
    await notifyCustomer(o, milestone ? 'delivery_update' : 'order_update', milestone ? 'Delivery Update' : 'Order Update',
      'Order ' + status.replace(/_/g, ' ') + ' — ' + o.order_reference,
      msg.trim() || 'Your order status has been updated to ' + label(status).toLowerCase() + '.',
      { confirmed_delivery_fee_usd: data.delivery_fee_usd, confirmed_final_total_usd: data.final_total_usd, estimated_delivery_time: data.estimated_delivery_time });
  }

  /* ---------- alerts ---------- */
  function viewAlerts(main) {
    main.replaceChildren(h('div', { class: 'row spread' }, h('h1', null, 'Alerts'),
      unread() ? h('button', { class: 'btn sm', onclick: async () => { const { error } = await sb.from('notifications').update({ is_read: true }).eq('target_role', 'owner').eq('is_read', false); if (error) return fail(error, 'Marking read'); await loadAlerts(); render(); } }, 'Mark all read') : null),
      h('div', { class: 'sp' }),
      alerts.length ? h('div', { class: 'list' }, alerts.map((a) => h('div', { class: 'card item', onclick: () => { if (a.order_id) openOrder(a.order_id); } },
        h('div', { class: 'grow' }, h('b', null, a.title), h('div', { class: 'muted small' }, a.message), h('div', { class: 'muted small' }, ago(a.created_at))),
        a.is_read ? null : h('span', { class: 'badge' }, 'new'))))
        : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No alerts yet. New order requests will appear here instantly.')));
  }

  boot().catch((e) => fail(e, 'Startup'));
})();
