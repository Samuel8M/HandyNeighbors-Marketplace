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
// (https://resend.com/docs/api-reference/emails/send-email), but it has
// not been exercised against a real Resend account in this environment —
// no API key was available to test with. Verify it with a real key
// before relying on it, and check Resend's current docs if it doesn't
// behave as expected; API contracts can change after this was written.
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

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: toEmail, subject, text, html }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[email:resend] send failed (HTTP ${res.status}): ${body}`);
        return { sent: false, mode: 'resend-error', verifyUrl };
      }
      return { sent: true, mode: 'resend' };
    } catch (err) {
      console.error('[email:resend] send threw:', err.message);
      return { sent: false, mode: 'resend-error', verifyUrl };
    }
  };
}

module.exports = { createEmailSender };
