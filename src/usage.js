// Usage numbers from the claude.ai API.
//
// Uses Electron's net module rather than Node's https so requests go through
// Chromium's network stack and pick up the cookie jar the way a real browser
// tab would — Cloudflare blocks the Node path even with a valid session.
const { net } = require('electron');
const config = require('./config');
const auth = require('./auth');

const BASE = 'https://claude.ai';

async function getJson(path, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net.fetch(BASE + path, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': auth.UA },
    });
    if (res.status === 401 || res.status === 403) return { auth: false };
    const body = await res.text();
    // A Cloudflare challenge or the login page comes back as HTML.
    if (!body || body.startsWith('<')) return { auth: false };
    return { auth: true, data: JSON.parse(body) };
  } catch (_) {
    return { error: true };
  } finally {
    clearTimeout(timer);
  }
}

// The org id used to live hardcoded in the source, which meant every new
// machine (or account) needed a source edit. Look it up once and cache it.
async function resolveOrgId() {
  const cached = config.get('orgId');
  if (cached) return { orgId: cached, cached: true };

  const res = await getJson('/api/organizations');
  if (!res.data) return res;
  const orgs = Array.isArray(res.data) ? res.data : [];
  const pick = orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0];
  if (!pick || !pick.uuid) return { error: true };
  config.set({ orgId: pick.uuid });
  return { orgId: pick.uuid };
}

function parseLimits(data) {
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const scored = limits.filter((l) => l && l.percent != null);
  const pct = (l) => (l ? Math.round(l.percent) : null);

  let session = pct(scored.find((l) => l.group === 'session' || l.kind === 'session'));

  // The API returns more than one entry in the weekly group: `weekly_all` is
  // the account-wide number the web app shows, alongside a narrower
  // `weekly_scoped` that reads 0 with a null resets_at on this account.
  // Assigning every match in a loop meant last-wins, so weekly_scoped's 0
  // clobbered weekly_all's real figure and the bar showed 0% against 11% in
  // the app. Pick the account-wide one explicitly.
  const weeklies = scored.filter((l) => l.group === 'weekly' || (l.kind || '').includes('weekly'));
  let weekly = pct(weeklies.find((l) => l.kind === 'weekly_all') || weeklies[0]);

  if (session == null && typeof data.five_hour?.utilization === 'number')
    session = Math.round(data.five_hour.utilization);
  if (weekly == null && typeof data.seven_day?.utilization === 'number')
    weekly = Math.round(data.seven_day.utilization);
  return {
    session, weekly,
    resetsAt5: data.five_hour?.resets_at || null,
    resetsAt7: data.seven_day?.resets_at || null,
  };
}

// → { state: 'ok' | 'auth' | 'error', ...usage }
async function fetchUsage() {
  if (!(await auth.hasSession())) return { state: 'auth' };

  const org = await resolveOrgId();
  if (org.auth === false) return { state: 'auth' };
  if (!org.orgId) return { state: 'error' };

  const res = await getJson(`/api/organizations/${org.orgId}/usage`);
  if (res.auth === false) return { state: 'auth' };
  if (!res.data) {
    // A cached org id goes stale if the account is switched or the org is
    // removed. Drop it so the next poll rediscovers instead of failing forever.
    if (org.cached) config.set({ orgId: null });
    return { state: 'error' };
  }
  return Object.assign({ state: 'ok' }, parseLimits(res.data));
}

module.exports = { fetchUsage };
