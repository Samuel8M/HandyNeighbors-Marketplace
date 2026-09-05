'use strict';

// Pluggable email delivery for account verification.
//
// Without a real provider configured, this logs the verification link to
// the server console and hands it back in the API response (clearly
// marked as dev-mode) so the whole verification FLOW — sign up, click the
// link, get verified — is still testable end to end without a connected
// email account. Wire up real delivery by setting RESEND_API_KEY (and
// optionally EMAIL_FROM) as environment variables.
//
// The Resend integration below follows Resend's documented API
// (https://resend.com/docs/api-reference/emails/send-email) and has been
// confirmed working end-to-end against a real Resend account: signup ->
// real email delivered -> click -> account verified. Two limits of an
// unverified sender domain (the default here, onboarding@resend.dev) are
// worth knowing: mail lands in spam more often than from a verified
// domain, and Resend's anti-spam rules only let it deliver to the email
// address the Resend account itself is registered with, not arbitrary
// signups. Verifying your own domain in Resend removes both.
// Shared by both senders below — everything provider-specific (the
// endpoint, the auth header, how a failure looks) lives here exactly
// once.
async function sendViaResend(apiKey, from, toEmail, { subject, text, html }) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: toEmail, subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[email:resend] send failed (HTTP ${res.status}): ${body}`);
      return { sent: false, mode: 'resend-error' };
    }
    return { sent: true, mode: 'resend' };
  } catch (err) {
    console.error('[email:resend] send threw:', err.message);
    return { sent: false, mode: 'resend-error' };
  }
}

function createEmailSender() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'HandyNeighbors <onboarding@resend.dev>';

  return async function sendVerificationEmail(toEmail, verifyUrl) {
    if (!apiKey) {
      console.log(`[email:dev-mode] No RESEND_API_KEY set — verification link for ${toEmail}: ${verifyUrl}`);
      return { sent: false, mode: 'dev-log', verifyUrl };
    }

    const subject = 'Verify your HandyNeighbors account';
    const text = `Welcome to HandyNeighbors! Verify your email to finish setting up your account:\n\n${verifyUrl}\n\nThis link expires in 24 hours.`;
    const html = `<p>Welcome to HandyNeighbors! Verify your email to finish setting up your account:</p>`
      + `<p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours.</p>`;

    const result = await sendViaResend(apiKey, from, toEmail, { subject, text, html });
    return result.sent ? result : { ...result, verifyUrl };
  };
}

// A generic (non-verification) notice sender — used by retentionService
// for the "you're about to be deleted for inactivity" warning and the
// "your account was deleted" follow-up. Same provider/dev-log fallback
// behavior as sendVerificationEmail, just without a verify link attached.
function createNoticeSender() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'HandyNeighbors <onboarding@resend.dev>';

  return async function sendNoticeEmail(toEmail, { subject, text, html }) {
    if (!apiKey) {
      console.log(`[email:dev-mode] No RESEND_API_KEY set — notice for ${toEmail}: ${subject}\n${text}`);
      return { sent: false, mode: 'dev-log' };
    }
    return sendViaResend(apiKey, from, toEmail, { subject, text, html: html || `<p>${text.replace(/\n/g, '<br>')}</p>` });
  };
}

module.exports = { createEmailSender, createNoticeSender };
