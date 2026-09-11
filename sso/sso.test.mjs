import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createRouter } from './router.mjs';
import { readConfig, verifyAssertion, consumeAssertion, opaque, hash, ISSUER, ORIGIN, linkedUser, npmSession } from './core.mjs';
import { manageLinks } from './links.mjs';
const keys = generateKeyPairSync('ed25519');
const config = { keys: new Map([['test-key', keys.publicKey]]), kid: 'test-key' };
const discord = String(10n ** 17n + BigInt('0x' + randomBytes(7).toString('hex')));
const user = { id: 7, is_disabled: false, is_deleted: false, roles: [] };
function jwt(state, overrides = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: ISSUER, aud: 'proxymanager', sub: discord, iat: now, exp: now + 45, state, jti: opaque(), ...overrides };
  const encoded = [ { alg: 'EdDSA', kid: config.kid, ...header }, body ].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return encoded + '.' + sign(null, Buffer.from(encoded), keys.privateKey).toString('base64url');
}
function folder(t) { const path = mkdtempSync(join(tmpdir(), 'dci-sso-test-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
test('Ed25519 assertion accepts exact issuer/audience/state/string DiscordID', () => { const state = opaque(); assert.equal(verifyAssertion(jwt(state), config, state).sub, discord); });
test('JWT rejects invalid claims, expired tokens, algorithm/key substitution and signatures', () => {
  const state = opaque();
  for (const changes of [{ iss: ISSUER + '/' }, { aud: 'staff' }, { sub: Number(discord) }, { exp: 1 }, { iat: 1 }, { state: opaque() }, { exp: Math.floor(Date.now()/1000)+60 }, { jti: '' }]) assert.throws(() => verifyAssertion(jwt(state, changes), config, state));
  for (const header of [{ alg: 'none' }, { kid: 'unknown' }, { jku: 'https://example.test/key' }]) assert.throws(() => verifyAssertion(jwt(state, {}, header), config, state));
  const token = jwt(state).split('.'); token[2] = Buffer.alloc(64).toString('base64url'); assert.throws(() => verifyAssertion(token.join('.'), config, state));
});
test('Replay rejection persists across calls and concurrent exclusive writes', t => { const dir = folder(t); const jti = opaque(); consumeAssertion(dir, jti); assert.throws(() => consumeAssertion(dir, jti)); });
test('CLI links existing users, lists/shows/unlinks; rejects overwrite/disabled/deleted/unsafe IDs', async t => {
  const path = join(folder(t), 'links.json'); const getUser = async id => id === 7 ? user : null;
  await manageLinks(['sso','link','7',discord], path, getUser);
  assert.equal((await manageLinks(['sso','show',discord], path, getUser)).user_id, 7);
  assert.equal((await manageLinks(['sso','list'], path, getUser))[discord], 7);
  for (const target of ['8','1e3','-1','9007199254740999']) await assert.rejects(manageLinks(['sso','link',target,discord], path, getUser));
  for (const flag of ['is_disabled','is_deleted']) await assert.rejects(manageLinks(['sso','link','7',discord], path, async () => ({...user,[flag]:true})));
  await manageLinks(['sso','unlink',discord], path, getUser);
  await assert.rejects(linkedUser(discord,path,getUser));
});
test('Native session issues user token or native 2FA challenge without escalating roles', async () => {
  let captured; const deps = { getUser: async () => user, twoFactor: {isEnabled: async () => true}, tokenModel: () => ({create: async value => { captured = value; return {token:'test-challenge'}; }}), internalToken: { getTokenFromUser: async u => { assert.deepEqual(u.roles,[]); return {token:'test-user-token',expires:'date',user:u}; }} };
  assert.equal((await npmSession(user,deps)).requires_2fa,true); assert.deepEqual(captured.scope,['2fa-challenge']); assert.equal(captured.attrs.id,7);
  deps.twoFactor.isEnabled = async () => false; assert.deepEqual(await npmSession(user,deps),{token:'test-user-token',expires:'date'});
  deps.getUser = async () => ({...user,is_disabled:true}); await assert.rejects(npmSession(user,deps));
});
async function harness(t, twoFA = false) {
  const dir = folder(t), configPath = join(dir,'config.json'), linksPath = join(dir,'links.json');
  const secret = opaque();
  writeFileSync(configPath,JSON.stringify({enabled:true,issuer:ISSUER,audience:'proxymanager',verification_keys:{[config.kid]:keys.publicKey.export({type:'spki',format:'pem'})},redeem_secret:secret}));
  writeFileSync(linksPath,JSON.stringify({[discord]:7}));
  let currentUser = {...user}, redeemCount=0, returnedJWT, challengeExpected;
  const deps = { express, configPath, linksPath, replayPath:join(dir,'replays'), getUser:async () => currentUser,
    tokenModel:() => ({create:async data => {assert.deepEqual(data.scope,['2fa-challenge']); return {token:'native-challenge'};}}),
    twoFactor:{isEnabled:async () => twoFA}, internalToken:{getTokenFromUser:async () => ({token:'native-token',expires:'expiry'}),verify2FA:async (challenge, code) => {assert.equal(challenge,'native-challenge'); assert.equal(code,'123456'); return {token:'native-token',expires:'expiry'};}},
    fetchImpl:async (url, options) => {redeemCount++; assert.equal(url,ISSUER+'/sso/api/redeem'); assert.equal(options.headers.Authorization,'Bearer '+secret); assert.equal(options.redirect,'error'); const body=JSON.parse(options.body); assert.equal(body.audience,'proxymanager'); assert.equal(hash(body.code_verifier),challengeExpected); return {ok:true,text:async()=>JSON.stringify({assertion:returnedJWT||jwt(body.state),token_type:'DCI-SSO',expires_in:45})};} };
  const app=express(); app.use(express.json()); app.use('/api/sso',createRouter(deps));
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const base='http://127.0.0.1:'+server.address().port;
  async function post(path, body={}, cookie='', origin=ORIGIN) {return fetch(base+'/api/sso/'+path,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});}
  async function start(){const response=await post('start'); assert.equal(response.status,200); const cookie=response.headers.get('set-cookie'); assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/); const url=new URL((await response.json()).url);assert.equal(url.origin,ISSUER); assert.equal(url.pathname,'/sso/proxymanager'); challengeExpected=url.searchParams.get('code_challenge'); return {state:url.searchParams.get('state'),cookie:cookie.split(';')[0],ticket:opaque()};}
  return {post,start,get count(){return redeemCount;},disable(){currentUser.is_disabled=true;},unlink(){writeFileSync(linksPath,'{}');},overrideJWT(value){returnedJWT=value;}};
}
test('HTTP callback binds cookie/state/PKCE and issues native session exactly once', async t=>{const h=await harness(t);const flow=await h.start();const body={state:flow.state,ticket:flow.ticket};const response=await h.post('callback',body,flow.cookie);assert.equal(response.status,200);assert.equal((await response.json()).token,'native-token');assert.equal((await h.post('callback',body,flow.cookie)).status,401);assert.equal(h.count,1);});
test('Cross-origin, wrong cookie, wrong state and malformed ticket cannot redeem', async t=>{const h=await harness(t);const flow=await h.start();assert.equal((await h.post('start',{},'', 'https://evil.example')).status,401);for(const [body,cookie] of [[{ticket:flow.ticket,state:opaque()},flow.cookie],[{ticket:'bad',state:flow.state},flow.cookie],[{ticket:flow.ticket,state:flow.state},'__Host-dci-sso='+opaque()]]) assert.equal((await h.post('callback',body,cookie)).status,401);assert.equal(h.count,0);});
test('Disabled or unlinked user cannot obtain native session',async t=>{for(const change of ['disable','unlink']){const h=await harness(t);const flow=await h.start();h[change]();assert.equal((await h.post('callback',{ticket:flow.ticket,state:flow.state},flow.cookie)).status,401);}});
test('2FA uses native verifier and rechecks mapping before issuing full token',async t=>{const h=await harness(t,true);const flow=await h.start();const result=await (await h.post('callback',{ticket:flow.ticket,state:flow.state},flow.cookie)).json();assert.equal(result.requires_2fa,true);assert.equal(result.token,undefined);const response=await h.post('2fa',{challenge:result.challenge,code:'123456'},flow.cookie);assert.equal(response.status,200);assert.equal((await response.json()).token,'native-token');assert.equal((await h.post('2fa',{challenge:result.challenge,code:'123456'},flow.cookie)).status,401);});
test('Disabled account during 2FA cannot finish SSO',async t=>{const h=await harness(t,true);const flow=await h.start();const result=await (await h.post('callback',{ticket:flow.ticket,state:flow.state},flow.cookie)).json();h.disable();assert.equal((await h.post('2fa',{challenge:result.challenge,code:'123456'},flow.cookie)).status,401);});

test('Runtime key rotation accepts local overlap keys and rejects unknown kid', t => {
  const path=join(folder(t),'config.json');
  const second=generateKeyPairSync('ed25519');
  const values={enabled:true,issuer:ISSUER,audience:'proxymanager',verification_keys:{'test-key':keys.publicKey.export({type:'spki',format:'pem'}),previous:second.publicKey.export({type:'spki',format:'pem'})},redeem_secret:opaque()};
  writeFileSync(path,JSON.stringify(values));const loaded=readConfig(path);assert.equal(loaded.keys.size,2);
  const state=opaque();assert.equal(verifyAssertion(jwt(state),loaded,state).sub,discord);
  delete values.verification_keys['test-key'];writeFileSync(path,JSON.stringify(values));assert.throws(()=>verifyAssertion(jwt(state),readConfig(path),state));
});
