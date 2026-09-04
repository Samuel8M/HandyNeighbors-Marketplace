'use strict';

// Static build for GitHub Pages: no server, no shared database. All data
// lives in this browser's localStorage — the UI and validation rules
// mirror src/workerService.js in the Express version, but every "request"
// below is a synchronous read/write against localStorage instead of a
// fetch() to an API.
(() => {
  const STORAGE_KEY = 'handyneighbors:data:v1';

  const SKILLS = [
    'Drywall Repair', 'Painting', 'Faucet Replacement', 'Toilet Repair',
    'Garbage Disposal Repair', 'Outlet & Switch Replacement', 'Door Repair',
    'Window Repair', 'Furniture Assembly', 'Shelving & Mounting',
    'Caulking & Sealing', 'Tile Repair', 'Deck & Fence Repair',
    'Gutter Cleaning', 'Pressure Washing', 'Appliance Installation',
    'Flooring Repair', 'Weatherstripping', 'Minor Carpentry',
    'Lock & Deadbolt Installation',
  ].map((name) => ({ slug: slugify(name), name }));

  const EQUIPMENT = [
    { name: 'Ladder', category: 'Access & Transport' },
    { name: 'Truck/Van', category: 'Access & Transport' },
    { name: 'Drill/Driver Set', category: 'Power Tools' },
    { name: 'Circular Saw', category: 'Power Tools' },
    { name: 'Miter Saw', category: 'Power Tools' },
    { name: 'Tile Saw', category: 'Power Tools' },
    { name: 'Nail Gun', category: 'Power Tools' },
    { name: 'Sander', category: 'Power Tools' },
    { name: 'Drain Snake', category: 'Diagnostic & Specialty' },
    { name: 'Multimeter', category: 'Diagnostic & Specialty' },
    { name: 'Stud Finder', category: 'Diagnostic & Specialty' },
    { name: 'Pipe Wrench Set', category: 'Diagnostic & Specialty' },
    { name: 'Pressure Washer', category: 'General & Finishing' },
    { name: 'Wet/Dry Vacuum', category: 'General & Finishing' },
    { name: 'Caulk Gun', category: 'General & Finishing' },
    { name: 'Level Set', category: 'General & Finishing' },
  ].map((e) => ({ ...e, slug: slugify(e.name) }));

  function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }
  function skillName(slug) { const s = SKILLS.find((x) => x.slug === slug); return s ? s.name : slug; }
  function equipmentItem(slug) { return EQUIPMENT.find((x) => x.slug === slug); }
  function genId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

  // ---------- localStorage data layer ----------

  function exampleWorkers() {
    return [
      { id: 'w1', name: 'Jordan Reyes', bio: 'Ten years doing drywall patching, painting, and general trim work around the East End. I bring my own materials for small jobs.', hourlyRate: 45, city: 'Pittsburgh', state: 'PA', serviceRadiusMiles: 15, contactEmail: 'jordan.reyes@example.com', contactPhone: null, skills: ['drywall-repair', 'painting', 'caulking-sealing'], equipment: ['ladder', 'drill-driver-set', 'caulk-gun'], createdAt: '2026-08-29T14:12:00.000Z', reviews: [
        { id: 'r1', authorName: 'Sam T.', rating: 5, comment: 'Fixed our hallway drywall and repainted in an afternoon — spotless.', createdAt: '2026-08-31T10:00:00.000Z' },
        { id: 'r2', authorName: 'Alex P.', rating: 4, comment: 'Great communication, showed up on time.', createdAt: '2026-09-01T09:00:00.000Z' },
      ] },
      { id: 'w2', name: 'Alicia Moreno', bio: 'Fast, tidy fixture and drain work. Same-day service most weeks.', hourlyRate: 60, city: 'Pittsburgh', state: 'PA', serviceRadiusMiles: 12, contactEmail: 'alicia.moreno@example.com', contactPhone: '412-555-0148', skills: ['faucet-replacement', 'toilet-repair', 'garbage-disposal-repair'], equipment: ['drain-snake', 'pipe-wrench-set', 'wet-dry-vacuum'], createdAt: '2026-08-30T09:40:00.000Z', reviews: [
        { id: 'r1', authorName: 'Morgan L.', rating: 5, comment: 'Cleared a nasty disposal jam in ten minutes.', createdAt: '2026-08-31T15:00:00.000Z' },
      ] },
      { id: 'w3', name: 'Marcus Webb', bio: 'Exterior specialist — gutters, decks, and pressure washing. I have a truck for hauling debris.', hourlyRate: 38, city: 'Cleveland', state: 'OH', serviceRadiusMiles: 20, contactEmail: 'marcus.webb@example.com', contactPhone: null, skills: ['gutter-cleaning', 'pressure-washing', 'deck-fence-repair', 'painting'], equipment: ['pressure-washer', 'ladder', 'truck-van'], createdAt: '2026-09-01T11:05:00.000Z', reviews: [] },
      { id: 'w4', name: 'Priya Shah', bio: 'Outlets, shelving, appliance hookups. I test everything with a multimeter before I leave.', hourlyRate: 52, city: 'Cleveland', state: 'OH', serviceRadiusMiles: 18, contactEmail: 'priya.shah@example.com', contactPhone: '216-555-0121', skills: ['outlet-switch-replacement', 'appliance-installation', 'shelving-mounting', 'drywall-repair'], equipment: ['multimeter', 'drill-driver-set', 'stud-finder'], createdAt: '2026-09-02T16:20:00.000Z', reviews: [
        { id: 'r1', authorName: 'Chris B.', rating: 4, comment: 'Mounted shelves perfectly level.', createdAt: '2026-09-03T09:00:00.000Z' },
        { id: 'r2', authorName: 'Dana K.', rating: 4, comment: 'Installed our new outlets safely and fast.', createdAt: '2026-09-03T18:00:00.000Z' },
      ] },
      { id: 'w5', name: 'Devon Clarke', bio: 'Flooring and tile, mostly bathrooms and kitchens. Happy to do small carpentry on the side.', hourlyRate: 70, city: 'Columbus', state: 'OH', serviceRadiusMiles: 25, contactEmail: 'devon.clarke@example.com', contactPhone: null, skills: ['flooring-repair', 'tile-repair', 'minor-carpentry', 'painting'], equipment: ['tile-saw', 'miter-saw', 'level-set', 'truck-van'], createdAt: '2026-09-03T13:50:00.000Z', reviews: [
        { id: 'r1', authorName: 'Taylor R.', rating: 5, comment: 'Beautiful tile work in our bathroom.', createdAt: '2026-09-04T08:00:00.000Z' },
      ] },
    ];
  }

  let memoryFallback = null; // used only if localStorage itself throws (private-mode edge cases)

  function loadData() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* storage unavailable */ }
    if (raw === null && memoryFallback) return memoryFallback;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.workers)) return parsed;
      } catch { /* corrupt value — fall through to reseed */ }
    }
    const seeded = { workers: exampleWorkers() };
    saveData(seeded);
    return seeded;
  }

  function saveData(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
    catch { memoryFallback = data; /* private browsing or quota — keep it in-memory for this visit */ }
  }

  const state = { data: null };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function withTags(w) {
    const ratingCount = w.reviews.length;
    const ratingSum = w.reviews.reduce((sum, r) => sum + r.rating, 0);
    return {
      ...w,
      skills: w.skills.map((slug) => ({ slug, name: skillName(slug) })),
      equipment: w.equipment.map((slug) => equipmentItem(slug)).filter(Boolean),
      rating: ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
      reviewCount: ratingCount,
    };
  }

  // ---------- Tabs ----------
  function initTabs() {
    $$('.tab-btn').forEach((btn) => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
    const hash = window.location.hash.replace('#', '').split('?')[0];
    if (['find', 'price', 'post'].includes(hash)) activateTab(hash);
  }
  function activateTab(name) {
    $$('.tab-btn').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.tab === name));
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('is-active', panel.id === name));
  }

  // ---------- Lookup data ----------
  function fillSelect(select, items, placeholder, disabledPlaceholder) {
    const opts = [`<option value="" ${disabledPlaceholder ? 'disabled selected' : ''}>${escapeHtml(placeholder)}</option>`]
      .concat(items.map((i) => `<option value="${escapeHtml(i.slug)}">${escapeHtml(i.name)}</option>`));
    select.innerHTML = opts.join('');
  }
  function fillChecks(container, items, name) {
    container.innerHTML = items.map((i) => `
      <label><input type="checkbox" name="${name}" value="${escapeHtml(i.slug)}" /> ${escapeHtml(i.name)}</label>
    `).join('');
  }
  function fillEquipmentChecks(container, items) {
    const byCategory = new Map();
    for (const item of items) {
      if (!byCategory.has(item.category)) byCategory.set(item.category, []);
      byCategory.get(item.category).push(item);
    }
    container.innerHTML = Array.from(byCategory.entries()).map(([category, group]) => `
      <div class="tag-group">
        <span class="tag-group-label">${escapeHtml(category)}</span>
        <div class="tag-checks">${group.map((i) => `<label><input type="checkbox" name="equipment" value="${escapeHtml(i.slug)}" /> ${escapeHtml(i.name)}</label>`).join('')}</div>
      </div>
    `).join('');
  }
  function loadLookups() {
    fillSelect($('#search-skill'), SKILLS, 'Any skill');
    fillSelect($('#search-equipment'), EQUIPMENT, 'Any equipment');
    fillSelect($('#price-skill'), SKILLS, 'Choose a skill…', true);
    fillChecks($('#post-skills'), SKILLS, 'skills');
    fillEquipmentChecks($('#post-equipment'), EQUIPMENT);
  }

  // ---------- Browse by city ----------
  function computeCities() {
    const byCity = new Map();
    for (const w of state.data.workers) {
      const key = `${w.city.toLowerCase()}|${w.state.toLowerCase()}`;
      if (!byCity.has(key)) byCity.set(key, { city: w.city, state: w.state, rates: [] });
      byCity.get(key).rates.push(w.hourlyRate);
    }
    return Array.from(byCity.values())
      .map((c) => ({ city: c.city, state: c.state, workerCount: c.rates.length, averageRate: Math.round((c.rates.reduce((a, b) => a + b, 0) / c.rates.length) * 100) / 100 }))
      .sort((a, b) => b.workerCount - a.workerCount || a.city.localeCompare(b.city));
  }

  function renderCityChips() {
    const container = $('#city-chips');
    const cities = computeCities();
    if (cities.length === 0) {
      container.innerHTML = '<p class="empty-note-inline">No listings yet — post the first one and your city shows up here.</p>';
      return;
    }
    const activeCity = ($('#search-city').value || '').trim().toLowerCase();
    const activeState = ($('#search-state').value || '').trim().toLowerCase();
    container.innerHTML = cities.map((c) => {
      const isActive = c.city.toLowerCase() === activeCity && c.state.toLowerCase() === activeState;
      return `
        <button type="button" class="city-chip${isActive ? ' is-active' : ''}" data-city="${escapeHtml(c.city)}" data-state="${escapeHtml(c.state)}">
          ${escapeHtml(c.city)}, ${escapeHtml(c.state)}
          <span class="city-chip-count">${c.workerCount} · avg $${c.averageRate}/hr</span>
        </button>`;
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

  function workerCardHtml(w) {
    const skillPills = w.skills.slice(0, 4).map((s) => `<span class="pill">${escapeHtml(s.name)}</span>`).join('');
    const moreSkills = w.skills.length > 4 ? `<span class="pill pill-muted">+${w.skills.length - 4} more</span>` : '';
    const equipPills = w.equipment.slice(0, 3).map((e) => `<span class="pill pill-equipment">${escapeHtml(e.name)}</span>`).join('');
    const moreEquip = w.equipment.length > 3 ? `<span class="pill pill-muted">+${w.equipment.length - 3} more</span>` : '';
    const equipRow = w.equipment.length ? `<span class="card-section-label">Equipment</span><div class="pill-row">${equipPills}${moreEquip}</div>` : '';
    return `
      <button type="button" class="worker-card" data-id="${w.id}">
        <div class="worker-card-top">
          <span class="worker-name">${escapeHtml(w.name)}</span>
          <span class="worker-rate">$${w.hourlyRate}/hr</span>
        </div>
        <span class="worker-location">${escapeHtml(w.city)}, ${escapeHtml(w.state)} · ${w.serviceRadiusMiles} mi radius</span>
        <span class="rating-row">${renderStars(w.rating)}${w.reviewCount ? ` (${w.reviewCount})` : ''}</span>
        <p class="worker-bio">${escapeHtml(w.bio || 'No bio yet.')}</p>
        <span class="card-section-label">Skills</span>
        <div class="pill-row">${skillPills}${moreSkills}</div>
        ${equipRow}
      </button>`;
  }

  const SORTERS = {
    newest: null,
    rate_asc: (a, b) => a.hourlyRate - b.hourlyRate,
    rate_desc: (a, b) => b.hourlyRate - a.hourlyRate,
    rating_desc: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
  };

  function filterWorkers(params) {
    return state.data.workers.map(withTags).filter((w) => {
      if (params.get('skill') && !w.skills.some((s) => s.slug === params.get('skill'))) return false;
      if (params.get('equipment') && !w.equipment.some((e) => e.slug === params.get('equipment'))) return false;
      if (params.get('city') && w.city.toLowerCase() !== params.get('city').trim().toLowerCase()) return false;
      if (params.get('state') && w.state.toLowerCase() !== params.get('state').trim().toLowerCase()) return false;
      if (params.get('maxRate') && w.hourlyRate > Number(params.get('maxRate'))) return false;
      if (params.get('q')) {
        const q = params.get('q').trim().toLowerCase();
        if (!w.name.toLowerCase().includes(q) && !w.bio.toLowerCase().includes(q)) return false;
      }
      return true;
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function runSearch() {
    const form = $('#search-form');
    const params = new URLSearchParams();
    new FormData(form).forEach((value, key) => { if (value) params.set(key, value); });

    renderCityChips();

    const summary = $('#results-summary');
    const results = $('#results');
    let workers = filterWorkers(params);
    const sorter = SORTERS[params.get('sortBy')];
    if (sorter) workers = [...workers].sort(sorter);

    summary.textContent = workers.length === 0
      ? 'No one matches yet — try widening your filters, or be the first to post.'
      : `${workers.length} handyman${workers.length === 1 ? '' : 'men'} found`;
    results.innerHTML = workers.map(workerCardHtml).join('');
    $$('.worker-card', results).forEach((card) => card.addEventListener('click', () => openWorkerModal(card.dataset.id)));
  }

  function initFind() {
    $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
    $('#search-reset').addEventListener('click', () => { $('#search-form').reset(); runSearch(); });
    runSearch();
  }

  // ---------- Price check ----------
  function initPriceCheck() {
    $('#price-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target;
      const skillSlug = form.elements.namedItem('skill').value;
      const city = form.elements.namedItem('city').value.trim();
      const st = form.elements.namedItem('state').value.trim();

      const resultEl = $('#price-result');
      const emptyEl = $('#price-empty');

      const matches = state.data.workers.map(withTags).filter((w) => {
        if (!w.skills.some((s) => s.slug === skillSlug)) return false;
        if (city && w.city.toLowerCase() !== city.toLowerCase()) return false;
        if (st && w.state.toLowerCase() !== st.toLowerCase()) return false;
        return true;
      }).sort((a, b) => a.hourlyRate - b.hourlyRate);

      if (matches.length === 0) {
        resultEl.hidden = true;
        emptyEl.hidden = false;
        return;
      }
      emptyEl.hidden = true;
      resultEl.hidden = false;

      const rates = matches.map((w) => w.hourlyRate);
      const sum = rates.reduce((a, b) => a + b, 0);
      const low = rates[0], high = rates[rates.length - 1];
      const average = Math.round((sum / rates.length) * 100) / 100;
      const mid = Math.floor(rates.length / 2);
      const median = rates.length % 2 === 0 ? (rates[mid - 1] + rates[mid]) / 2 : rates[mid];

      $('#price-count').textContent = matches.length;
      $('#price-low').textContent = `$${low}`;
      $('#price-average').textContent = `$${average}`;
      $('#price-median').textContent = `$${median}`;
      $('#price-high').textContent = `$${high}`;

      const span = high - low || 1;
      const pct = Math.round(((average - low) / span) * 100);
      $('#price-bar').innerHTML = `<div class="price-bar-fill" style="width:${Math.max(4, pct)}%"></div>`;

      $('#price-workers').innerHTML = matches.map((w) => `
        <li><span>${escapeHtml(w.name)} — ${escapeHtml(w.city)}, ${escapeHtml(w.state)}</span><strong>$${w.hourlyRate}/hr</strong></li>
      `).join('');
    });
  }

  // ---------- Post a listing ----------
  function initPost() {
    $('#post-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form).entries());
      const skills = $$('input[name="skills"]:checked', form).map((el) => el.value);
      const equipment = $$('input[name="equipment"]:checked', form).map((el) => el.value);

      if (skills.length === 0) { alert('Pick at least one skill.'); return; }
      if (!data.contactEmail && !data.contactPhone) { alert('Provide at least one way to reach you: email or phone.'); return; }
      const hourlyRate = Number(data.hourlyRate);
      if (!Number.isFinite(hourlyRate) || hourlyRate < 1 || hourlyRate > 500) { alert('Hourly rate must be between 1 and 500.'); return; }

      const worker = {
        id: genId('w'),
        name: data.name.trim(),
        bio: (data.bio || '').trim(),
        hourlyRate,
        city: data.city.trim(),
        state: data.state.trim(),
        serviceRadiusMiles: Number(data.serviceRadiusMiles) || 10,
        contactEmail: (data.contactEmail || '').trim() || null,
        contactPhone: (data.contactPhone || '').trim() || null,
        skills, equipment,
        createdAt: new Date().toISOString(),
        reviews: [],
      };
      state.data.workers.push(worker);
      saveData(state.data);
      renderCityChips();

      form.hidden = true;
      $('#post-success').hidden = false;
      $('#view-listing-link').onclick = (ev) => { ev.preventDefault(); openWorkerModal(worker.id); };
    });
  }

  // ---------- Worker modal ----------
  function groupByCategory(items) {
    const map = new Map();
    for (const item of items) {
      if (!map.has(item.category)) map.set(item.category, []);
      map.get(item.category).push(item);
    }
    return map;
  }

  function openWorkerModal(id) {
    const backdrop = $('#worker-modal');
    const body = $('#modal-body');
    const raw = state.data.workers.find((w) => w.id === id);
    if (!raw) { body.innerHTML = '<p class="error-text">Listing not found.</p>'; backdrop.hidden = false; return; }
    const worker = withTags(raw);
    body.innerHTML = renderWorkerDetail(worker, raw.reviews);
    backdrop.hidden = false;

    $('#review-form', body).addEventListener('submit', (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      const rating = Number(data.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) { alert('Pick a rating.'); return; }
      raw.reviews.push({ id: genId('r'), authorName: data.authorName.trim(), rating, comment: (data.comment || '').trim(), createdAt: new Date().toISOString() });
      saveData(state.data);
      openWorkerModal(id);
    });
  }

  function renderWorkerDetail(w, reviews) {
    const skillPills = w.skills.map((s) => `<span class="pill">${escapeHtml(s.name)}</span>`).join('') || '<span class="pill pill-muted">None listed</span>';
    const equipByCategory = groupByCategory(w.equipment);
    const equipHtml = equipByCategory.size
      ? Array.from(equipByCategory.entries()).map(([category, items]) => `
          <div class="tag-group">
            <span class="tag-group-label">${escapeHtml(category)}</span>
            <div class="pill-row">${items.map((e) => `<span class="pill pill-equipment">${escapeHtml(e.name)}</span>`).join('')}</div>
          </div>`).join('')
      : '<span class="pill pill-muted">None listed</span>';
    const contact = [
      w.contactEmail ? `<div>✉️ ${escapeHtml(w.contactEmail)}</div>` : '',
      w.contactPhone ? `<div>📞 ${escapeHtml(w.contactPhone)}</div>` : '',
    ].join('');
    const reviewItems = [...reviews].reverse().map((r) => `
        <li><strong>${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</strong> — ${escapeHtml(r.authorName)}${r.comment ? `: ${escapeHtml(r.comment)}` : ''}</li>
      `).join('') || '<li>No reviews yet.</li>';

    return `
      <h2 id="modal-name">${escapeHtml(w.name)}</h2>
      <p class="worker-location">${escapeHtml(w.city)}, ${escapeHtml(w.state)} · ${w.serviceRadiusMiles} mi radius</p>
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
      <form id="review-form" class="review-form">
        <div class="field"><label for="review-author">Your name</label><input id="review-author" name="authorName" required maxlength="80" /></div>
        <div class="field"><label for="review-rating">Rating</label>
          <select id="review-rating" name="rating" required>
            <option value="5">★★★★★</option><option value="4">★★★★☆</option><option value="3">★★★☆☆</option>
            <option value="2">★★☆☆☆</option><option value="1">★☆☆☆☆</option>
          </select>
        </div>
        <div class="field"><label for="review-comment">Comment (optional)</label><textarea id="review-comment" name="comment" rows="2" maxlength="1000"></textarea></div>
        <button type="submit" class="btn btn-primary">Leave a review</button>
      </form>`;
  }

  function initModal() {
    $('#modal-close').addEventListener('click', () => { $('#worker-modal').hidden = true; });
    $('#worker-modal').addEventListener('click', (e) => { if (e.target.id === 'worker-modal') $('#worker-modal').hidden = true; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#worker-modal').hidden = true; });
  }

  // ---------- Init ----------
  function init() {
    state.data = loadData();
    initTabs();
    initModal();
    loadLookups();
    initPriceCheck();
    initPost();
    initFind();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
