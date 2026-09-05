'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

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
    if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
    return body;
  }

  const REASON_LABELS = {
    spam: 'Spam or advertising',
    scam_or_fraud: 'Scam or fraud',
    inappropriate_content: 'Inappropriate content',
    harassment: 'Harassment or abuse',
    fake_listing: 'Fake listing (not a real person/service)',
    other: 'Other',
  };

  function targetSummary(report) {
    if (!report.target) return '<em>This content was already removed.</em>';
    if (report.targetType === 'worker') {
      return `Listing: <strong>${escapeHtml(report.target.label)}</strong> (worker #${report.targetId})`;
    }
    return `Review by user #${report.target.user_id}: “${escapeHtml(report.target.label || '')}” (review #${report.targetId})`;
  }

  function reportCardHtml(report) {
    return `
      <div class="panel" data-report-card="${report.id}" style="margin-bottom:0.8rem">
        <p>${targetSummary(report)}</p>
        <p class="field-hint">
          Reason: <strong>${escapeHtml(REASON_LABELS[report.reason] || report.reason)}</strong>
          · Reported by ${escapeHtml(report.reporterEmail)}
          · ${new Date(report.createdAt).toLocaleString()}
        </p>
        ${report.details ? `<p>${escapeHtml(report.details)}</p>` : ''}
        <div class="btn-row">
          <button type="button" class="btn btn-ghost btn-sm" data-action="dismiss">Dismiss</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="delete_content" style="color:var(--error);border-color:var(--error)">Delete content</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="ban_user" style="color:var(--error);border-color:var(--error)">Ban user</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="delete_and_ban" style="color:var(--error);border-color:var(--error)">Delete &amp; ban</button>
        </div>
      </div>
    `;
  }

  function bannedRowHtml(user) {
    return `
      <div class="panel" data-banned-row="${user.id}" style="margin-bottom:0.6rem;display:flex;justify-content:space-between;align-items:center;gap:1rem">
        <span>${escapeHtml(user.name)} (${escapeHtml(user.email)}) — suspended ${new Date(user.bannedAt).toLocaleDateString()}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-unban="${user.id}">Unban</button>
      </div>
    `;
  }

  async function loadReports() {
    const list = $('#reports-list');
    const reports = await api('/api/admin/reports?status=open');
    list.innerHTML = reports.length
      ? reports.map(reportCardHtml).join('')
      : '<p class="field-hint">No open reports right now.</p>';

    list.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('[data-report-card]');
        const id = card.dataset.reportCard;
        const action = btn.dataset.action;
        if (action !== 'dismiss' && !confirm(`Really "${action.replace(/_/g, ' ')}" for this report?`)) return;
        btn.disabled = true;
        try {
          await api(`/api/admin/reports/${id}/action`, { method: 'POST', body: JSON.stringify({ action }) });
          await loadReports();
          if (action.includes('ban')) await loadBannedUsers();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
  }

  async function loadBannedUsers() {
    const list = $('#banned-list');
    const users = await api('/api/admin/banned-users');
    list.innerHTML = users.length
      ? users.map(bannedRowHtml).join('')
      : '<p class="field-hint">No suspended accounts.</p>';

    list.querySelectorAll('button[data-unban]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api(`/api/admin/banned-users/${btn.dataset.unban}/unban`, { method: 'POST' });
          await loadBannedUsers();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
  }

  async function init() {
    const me = await api('/api/auth/me');
    if (!me.user || !me.user.isAdmin) {
      $('#admin-denied').hidden = false;
      return;
    }
    $('#admin-content').hidden = false;
    await Promise.all([loadReports(), loadBannedUsers()]);
  }

  document.addEventListener('DOMContentLoaded', () => {
    init().catch((err) => {
      $('#admin-denied').hidden = false;
      $('#admin-denied').innerHTML = `<h2>Couldn't load admin page</h2><p>${escapeHtml(err.message)}</p>`;
    });
  });
})();
