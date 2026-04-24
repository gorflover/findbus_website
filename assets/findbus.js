/* ═══════════════════════════════════════════════════════════════════════
 * FindBus 找巴 — 場次詳情頁 + 列表頁共用邏輯
 * ═══════════════════════════════════════════════════════════════════════
 * 用法（head 要有 Supabase preconnect）：
 *   詳情頁：
 *     <script>window.FINDBUS_EVENT_ID = 'laufey';</script>
 *     <script src="/assets/findbus.js" async></script>
 *   列表頁：
 *     <script src="/assets/findbus.js" async></script>
 *     （每張 .event-card 帶 data-event-id）
 * ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Supabase ─────────────────────────────────────────────────────
  const SUPABASE_URL = 'https://olnqelggbiuuitgnvciv.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sbnFlbGdnYml1dWl0Z252Y2l2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NjU3OTcsImV4cCI6MjA5MjQ0MTc5N30.OOwNenoh8yEomEkqjSjYqbrC76P5in2yn2MF_usksaQ';
  const REST = SUPABASE_URL + '/rest/v1';
  const H = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    'Content-Type': 'application/json'
  };

  async function sbSelect(path) {
    const res = await fetch(REST + path, { headers: H });
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + (await res.text()));
    return res.json();
  }
  async function sbInsert(table, payload) {
    const res = await fetch(REST + '/' + table, {
      method: 'POST',
      headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const body = await res.text();
      const err = new Error('Supabase ' + res.status);
      err.status = res.status;
      err.body = body;
      throw err;
    }
  }

  function isDuplicateError(err) {
    const body = String(err?.body || '');
    try {
      const parsed = JSON.parse(body);
      if (parsed.code === '23505') return true;
    } catch (_) {}
    return /23505|duplicate|unique/i.test(body);
  }

  // ─── localStorage key ─────────────────────────────────────────────
  const LS_PREFIX = 'findbus:signed:';
  const sigKey = (id) => LS_PREFIX + id;
  function getSigned(id) { try { return !!localStorage.getItem(sigKey(id)); } catch (_) { return false; } }
  function setSigned(id, meta) { try { localStorage.setItem(sigKey(id), JSON.stringify({ at: Date.now(), ...meta })); } catch (_) {} }

  // ─── 模組狀態 ─────────────────────────────────────────────────────
  const EVENT_ID = window.FINDBUS_EVENT_ID || null;
  let eventData = null;
  let agreed = false;
  let addonActive = false;
  let submitting = false;

  // ─── 立刻發 fetch ─────────────────────────────────────────────────
  const eventPromise = EVENT_ID
    ? sbSelect(
        '/event_counts?id=eq.' +
          encodeURIComponent(EVENT_ID) +
          '&select=id,capacity,min_to_run,price_return,price_oneway_addon,display_count,status'
      )
        .then((arr) => arr[0] || null)
        .catch((e) => {
          console.warn('[FindBus] 載入場次失敗：', e.message);
          return null;
        })
    : null;

  // ─── 套用場次資料 ─────────────────────────────────────────────────
  function applyEventData(d) {
    if (!d) return;
    eventData = d;
    const { capacity, min_to_run, display_count, price_return, price_oneway_addon } = d;

    const pct = Math.min(100, Math.round((display_count / capacity) * 100));
    const fill = document.getElementById('seatsFill');
    const text = document.getElementById('seatsText');
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = `${display_count}/${capacity} 人已報名・${min_to_run} 人成團`;

    const amountEl = document.querySelector('.card-price .amount');
    if (amountEl) amountEl.textContent = price_return;
    const addonEl = document.querySelector('.addon-price-text');
    if (addonEl) addonEl.textContent = '+$' + price_oneway_addon;

    updateTotal();
  }

  // ─── 價格 ─────────────────────────────────────────────────────────
  function priceReturn() {
    if (eventData) return eventData.price_return;
    const t = document.querySelector('.card-price .amount')?.textContent || '0';
    return parseInt(t, 10) || 0;
  }
  function priceAddon() {
    if (eventData) return eventData.price_oneway_addon;
    const t = document.querySelector('.addon-price-text')?.textContent || '';
    return parseInt(t.replace(/\D/g, ''), 10) || 0;
  }
  function totalAmount() {
    return addonActive ? priceReturn() + priceAddon() : priceReturn();
  }
  function updateTotal() {
    const el = document.getElementById('totalText');
    if (el) el.textContent = 'NT$' + totalAmount();
  }

  // ─── UI handlers ──────────────────────────────────────────────────
  function expandPanel() {
    const card = document.getElementById('mainCard');
    if (!card) return;
    card.classList.add('expanded');
    setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  }
  function toggleAgree() {
    agreed = !agreed;
    document.getElementById('agreeRow')?.classList.toggle('checked', agreed);
    updateSubmitState();
  }
  function toggleAddon() {
    addonActive = !addonActive;
    document.getElementById('addonToggle')?.classList.toggle('active', addonActive);
    document.getElementById('addonPickup')?.classList.toggle('show', addonActive);
    updateTotal();
    updateSubmitState();
  }
  function updateSubmitState() {
    const name = document.getElementById('name')?.value.trim() || '';
    const phone = document.getElementById('phone')?.value.trim() || '';
    const pickupOk = !addonActive || !!document.getElementById('pickup')?.value;
    const btn = document.getElementById('submitBtn');
    if (btn) btn.disabled = submitting || !(agreed && name && phone && pickupOk);
  }

  async function handleSubmit() {
    const btn = document.getElementById('submitBtn');
    if (!btn || btn.disabled) return;

    submitting = true;
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = '送出中...';

    const phone = document.getElementById('phone').value.trim();
    const lineIdRaw = document.getElementById('lineId')?.value.trim() || '';

    const payload = {
      event_id: EVENT_ID,
      name: document.getElementById('name').value.trim(),
      phone,
      line_id: lineIdRaw || null,
      plan: addonActive ? 'roundtrip' : 'return',
      pickup: addonActive ? document.getElementById('pickup').value || null : null,
      amount: totalAmount(),
      status: 'pending'
    };

    try {
      await sbInsert('signups', payload);
      setSigned(EVENT_ID, { phone });
      document.getElementById('formArea').style.display = 'none';
      document.getElementById('formSuccess').classList.add('show');
    } catch (e) {
      console.error('[FindBus] 報名失敗：', e);
      submitting = false;

      if (isDuplicateError(e)) {
        // 伺服器說這支電話已報過 → 寫進本機 + 切到 signed 畫面
        setSigned(EVENT_ID, { phone, dupe: true });
        document.getElementById('formArea').style.display = 'none';
        showSignedState('dupe');
        return;
      }

      btn.textContent = '送出失敗，請再試一次';
      setTimeout(() => {
        btn.textContent = originalLabel;
        updateSubmitState();
      }, 2500);
    }
  }

  // ─── 已報名畫面 ───────────────────────────────────────────────────
  function injectSignedStyle() {
    if (document.getElementById('findbus-signed-style')) return;
    const style = document.createElement('style');
    style.id = 'findbus-signed-style';
    style.textContent = `
      .fb-signed {
        margin: 16px 24px 24px;
        padding: 16px 18px;
        background: rgba(111,207,124,.08);
        border: 1px solid rgba(111,207,124,.22);
        border-radius: 12px;
        display: flex; align-items: center; gap: 12px;
      }
      .fb-signed-icon {
        width: 32px; height: 32px; border-radius: 50%;
        background: #6fcf7c; color: #1a1518;
        display: flex; align-items: center; justify-content: center;
        font-weight: 900; font-size: 16px; flex-shrink: 0;
      }
      .fb-signed-text { flex: 1; font-size: 13.5px; color: var(--cream, #f0e6d6); line-height: 1.5; }
      .fb-signed-text small { display: block; font-size: 12px; color: var(--text-dim, #9a8e84); margin-top: 2px; }
      .fb-signed-retry {
        font-size: 12px; font-weight: 600;
        background: transparent; color: var(--gold-soft, #c9985a);
        border: 1px solid rgba(212,168,83,.3);
        padding: 7px 12px; border-radius: 100px;
        cursor: pointer; font-family: inherit; white-space: nowrap;
      }
      .fb-signed-retry:hover { background: rgba(212,168,83,.08); }
      .fb-list-signed-badge {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 11px; font-weight: 600;
        padding: 3px 10px; border-radius: 100px;
        color: #6fcf7c;
        background: rgba(111,207,124,.1);
        border: 1px solid rgba(111,207,124,.25);
      }
    `;
    document.head.appendChild(style);
  }

  function showSignedState(reason) {
    const mainCard = document.getElementById('mainCard');
    const cta = document.getElementById('ctaBtn');
    if (!mainCard || !cta) return;
    injectSignedStyle();

    // 若表單展開，先收回去
    mainCard.classList.remove('expanded');

    // 避免重複插
    if (document.querySelector('.fb-signed')) return;

    const msg = reason === 'dupe'
      ? '這支電話已經報過這一場'
      : '你已在這支手機報名過';
    const sub = reason === 'dupe'
      ? '我們會用剛才的電話比對，有問題直接 LINE 聯繫'
      : '我們會透過電話或 LINE 聯繫你';

    const el = document.createElement('div');
    el.className = 'fb-signed';
    el.innerHTML =
      '<div class="fb-signed-icon">✓</div>' +
      '<div class="fb-signed-text">' + msg + '<small>' + sub + '</small></div>' +
      '<button class="fb-signed-retry" type="button">再報一人</button>';
    cta.style.display = 'none';
    cta.parentNode.insertBefore(el, cta);

    el.querySelector('.fb-signed-retry').addEventListener('click', () => {
      el.remove();
      cta.style.display = '';
      // 讓 formArea 重新出現（若曾被隱藏）
      const fa = document.getElementById('formArea');
      if (fa) fa.style.display = '';
      // 清空表單輸入
      ['name', 'phone', 'lineId'].forEach((id) => {
        const i = document.getElementById(id);
        if (i) i.value = '';
      });
      agreed = false;
      addonActive = false;
      document.getElementById('agreeRow')?.classList.remove('checked');
      document.getElementById('addonToggle')?.classList.remove('active');
      document.getElementById('addonPickup')?.classList.remove('show');
      submitting = false;
      updateTotal();
      updateSubmitState();
    });
  }

  // ─── 列表頁 ───────────────────────────────────────────────────────
  function addListBadge(card) {
    const meta = card.querySelector('.event-meta');
    if (!meta || meta.querySelector('.fb-list-signed-badge')) return;
    injectSignedStyle();
    const badge = document.createElement('span');
    badge.className = 'fb-list-signed-badge';
    badge.textContent = '✓ 已報名';
    meta.appendChild(badge);
  }

  async function loadEventList() {
    const cards = document.querySelectorAll('.event-card[data-event-id]');
    if (!cards.length) return;

    // 先掛 badge（localStorage 不需等網路）
    cards.forEach((card) => {
      if (getSigned(card.dataset.eventId)) addListBadge(card);
    });

    // 再抓即時人數
    const ids = [...cards].map((c) => c.dataset.eventId);
    try {
      const data = await sbSelect(
        '/event_counts?id=in.(' +
          ids.map((id) => encodeURIComponent(id)).join(',') +
          ')&select=id,capacity,min_to_run,display_count'
      );
      const byId = Object.fromEntries(data.map((e) => [e.id, e]));
      cards.forEach((card) => {
        const e = byId[card.dataset.eventId];
        if (!e) return;
        const pct = Math.min(100, Math.round((e.display_count / e.capacity) * 100));
        const fill = card.querySelector('.progress-fill');
        const text = card.querySelector('.event-progress span');
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = `${e.display_count}/${e.capacity} 人・${e.min_to_run} 人成團`;
      });
    } catch (e) {
      console.warn('[FindBus] 列表載入錯誤：', e);
    }
  }

  // ─── 初始化 ───────────────────────────────────────────────────────
  function bindInputs() {
    ['name', 'phone', 'lineId', 'pickup'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', updateSubmitState);
      el.addEventListener('change', updateSubmitState);
    });
  }

  async function initDetail() {
    bindInputs();
    updateTotal();
    updateSubmitState();

    const data = await eventPromise;
    applyEventData(data);

    if (getSigned(EVENT_ID)) showSignedState();
  }

  function init() {
    if (EVENT_ID) {
      initDetail();
    } else if (document.querySelector('.event-card[data-event-id]')) {
      loadEventList();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.expandPanel = expandPanel;
  window.toggleAgree = toggleAgree;
  window.toggleAddon = toggleAddon;
  window.handleSubmit = handleSubmit;

  // debug
  window.FindBus = {
    reload: () => eventPromise && eventPromise.then(applyEventData),
    clearSigned: (id) => { try { localStorage.removeItem(sigKey(id || EVENT_ID)); } catch (_) {} },
    listSigned: () => {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(LS_PREFIX)) out.push(k.slice(LS_PREFIX.length));
        }
      } catch (_) {}
      return out;
    }
  };
})();
