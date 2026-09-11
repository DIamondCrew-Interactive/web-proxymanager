import { existsSync } from 'node:fs';
import { readConfig, check, opaque, hash, validOpaque, verifyAssertion, consumeAssertion, linkedUser, npmSession, ISSUER, ORIGIN } from './core.mjs';
export function createRouter({ express, getUser, tokenModel, twoFactor, internalToken, configPath = '/run/secrets/dci-sso.json', linksPath = '/data/dci-sso/links.json', replayPath = '/data/dci-sso/replay', fetchImpl = fetch }) {
const pending = new Map();
const router = express.Router();
const cookieName = '__Host-dci-sso';
function cookie(req) {
  return (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
}
function prune() { for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k); }
function headers(res) { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); }
function endpoint(fn) {
  return async (req, res) => {
    headers(res);
    try {
      check(req.headers.origin === ORIGIN);
      const config = readConfig(configPath);
      prune();
      await fn(req, res, config);
    } catch { res.status(401).json({ error: { message: 'SSO sign-in failed. Use password sign-in or contact your administrator.' } }); }
  };
}
router.get('/status', (_, res) => { headers(res); let enabled = false; try { if (existsSync(configPath)) enabled = readConfig(configPath).enabled; } catch {} res.json({ enabled }); });
router.post('/start', endpoint(async (req, res) => {
  check(pending.size < 1024);
  const state = opaque(), verifier = opaque(), browser = opaque();
  pending.set(state, { verifier, browser: hash(browser), expires: Date.now() + 300000 });
  res.cookie(cookieName, browser, { secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 300000 });
  const url = new URL('/sso/proxymanager', ISSUER);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', hash(verifier));
  res.json({ url: url.href });
}));
router.post('/callback', endpoint(async (req, res, config) => {
  const { ticket, state } = req.body || {};
  check(validOpaque(ticket) && validOpaque(state));
  const entry = pending.get(state);
  check(entry && !entry.challenge && validOpaque(cookie(req)) && entry.browser === hash(cookie(req)));
  pending.delete(state); // Consume before network IO, including failed redemption.
  const response = await fetchImpl(ISSUER + '/sso/api/redeem', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.redeem_secret },
    body: JSON.stringify({ ticket, audience: 'proxymanager', state, code_verifier: entry.verifier }),
  });
  check(response.ok);
  const text = await response.text(); check(text.length <= 12288);
  const data = JSON.parse(text);
  check(data.token_type === 'DCI-SSO' && data.expires_in === 45);
  const claims = verifyAssertion(data.assertion, config, state);
  consumeAssertion(replayPath, claims.jti);
  const user = await linkedUser(claims.sub, linksPath, getUser);
  const result = await npmSession(user, { getUser, twoFactor, tokenModel, internalToken });
  if (result.requires_2fa) {
    const challenge = opaque();
    pending.set(challenge, { challenge: result.challenge_token, discord: claims.sub, user: user.id, browser: entry.browser, expires: Date.now() + 300000 });
    return res.json({ requires_2fa: true, challenge });
  }
  res.clearCookie(cookieName, { secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
  res.json(result);
}));
router.post('/2fa', endpoint(async (req, res) => {
  const { challenge, code } = req.body || {};
  check(validOpaque(challenge) && typeof code === 'string' && /^[A-Za-z0-9-]{6,20}$/.test(code));
  const entry = pending.get(challenge);
  check(entry?.challenge && validOpaque(cookie(req)) && entry.browser === hash(cookie(req)));
  pending.delete(challenge); // One attempt per SSO challenge; restart SSO on failure.
  const user = await linkedUser(entry.discord, linksPath, getUser); check(user.id === entry.user);
  const result = await internalToken.verify2FA(entry.challenge, code);
  const active = await linkedUser(entry.discord, linksPath, getUser); check(active.id === entry.user);
  res.clearCookie(cookieName, { secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
  res.json(result);
}));
return router;
}
