'use strict';

(async () => {
  const heading = document.getElementById('verify-heading');
  const message = document.getElementById('verify-message');
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) {
    heading.textContent = 'Missing token';
    message.textContent = 'This link is missing its verification token.';
    return;
  }
  try {
    const res = await fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Verification failed.');
    heading.textContent = "You're verified! ✅";
    message.textContent = `${body.user.email} is confirmed. You can post listings and leave reviews now.`;
  } catch (err) {
    heading.textContent = 'Verification failed';
    message.textContent = err.message;
  }
})();
