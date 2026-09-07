'use strict';

// Inside the bundled Android app (Capacitor), this file is served locally
// from https://localhost, not from the real backend — every API call needs
// an absolute URL back to the deployed server. On the plain website, the
// page and the API share an origin, so an empty base (relative URLs) is
// correct there, same as before this file existed.
window.HN_API_BASE = window.Capacitor ? 'https://handyneighbors.onrender.com' : '';
