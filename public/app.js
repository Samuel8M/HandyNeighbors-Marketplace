'use strict';

(() => {
  const state = { skills: [], equipment: [], cities: [], currentUser: null, lastCreatedWorkerId: null };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Shows a validation/API error inline, right inside the form that
  // triggered it — instead of a blocking alert() the user has to
  // dismiss before they can even see which field to fix. Pass an empty
  // message to clear it (done at the start of every submit, so a stale
  // error doesn't linger past a fixed retry).
  function setFormError(form, message) {
    let el = form.querySelector('.error-text');
    if (!el) {
      el = document.createElement('p');
      el.className = 'error-text';
      form.insertBefore(el, form.firstChild);
    }
    el.textContent = message || '';
    el.hidden = !message;
  }

  // Wraps a form's submit handler so the button visibly reflects what's
  // happening (label swaps to `busyLabel`, disabled) instead of just
  // going quiet for however long the request takes — the difference
  // between "is this working?" and a clear "yes, hang on."
  async function withLoadingButton(form, busyLabel, fn) {
    const btn = form.querySelector('button[type="submit"]');
    const originalLabel = btn.textContent;
    setFormError(form, '');
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
      await fn();
    } catch (err) {
      setFormError(form, err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
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
    const [skills, equipment, cities] = await Promise.all([
      api('/api/skills'), api('/api/equipment'), api('/api/cities'),
    ]);
    state.skills = skills;
    state.equipment = equipment;
    state.cities = cities;

    fillSelect($('#search-skill'), skills, 'Any skill');
    fillSelect($('#search-equipment'), equipment, 'Any equipment');
    fillSelect($('#price-skill'), skills, 'Choose a skill…', true);
    fillChecks($('#post-skills'), skills, 'skills');
    fillEquipmentChecks($('#post-equipment'), equipment);
    renderCityChips();
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

  // Equipment carries a `category` (Power Tools, Access & Transport, …) so
  // the post form groups checkboxes by type instead of one flat list.
  function fillEquipmentChecks(container, items) {
    const byCategory = new Map();
    for (const item of items) {
      if (!byCategory.has(item.category)) byCategory.set(item.category, []);
      byCategory.get(item.category).push(item);
    }
    container.innerHTML = Array.from(byCategory.entries()).map(([category, group]) => `
      <div class="tag-group">
        <span class="tag-group-label">${escapeHtml(category)}</span>
        <div class="tag-checks">
          ${group.map((i) => `
            <label>
              <input type="checkbox" name="equipment" value="${escapeHtml(i.slug)}" />
              ${escapeHtml(i.name)}
            </label>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  // ---------- Browse by city ----------

  function renderCityChips() {
    const container = $('#city-chips');
    if (state.cities.length === 0) {
      container.innerHTML = '<p class="empty-note-inline">No listings yet — post the first one and your city shows up here.</p>';
      return;
    }
    const activeCity = ($('#search-city').value || '').trim().toLowerCase();
    const activeState = ($('#search-state').value || '').trim().toLowerCase();

    container.innerHTML = state.cities.map((c) => {
      const isActive = c.city.toLowerCase() === activeCity && c.state.toLowerCase() === activeState;
      return `
        <button type="button" class="city-chip${isActive ? ' is-active' : ''}" data-city="${escapeHtml(c.city)}" data-state="${escapeHtml(c.state)}">
          ${escapeHtml(c.city)}, ${escapeHtml(c.state)}
          <span class="city-chip-count">${c.workerCount} · avg $${c.averageRate}/hr</span>
        </button>
      `;
    }).join('');

    $$('.city-chip', container).forEach((chip) => {
      chip.addEventListener('click', () => {
        const isActive = chip.classList.contains('is-active');
        $('#search-city').value = isActive ? '' : chip.dataset.city;
        $('#search-state').value = isActive ? '' : chip.dataset.state;
        runSearch();
      });
    });
  }

  // ---------- Find / search ----------

  function renderStars(rating) {
    if (rating === null || rating === undefined) return 'No reviews yet';
    return `★ ${rating.toFixed(1)}`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
  }

  function verifiedBadgeHtml(w) {
    return w.verified ? '<span class="verified-badge" title="This account\'s email address is confirmed">Verified</span>' : '';
  }

  function workerCardHtml(w) {
    const skillPills = w.skills.slice(0, 4).map((s) => `<span class="pill">${escapeHtml(s.name)}</span>`).join('');
    const moreSkills = w.skills.length > 4 ? `<span class="pill pill-muted">+${w.skills.length - 4} more</span>` : '';
    const equipPills = w.equipment.slice(0, 3).map((e) => `<span class="pill pill-equipment">${escapeHtml(e.name)}</span>`).join('');
    const moreEquip = w.equipment.length > 3 ? `<span class="pill pill-muted">+${w.equipment.length - 3} more</span>` : '';
    const equipRow = w.equipment.length
      ? `<span class="card-section-label">Equipment</span><div class="pill-row">${equipPills}${moreEquip}</div>`
      : '';
    return `
      <button type="button" class="worker-card" data-id="${w.id}">
        <div class="worker-card-top">
          <span class="worker-name">${escapeHtml(w.name)} ${verifiedBadgeHtml(w)}</span>
          <span class="worker-rate">$${w.hourlyRate}/hr</span>
        </div>
        <span class="worker-location">${escapeHtml(w.city)}, ${escapeHtml(w.state)} · ${w.serviceRadiusMiles} mi radius</span>
        <span class="rating-row">${renderStars(w.rating)}${w.reviewCount ? ` (${w.reviewCount})` : ''}</span>
        <p class="worker-bio">${escapeHtml(w.bio || 'No bio yet.')}</p>
        <span class="card-section-label">Skills</span>
        <div class="pill-row">${skillPills}${moreSkills}</div>
        ${equipRow}
      </button>
    `;
  }

  async function runSearch() {
    const form = $('#search-form');
    const params = new URLSearchParams();
    new FormData(form).forEach((value, key) => { if (value) params.set(key, value); });

    // Keep the search shareable/bookmarkable: a link to a filtered city view
    // (e.g. from a "Browse by City" chip) can be sent to someone else. Only
    // touch the query string — runSearch() also runs on initial page load
    // regardless of which tab the URL hash points to, so the hash itself
    // must be left alone rather than forced to #find.
    const currentHash = window.location.hash || '#find';
    history.replaceState(null, '', `?${params.toString()}${currentHash}`);
    renderCityChips();

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

  function prefillSearchFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const form = $('#search-form');
    for (const [key, value] of params.entries()) {
      const field = form.elements.namedItem(key);
      if (field) field.value = value;
    }
  }

  function initFind() {
    $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
    $('#search-reset').addEventListener('click', () => { $('#search-form').reset(); runSearch(); });
    prefillSearchFromUrl();
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
  // Posting requires a signed-in, verified account — renderPostGate() (in
  // the auth section below) shows this form only in that state; otherwise
  // it shows a sign-in/verify prompt in its place.

  function initPost() {
    $('#post-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      await withLoadingButton(form, 'Posting…', async () => {
        const data = Object.fromEntries(new FormData(form).entries());
        data.skills = $$('input[name="skills"]:checked', form).map((el) => el.value);
        data.equipment = $$('input[name="equipment"]:checked', form).map((el) => el.value);

        const { worker } = await api('/api/workers', { method: 'POST', body: JSON.stringify(data) });
        state.lastCreatedWorkerId = worker.id;
        form.hidden = true;
        $('#post-success').hidden = false;
        $('#view-listing-link').onclick = (ev) => { ev.preventDefault(); openWorkerModal(worker.id); };
        state.cities = await api('/api/cities'); // so the new city shows up next time Find is visited
      });
    });
  }

  // ---------- Worker modal ----------

  async function openWorkerModal(id) {
    const backdrop = $('#worker-modal');
    const body = $('#modal-body');
    backdrop._opener = document.activeElement;
    body.innerHTML = '<p>Loading…</p>';
    backdrop.hidden = false;
    document.body.style.overflow = 'hidden';
    $('#modal-close').focus();

    try {
      const [worker, reviews] = await Promise.all([
        api(`/api/workers/${id}`),
        api(`/api/workers/${id}/reviews`),
      ]);
      body.innerHTML = renderWorkerDetail(worker, reviews);

      const reviewForm = $('#review-form', body);
      if (reviewForm) {
        reviewForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const form = e.target;
          await withLoadingButton(form, 'Submitting…', async () => {
            const data = Object.fromEntries(new FormData(form).entries());
            data.rating = Number(data.rating);
            await api(`/api/workers/${id}/reviews`, { method: 'POST', body: JSON.stringify(data) });
            openWorkerModal(id);
          });
        });
      }

      const signInLink = $('#sign-in-to-review', body);
      if (signInLink) {
        signInLink.addEventListener('click', (e) => { e.preventDefault(); openAuthModal('login'); });
      }

      const deleteBtn = $('#delete-listing', body);
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          if (!confirm('Remove this listing? This can\'t be undone.')) return;
          try {
            await api(`/api/workers/${id}`, { method: 'DELETE' });
            $('#worker-modal').hidden = true;
            state.cities = await api('/api/cities');
            runSearch();
          } catch (err) {
            alert(err.message);
          }
        });
      }
    } catch (err) {
      body.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  }

  function groupByCategory(items) {
    const map = new Map();
    for (const item of items) {
      if (!map.has(item.category)) map.set(item.category, []);
      map.get(item.category).push(item);
    }
    return map;
  }

  function renderWorkerDetail(w, reviews) {
    const skillPills = w.skills.map((s) => `<span class="pill">${escapeHtml(s.name)}</span>`).join('') || '<span class="pill pill-muted">None listed</span>';
    const equipByCategory = groupByCategory(w.equipment);
    const equipHtml = equipByCategory.size
      ? Array.from(equipByCategory.entries()).map(([category, items]) => `
          <div class="tag-group">
            <span class="tag-group-label">${escapeHtml(category)}</span>
            <div class="pill-row">${items.map((e) => `<span class="pill pill-equipment">${escapeHtml(e.name)}</span>`).join('')}</div>
          </div>
        `).join('')
      : '<span class="pill pill-muted">None listed</span>';
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

    const isOwner = state.currentUser && state.currentUser.id === w.ownerId;
    const reviewSection = isOwner
      ? '<p class="field-hint">This is your listing — you can\'t review your own work.</p>'
      : !state.currentUser
        ? '<p class="field-hint"><a href="#" id="sign-in-to-review">Sign in</a> to leave a review.</p>'
        : !state.currentUser.emailVerified
          ? '<p class="field-hint">Verify your email (see the banner above) to leave a review.</p>'
          : `
            <form id="review-form" class="review-form">
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
            </form>`;

    return `
      <h2 id="modal-name">${escapeHtml(w.name)} ${verifiedBadgeHtml(w)}</h2>
      <p class="worker-location">${escapeHtml(w.city)}, ${escapeHtml(w.state)} · ${w.serviceRadiusMiles} mi radius</p>
      ${w.memberSince ? `<p class="field-hint">Member since ${escapeHtml(formatDate(w.memberSince))}</p>` : ''}
      <p class="rating-row">${renderStars(w.rating)}${w.reviewCount ? ` (${w.reviewCount} review${w.reviewCount === 1 ? '' : 's'})` : ''}</p>
      <p class="worker-rate" style="font-size:1.4rem">$${w.hourlyRate}/hr</p>
      <p>${escapeHtml(w.bio || 'No bio yet.')}</p>

      <h3>Skills</h3>
      <div class="pill-row">${skillPills}</div>

      <h3>Equipment</h3>
      ${equipHtml}

      <h3>Contact directly</h3>
      ${contact || '<p>No contact info listed.</p>'}
      <p class="field-hint">HandyNeighbors doesn't process payment or messages — reach out and arrange the job (and payment) directly.</p>

      <h3>Reviews</h3>
      <ul class="review-list">${reviewItems}</ul>
      ${reviewSection}

      ${isOwner ? '<button type="button" id="delete-listing" class="btn btn-ghost" style="margin-top:1rem;color:var(--error);border-color:var(--error)">Remove my listing</button>' : ''}
    `;
  }

  // closeOnBackdropClick is off for the auth modal on purpose: a stray
  // click while reaching for a field (common on a form this size) used to
  // silently discard whatever you'd typed, with the same effect as
  // hitting Escape by accident. The close button and Escape are still
  // explicit, deliberate ways to back out — only the easy-to-trigger,
  // easy-to-not-notice one is disabled for the form modal. The
  // (read-only) worker-detail modal keeps click-outside-to-close, since
  // there's no half-finished input to lose there.
  function wireModalDismiss(backdropId, closeBtnId, { closeOnBackdropClick = true } = {}) {
    const backdrop = $(`#${backdropId}`);
    const close = () => {
      backdrop.hidden = true;
      document.body.style.overflow = ''; // re-allow background scroll
      // Sends focus back to whatever was focused right before the modal
      // opened (recorded as a live element reference, not an id — the
      // triggering button is often re-rendered by the time the modal
      // closes, e.g. a search result card after the list refreshes).
      if (backdrop._opener && document.contains(backdrop._opener)) backdrop._opener.focus();
    };
    $(`#${closeBtnId}`).addEventListener('click', close);
    if (closeOnBackdropClick) {
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !backdrop.hidden) close();
    });
  }

  function initModal() {
    wireModalDismiss('worker-modal', 'modal-close');
    wireModalDismiss('auth-modal', 'auth-modal-close', { closeOnBackdropClick: false });
  }

  // ---------- Auth ----------
  // Every piece of UI that depends on "am I signed in / verified" —
  // the header, the verify-your-email banner, and the List Your Services
  // gate — is redrawn together by refreshAuthUI() any time that changes.

  function renderAuthArea() {
    const area = $('#auth-area');
    if (!state.currentUser) {
      area.innerHTML = `
        <button type="button" class="btn btn-ghost btn-sm" id="nav-login">Log in</button>
        <button type="button" class="btn btn-primary btn-sm" id="nav-signup">Sign up</button>
      `;
      $('#nav-login').addEventListener('click', () => openAuthModal('login'));
      $('#nav-signup').addEventListener('click', () => openAuthModal('signup'));
      return;
    }
    area.innerHTML = `
      <span class="auth-user-chip">
        <span class="auth-user-name">${escapeHtml(state.currentUser.name)}</span>
        <button type="button" class="btn btn-ghost btn-sm" id="nav-logout">Log out</button>
        <button type="button" class="btn btn-ghost btn-sm" id="nav-delete-account" title="Permanently delete your account, listings, and reviews">Delete account</button>
      </span>
    `;
    $('#nav-logout').addEventListener('click', handleLogout);
    $('#nav-delete-account').addEventListener('click', handleDeleteAccount);
  }

  function renderVerifyBanner() {
    const banner = $('#verify-banner');
    if (!state.currentUser || state.currentUser.emailVerified) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    $('#verify-banner-text').textContent = `Verify your email (${state.currentUser.email}) to post listings and leave reviews.`;
    $('#verify-banner-resend').onclick = handleResendVerification;
  }

  function renderPostGate() {
    const gate = $('#post-gate');
    const form = $('#post-form');
    if (state.currentUser && state.currentUser.emailVerified) {
      gate.hidden = true;
      form.hidden = false;
      return;
    }
    form.hidden = true;
    gate.hidden = false;
    if (!state.currentUser) {
      gate.innerHTML = `
        <h2>Sign in to list your services</h2>
        <p>Free, always — we just need an account so listings and reviews belong to real people, not anonymous text fields.</p>
        <div class="btn-row">
          <button type="button" class="btn btn-primary" id="gate-signup">Create a free account</button>
          <button type="button" class="btn btn-ghost" id="gate-login">Log in</button>
        </div>
      `;
      $('#gate-signup').addEventListener('click', () => openAuthModal('signup'));
      $('#gate-login').addEventListener('click', () => openAuthModal('login'));
    } else {
      gate.innerHTML = `
        <h2>Verify your email to continue</h2>
        <p>We sent a link to ${escapeHtml(state.currentUser.email)}. Click it, then come back here.</p>
        <div class="btn-row"><button type="button" class="btn btn-primary" id="gate-resend">Resend link</button></div>
      `;
      $('#gate-resend').addEventListener('click', handleResendVerification);
    }
  }

  function refreshAuthUI() {
    renderAuthArea();
    renderVerifyBanner();
    renderPostGate();
  }

  function renderSignupFormHtml() {
    return `
      <h2 id="auth-modal-title">Create your account</h2>
      <form id="signup-form" class="auth-form">
        <div class="field"><label for="signup-name">Name</label><input id="signup-name" name="name" autocomplete="name" required maxlength="80" /></div>
        <div class="field"><label for="signup-email">Email</label><input id="signup-email" name="email" type="email" inputmode="email" autocomplete="email" required maxlength="200" /></div>
        <div class="field">
          <label for="signup-password">Password</label>
          <input id="signup-password" name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="200" aria-describedby="signup-password-hint" />
          <span id="signup-password-hint" class="field-hint" style="margin:0.25rem 0 0">At least 8 characters.</span>
        </div>
        <label class="auth-terms-check">
          <input type="checkbox" name="acceptedTerms" required />
          <span>I agree to the <a href="/terms.html" target="_blank" rel="noopener">Terms of Service</a> and <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span>
        </label>
        <button type="submit" class="btn btn-primary">Create account</button>
        <p class="auth-switch">Already have an account? <a href="#" id="switch-to-login">Log in</a></p>
      </form>
    `;
  }

  function renderLoginFormHtml() {
    return `
      <h2 id="auth-modal-title">Log in</h2>
      <form id="login-form" class="auth-form">
        <div class="field"><label for="login-email">Email</label><input id="login-email" name="email" type="email" inputmode="email" autocomplete="email" required maxlength="200" /></div>
        <div class="field"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required maxlength="200" /></div>
        <button type="submit" class="btn btn-primary">Log in</button>
        <p class="auth-switch">New here? <a href="#" id="switch-to-signup">Create an account</a></p>
      </form>
    `;
  }

  function openAuthModal(mode) {
    const backdrop = $('#auth-modal');
    backdrop._opener = document.activeElement;
    $('#auth-modal-body').innerHTML = mode === 'login' ? renderLoginFormHtml() : renderSignupFormHtml();
    backdrop.hidden = false;
    document.body.style.overflow = 'hidden';
    const firstField = $('#auth-modal-body input');
    if (firstField) firstField.focus();
    if (mode === 'login') {
      $('#login-form').addEventListener('submit', handleLoginSubmit);
      $('#switch-to-signup').addEventListener('click', (e) => { e.preventDefault(); openAuthModal('signup'); });
    } else {
      $('#signup-form').addEventListener('submit', handleSignupSubmit);
      $('#switch-to-login').addEventListener('click', (e) => { e.preventDefault(); openAuthModal('login'); });
    }
  }

  // Covers every case where no real email actually reached an inbox: no
  // provider configured (mode 'dev-log'), or the provider rejected the
  // send (mode 'resend-error' — e.g. an unverified Resend sender domain
  // can only deliver to the account's own address). Either way the API
  // still hands back the verification link, so this offers it directly
  // instead of leaving someone waiting on an email that will never come.
  async function offerDevModeVerification(verification) {
    if (!verification || verification.sent || !verification.verifyUrl) return;
    const explanation = verification.mode === 'resend-error'
      ? "The verification email couldn't actually be delivered (the connected email service rejected it)."
      : "No email service is connected in this environment, so there's no real inbox to check.";
    const proceed = confirm(`${explanation} Click OK to verify your account now using the link that would have been emailed to you.`);
    if (!proceed) return;
    const token = new URL(verification.verifyUrl, window.location.origin).searchParams.get('token');
    await api(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    const me = await api('/api/auth/me');
    state.currentUser = me.user;
    refreshAuthUI();
  }

  async function handleSignupSubmit(e) {
    e.preventDefault();
    const form = e.target;
    await withLoadingButton(form, 'Creating account…', async () => {
      const data = Object.fromEntries(new FormData(form).entries());
      data.acceptedTerms = form.elements.acceptedTerms.checked;
      const result = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify(data) });
      state.currentUser = result.user;
      $('#auth-modal').hidden = true;
      refreshAuthUI();
      await offerDevModeVerification(result.verification);
    });
  }

  async function handleLoginSubmit(e) {
    e.preventDefault();
    const form = e.target;
    await withLoadingButton(form, 'Logging in…', async () => {
      const data = Object.fromEntries(new FormData(form).entries());
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(data) });
      state.currentUser = result.user;
      $('#auth-modal').hidden = true;
      refreshAuthUI();
    });
  }

  async function handleLogout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* clear client-side state regardless */
    }
    state.currentUser = null;
    refreshAuthUI();
  }

  async function handleDeleteAccount() {
    if (!confirm("Permanently delete your account, along with every listing and review you've posted? This can't be undone.")) return;
    try {
      await api('/api/auth/me', { method: 'DELETE' });
    } catch (err) {
      alert(err.message);
      return;
    }
    state.currentUser = null;
    refreshAuthUI();
    runSearch();
  }

  async function handleResendVerification() {
    try {
      const result = await api('/api/auth/resend-verification', { method: 'POST' });
      if (result.verification && !result.verification.sent) {
        await offerDevModeVerification(result.verification);
      } else {
        alert('Verification email sent — check your inbox.');
      }
    } catch (err) {
      alert(err.message);
    }
  }

  async function initAuth() {
    try {
      const me = await api('/api/auth/me');
      state.currentUser = me.user;
    } catch {
      state.currentUser = null;
    }
    refreshAuthUI();
  }

  // ---------- Init ----------

  function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.error('Service worker registration failed:', err);
      });
    });
  }

  async function init() {
    initTabs();
    initModal();
    initPriceCheck();
    initPost();
    initServiceWorker();
    try {
      await loadLookups();
    } catch (err) {
      $('#results-summary').textContent = `Couldn't load skills/equipment: ${err.message}`;
    }
    await initAuth();
    initFind();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
