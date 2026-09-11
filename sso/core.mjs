import { createHash, createPublicKey, verify, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
export const ISSUER = 'https://staff.diamondcrew.net';
export const ORIGIN = 'https://proxy.diamondcrew.net';
export const validOpaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const validDiscord = value => typeof value === 'string' && /^[1-9][0-9]{16,19}$/.test(value);
export const hash = value => createHash('sha256').update(value).digest('base64url');
export const opaque = () => randomBytes(32).toString('base64url');
export function check(condition) { if (!condition) throw Error('SSO denied'); }
export function readConfig(path = '/run/secrets/dci-sso.json') {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  check(config.enabled === true && config.issuer === ISSUER && config.audience === 'proxymanager');
  check(typeof config.redeem_secret === 'string' && config.redeem_secret.length >= 32 && !/[\r\n]/.test(config.redeem_secret));
  const configured = config.verification_keys ?? { [config.kid]: config.public_key_pem };
  check(configured && typeof configured === 'object' && !Array.isArray(configured));
  check(Object.keys(configured).length > 0 && Object.keys(configured).length <= 16);
  const keys = new Map();
  for (const [kid, pem] of Object.entries(configured)) {
    check(/^[A-Za-z0-9._-]{1,80}$/.test(kid) && typeof pem === 'string');
    const key = createPublicKey(pem); check(key.asymmetricKeyType === 'ed25519'); keys.set(kid, key);
  }
  return { ...config, keys };
}
export function verifyAssertion(jwt, config, state, now = Math.floor(Date.now() / 1000)) {
  check(typeof jwt === 'string' && jwt.length < 8192);
  const parts = jwt.split('.');
  check(parts.length === 3 && parts.every(p => /^[A-Za-z0-9_-]+$/.test(p)));
  const [header, payload] = parts.slice(0, 2).map(p => JSON.parse(Buffer.from(p, 'base64url')));
  check(header.alg === 'EdDSA' && typeof header.kid === 'string' && config.keys.has(header.kid) && !header.crit && !header.jku && !header.jwk && !header.x5u);
  check(verify(null, Buffer.from(parts.slice(0, 2).join('.')), config.keys.get(header.kid), Buffer.from(parts[2], 'base64url')));
  check(payload.iss === ISSUER && payload.aud === 'proxymanager' && validDiscord(payload.sub));
  check(Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp));
  check(payload.iat <= now + 5 && payload.iat >= now - 50 && payload.exp > now && payload.exp - payload.iat > 0 && payload.exp - payload.iat <= 45);
  check(payload.nbf === undefined || (Number.isSafeInteger(payload.nbf) && payload.nbf <= now));
  check(payload.state === state && validOpaque(state));
  check(typeof payload.jti === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(payload.jti));
  return payload;
}
export function consumeAssertion(directory, jti) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Atomic exclusive create: survives restart and rejects concurrent replays.
  writeFileSync(join(directory, hash(jti)), 'used\n', { flag: 'wx', mode: 0o600 });
}
export function readLinks(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
export async function linkedUser(discord, linksPath, getUser) {
  check(validDiscord(discord));
  const id = readLinks(linksPath)[discord];
  check(Number.isSafeInteger(id) && id > 0);
  const user = await getUser(id);
  check(user && user.id === id && !user.is_deleted && !user.is_disabled);
  return user;
}
export async function npmSession(user, { getUser, twoFactor, tokenModel, internalToken }) {
  const active = await getUser(user.id);
  check(active && !active.is_deleted && !active.is_disabled);
  if (await twoFactor.isEnabled(user.id)) {
    const challenge = await tokenModel().create({ iss: 'api', attrs: { id: user.id }, scope: ['2fa-challenge'], expiresIn: '5m' });
    return { requires_2fa: true, challenge_token: challenge.token };
  }
  const result = await internalToken.getTokenFromUser(active);
  return { token: result.token, expires: result.expires };
}
