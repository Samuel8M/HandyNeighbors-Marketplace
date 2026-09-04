'use strict';

(() => {
  const state = { skills: [], equipment: [], lastCreatedWorkerId: null };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Error((body && body.error) || `Request failed (${res.status})`);
    }
    return body;
  }

  // ---------- Tabs ----------

  function initTabs() {
    $$('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });
    const hash = window.location.hash.replace('#', '');
    if (['find', 'price', 'post'].includes(hash)) activateTab(hash);
  }

  function activateTab(name) {
    $$('.tab-btn').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.tab === name));
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('is-active', panel.id === name));
    history.replaceState(null, '', `#${name}`);
  }

  // ---------- Lookup data (skills / equipment) ----------

  async function loadLookups() {
    const [skills, equipment] = await Promise.all([api('/api/skills'), api('/api/equipment')]);
    state.skills = skills;
    state.equipment = equipment;

    fillSelect($('#search-skill'), skills, 'Any skill');
    fillSelect($('#search-equipment'), equipment, 'Any equipment');
    fillSelect($('#price-skill'), skills, 'Choose a skill…', true);
    fillChecks($('#post-skills'), skills, 'skills');
    fillChecks($('#post-equipment'), equipment, 'equipment');
  }

  function fillSelect(select, items, placeholder, disabledPlaceholder = false) {
    const opts = [`<option value="" ${disabledPlaceholder ? 'disabled selected' : ''}>${escapeHtml(placeholder)}</option>`]
      .concat(items.map((i) => `<option value="${escapeHtml(i.slug)}">${escapeHtml(i.name)}</option>`));
    select.innerHTML = opts.join('');
  }

  function fillChecks(container, items, name) {
    container.innerHTML = items.map((i) => `
      <label>
        <input type="checkbox" name="${name}" value="${escapeHtml(i.slug)}" />
        ${escapeHtml(i.name)}
      </label>
    `).join('');
  }

  // ---------- Find / search ----------

  function renderStars(rating) {
    if (rating === null || rating === undefined) return 'No reviews yet';
    return `★ ${rating.toFixed(1)}`;
  }

  function workerCardHtml(w) {
    const skillPills = w.skills.slice(0, 4).map((s) => `<span class="pill">${escapeHtml(s.name)}</span>`).join('');
    const more = w.skills.length > 4 ? `<span class="pill pill-muted">+${w.skills.length - 4} more</span>` : '';
    return `
      <button type="button" class="worker-card" data-id="${w.id}">
        <div class="worker-card-top">
          <span class="worker-name">${escapeHtml(w.name)}</span>
          <span class="worker-rate">$${w.hourlyRate}/hr</span>
        </div>
        <span class="worker-location">${escapeHtml(w.city)}, ${escapeHtml(w.state)} · ${w.serviceRadiusMiles} mi radius</span>
        <span class="rating-row">${renderStars(w.rating)}${w.reviewCount ? ` (${w.reviewCount})` : ''}</span>
        <p class="worker-bio">${escapeHtml(w.bio || 'No bio yet.')}</p>
        <div class="pill-row">${skillPills}${more}</div>
      </button>
    `;
  }

  async function runSearch() {
    const form = $('#search-form');
    const params = new URLSearchParams();
    new FormData(form).forEach((value, key) => { if (value) params.set(key, value); });

    const summary = $('#results-summary');
    const results = $('#results');
    summary.textContent = 'Searching…';
    try {
      const workers = await api(`/api/workers?${params.toString()}`);
      summary.textContent = workers.length === 0
        ? 'No one matches yet — try widening your filters, or be the first to post.'
        : `${workers.length} handyman${workers.length === 1 ? '' : 'men'} found`;
      results.innerHTML = workers.map(workerCardHtml).join('');
      $$('.worker-card', results).forEach((card) => {
        card.addEventListener('click', () => openWorkerModal(card.dataset.id));
      });
    } catch (err) {
      summary.textContent = '';
      results.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  }

  function initFind() {
    $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
    $('#search-reset').addEventListener('click', () => { $('#search-form').reset(); runSearch(); });
    runSearch();
  }

  // ---------- Price check ----------

  function initPriceCheck() {
    $('#price-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const params = new URLSearchParams();
      new FormData(form).forEach((value, key) => { if (value) params.set(key, value); });

      const resultEl = $('#price-result');
      const emptyEl = $('#price-empty');
      try {
        const result = await api(`/api/price-check?${params.toString()}`);
        if (result.count === 0) {
          resultEl.hidden = true;
          emptyEl.hidden = false;
          return;
        }
        emptyEl.hidden = true;
        resultEl.hidden = false;
        $('#price-count').textContent = result.count;
        $('#price-low').textContent = `$${result.low}`;
        $('#price-average').textContent = `$${result.average}`;
        $('#price-median').textContent = `$${result.median}`;
        $('#price-high').textContent = `$${result.high}`;

        const bar = $('#price-bar');
        const span = result.high - result.low || 1;
        const pct = Math.round(((result.average - result.low) / span) * 100);
        bar.innerHTML = `<div class="price-bar-fill" style="width:${Math.max(4, pct)}%"></div>`;

        $('#price-workers').innerHTML = result.workers.map((w) => `
          <li><span>${escapeHtml(w.name)} — ${escapeHtml(w.city)}, ${escapeHtml(w.state)}</span><strong>$${w.hourlyRate}/hr</strong></li>
        `).join('');
      } catch (err) {
        resultEl.hidden = true;
        emptyEl.hidden = false;
        emptyEl.textContent = err.message;
      }
    });
  }

  // ---------- Post a listing ----------

  function initPost() {
    $('#post-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form).entries());
      data.skills = $$('input[name="skills"]:checked', form).map((el) => el.value);
      data.equipment = $$('input[name="equipment"]:checked', form).map((el) => el.value);

      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const { worker, editToken } = await api('/api/workers', { method: 'POST', body: JSON.stringify(data) });
        state.lastCreatedWorkerId = worker.id;
        form.hidden = true;
        $('#post-success').hidden = false;
        $('#post-token').textContent = editToken;
        $('#view-listing-link').onclick = (ev) => { ev.preventDefault(); openWorkerModal(worker.id); };
      } catch (err) {
        alert(err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });

    $('#copy-token').addEventListener('click', async () => {
      const text = $('#post-token').textContent;
      try {
        await navigator.clipboard.writeText(text);
        $('#copy-token').textContent = 'Copied!';
        setTimeout(() => { $('#copy-token').textContent = 'Copy edit key'; }, 1500);
      } catch {
        /* clipboard API unavailable — the text is already selectable on screen */
      }
    });
  }

  // ---------- Worker modal ----------

  async function openWorkerModal(id) {
    const backdrop = $('#worker-modal');
    const body = $('#modal-body');
    body.innerHTML = '<p>Loading…</p>';
    backdrop.hidden = false;

    try {
      const [worker, reviews] = await Promise.all([
        api(`/api/workers/${id}`),
        api(`/api/workers/${id}/reviews`),
      ]);
      body.innerHTML = renderWorkerDetail(worker, reviews);
      $('#review-form', body).addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target).entries());
        data.rating = Number(data.rating);
        try {
          await api(`/api/workers/${id}/reviews`, { method: 'POST', body: JSON.stringify(data) });
          openWorkerModal(id);
        } catch (err) {
          alert(err.message);
        }
      });
    } catch (err) {
      body.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderWorkerDetail(w, reviews) {
    const skillPills = w.skills.map((s) => `<span class="pill">${escapeHtml(s.name)}</span>`).join('') || '<span class="pill pill-muted">None listed</span>';
    const equipPills = w.equipment.map((e) => `<span class="pill pill-muted">${escapeHtml(e.name)}</span>`).join('') || '<span class="pill pill-muted">None listed</span>';
    const contact = [
      w.contactEmail ? `<div>✉️ ${escapeHtml(w.contactEmail)}</div>` : '',
      w.contactPhone ? `<div>📞 ${escapeHtml(w.contactPhone)}</div>` : '',
    ].join('');
    const reviewItems = reviews.length
      ? reviews.map((r) => `
          <li>
            <strong>${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</strong>
            — ${escapeHtml(r.authorName)}${r.comment ? `: ${escapeHtml(r.comment)}` : ''}
          </li>
        `).join('')
      : '<li>No reviews yet.</li>';

    return `
      <h2 id="modal-name">${escapeHtml(w.name)}</h2>
      <p class="worker-location">${escapeHtml(w.city)}, ${escapeHtml(w.state)} · ${w.serviceRadiusMiles} mi radius</p>
      <p class="rating-row">${renderStars(w.rating)}${w.reviewCount ? ` (${w.reviewCount} review${w.reviewCount === 1 ? '' : 's'})` : ''}</p>
      <p class="worker-rate" style="font-size:1.4rem">$${w.hourlyRate}/hr</p>
      <p>${escapeHtml(w.bio || 'No bio yet.')}</p>

      <h3>Skills</h3>
      <div class="pill-row">${skillPills}</div>

      <h3>Equipment</h3>
      <div class="pill-row">${equipPills}</div>

      <h3>Contact directly</h3>
      ${contact || '<p>No contact info listed.</p>'}
      <p class="field-hint">HandyNeighbors doesn't process payment or messages — reach out and arrange the job (and payment) directly.</p>

      <h3>Reviews</h3>
      <ul class="review-list">${reviewItems}</ul>

      <form id="review-form" class="review-form">
        <div class="field">
          <label for="review-author">Your name</label>
          <input id="review-author" name="authorName" required maxlength="80" />
        </div>
        <div class="field">
          <label for="review-rating">Rating</label>
          <select id="review-rating" name="rating" required>
            <option value="5">★★★★★</option>
            <option value="4">★★★★☆</option>
            <option value="3">★★★☆☆</option>
            <option value="2">★★☆☆☆</option>
            <option value="1">★☆☆☆☆</option>
          </select>
        </div>
        <div class="field">
          <label for="review-comment">Comment (optional)</label>
          <textarea id="review-comment" name="comment" rows="2" maxlength="1000"></textarea>
        </div>
        <button type="submit" class="btn btn-primary">Leave a review</button>
      </form>
    `;
  }

  function initModal() {
    $('#modal-close').addEventListener('click', () => { $('#worker-modal').hidden = true; });
    $('#worker-modal').addEventListener('click', (e) => {
      if (e.target.id === 'worker-modal') $('#worker-modal').hidden = true;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') $('#worker-modal').hidden = true;
    });
  }

  // ---------- Init ----------

  async function init() {
    initTabs();
    initModal();
    initPriceCheck();
    initPost();
    try {
      await loadLookups();
    } catch (err) {
      $('#results-summary').textContent = `Couldn't load skills/equipment: ${err.message}`;
    }
    initFind();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
