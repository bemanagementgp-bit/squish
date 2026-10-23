/* ===== Shared monetization + theme helpers. Reads window.APP_CONFIG from config.js ===== */
(function () {
  const C = window.APP_CONFIG || {};

  // ---- Theme ----
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  else if (matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.setAttribute('data-theme', 'light');
  window.toggleTheme = function () {
    const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', cur);
    localStorage.setItem('theme', cur);
  };

  // ---- Toast ----
  let toastEl = null;
  window.toast = function (msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastEl._h); toastEl._h = setTimeout(() => toastEl.classList.remove('show'), 2200);
  };

  // ---- Analytics (GA4) – only if configured ----
  if (C.GA_ID) {
    const s = document.createElement('script'); s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + C.GA_ID; document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag('js', new Date()); gtag('config', C.GA_ID);
  }
  window.track = function (ev, params) { if (window.gtag) gtag('event', ev, params || {}); };

  // ---- AdSense – only if configured; otherwise slots show a placeholder ----
  function mountAds() {
    if (!C.ADSENSE_CLIENT) return;
    const s = document.createElement('script'); s.async = true; s.crossOrigin = 'anonymous';
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + C.ADSENSE_CLIENT;
    document.head.appendChild(s);
    document.querySelectorAll('.ad-slot').forEach(el => {
      const ins = document.createElement('ins'); ins.className = 'adsbygoogle'; ins.style.display = 'block';
      ins.setAttribute('data-ad-client', C.ADSENSE_CLIENT);
      ins.setAttribute('data-ad-slot', el.dataset.slot || '');
      ins.setAttribute('data-ad-format', 'auto'); ins.setAttribute('data-full-width-responsive', 'true');
      el.appendChild(ins); (window.adsbygoogle = window.adsbygoogle || []).push({});
    });
  }

  // ---- Pro / payments ----
  window.isPro = function () { return localStorage.getItem('pro_license') === '1'; };
  window.openPro = function (source) {
    track('pro_click', { source: source || 'unknown' });
    const m = document.getElementById('proModal');
    if (m) { m.classList.add('open'); return; }
    if (C.PRO_CHECKOUT_URL) window.open(C.PRO_CHECKOUT_URL, '_blank');
  };
  window.closePro = function () { const m = document.getElementById('proModal'); if (m) m.classList.remove('open'); };
  window.goCheckout = function () {
    track('begin_checkout', {});
    if (C.PRO_CHECKOUT_URL) window.open(C.PRO_CHECKOUT_URL, '_blank');
    else toast('Checkout not configured yet. Set PRO_CHECKOUT_URL in config.js');
  };
  // Simple license gate: user pastes the key from the purchase email.
  // Replace with real validation (e.g. Lemon Squeezy license API) when live.
  window.activateLicense = function (key) {
    key = (key || '').trim();
    if (key.length >= 8) {
      localStorage.setItem('pro_license', '1');
      toast('Pro activated 🎉'); closePro();
      document.dispatchEvent(new Event('pro:changed'));
      return true;
    }
    toast('Invalid license key'); return false;
  };

  document.addEventListener('DOMContentLoaded', () => {
    mountAds();
    document.querySelectorAll('[data-year]').forEach(el => el.textContent = new Date().getFullYear());
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closePro(); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePro(); });
  });
})();
