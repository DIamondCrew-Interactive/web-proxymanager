// Runs ONLY inside the disposable NPM test container, invoked by docker-test.py.
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import express from 'express';
import { generate } from 'otplib';
import { compareProfiles, compareClaims, compareDenials, checked } from './native-permissions.mjs';
import { diagnostic } from './native-diagnostics.mjs';
import { createRouter } from './router.mjs';
import { manageLinks } from './links.mjs';
import { ISSUER, ORIGIN, opaque, hash } from './core.mjs';
const path = '/data/dci-sso-native-test';
const headers = { 'Content-Type':'application/json' };
let testServer, db, stage='backend_health', lastApi=null;
function mark(value){stage=value;lastApi=null;console.log('STAGE '+value);}
async function api(method, route, body, token, expected=200) {
  lastApi={route,method,status:null,expected};
  const response=await fetch('http://127.0.0.1:3000'+route,{method,headers:{...headers,...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  lastApi.status=response.status;
  assert.equal(response.status,expected,'NPM API status'); return response.json();
}
try {
  for(let i=0;;i++){try{const health=await api('GET','/');assert.equal(health.setup,false);break;}catch(e){if(i>=90)throw e;await new Promise(r=>setTimeout(r,2000));}}
  mark('native_imports');
  const [{default:userModel},{default:tokenModel},{default:internalToken},{default:twoFactor},{default:database}] = await Promise.all([import('../models/user.js'),import('../models/token.js'),import('../internal/token.js'),import('../internal/2fa.js'),import('../db.js')]);
  db=database;
  mark('mounted_sso_route');
  assert.equal((await api('GET','/sso/status')).enabled,false);
  const password=randomBytes(32).toString('base64url');
  mark('create_admin');
  await api('POST','/users',{name:'SSO Test Admin',nickname:'Test',email:'admin@sso.example.test',auth:{type:'password',secret:password}},undefined,201);
  mark('password_login');
  const admin=(await api('POST','/tokens',{identity:'admin@sso.example.test',secret:password})).token;
  mark('create_viewer');
  const viewer=await api('POST','/users',{name:'SSO Test Viewer',nickname:'Viewer',email:'viewer@sso.example.test',roles:[],auth:{type:'password',secret:password}},admin,201);
  mark('link_viewer');
  mkdirSync(path,{recursive:true,mode:0o700});
  const linksPath=path+'/links.json', configPath=path+'/config.json', discord=String(10n ** 17n + BigInt('0x' + randomBytes(7).toString('hex')));
  const getUser=id=>userModel.query().findById(id);
  await manageLinks(['sso','link',String(viewer.id),discord],linksPath,getUser);
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),secret=opaque();
  writeFileSync(configPath,JSON.stringify({enabled:true,issuer:ISSUER,audience:'proxymanager',verification_keys:{test:publicKey.export({type:'spki',format:'pem'})},redeem_secret:secret}),{mode:0o600});
  let expectedChallenge;
  const fakeBroker=async(url,options)=>{
    assert.equal(url,ISSUER+'/sso/api/redeem');assert.equal(options.headers.Authorization,'Bearer '+secret);
    const {state,code_verifier,audience}=JSON.parse(options.body);assert.equal(audience,'proxymanager');assert.equal(hash(code_verifier),expectedChallenge);
    const now=Math.floor(Date.now()/1000);
    const parts=[{alg:'EdDSA',kid:'test'},{iss:ISSUER,aud:audience,sub:discord,iat:now,exp:now+45,jti:opaque(),state}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
    return {ok:true,text:async()=>JSON.stringify({assertion:parts+'.'+sign(null,Buffer.from(parts),privateKey).toString('base64url'),token_type:'DCI-SSO',expires_in:45})};
  };
  mark('start_synthetic_broker_adapter');
  const app=express();app.use(express.json());app.use('/sso',createRouter({express,getUser,tokenModel,twoFactor,internalToken,configPath,linksPath,replayPath:path+'/replay',fetchImpl:fakeBroker}));
  testServer=app.listen(0,'127.0.0.1');await new Promise(r=>testServer.once('listening',r));
  const base='http://127.0.0.1:'+testServer.address().port;
  async function post(route,body={},cookie=''){lastApi={route:'/sso/'+route,method:'POST',status:null,expected:null};const response=await fetch(base+'/sso/'+route,{method:'POST',headers:{...headers,Origin:ORIGIN,Cookie:cookie},body:JSON.stringify(body)});lastApi.status=response.status;return response;}
  async function login(){const start=await post('start');assert.equal(start.status,200);const cookie=start.headers.get('set-cookie').split(';')[0];const url=new URL((await start.json()).url);expectedChallenge=url.searchParams.get('code_challenge');const state=url.searchParams.get('state'),ticket=opaque();const response=await post('callback',{ticket,state},cookie);return {response,cookie,state,ticket};}
  mark('sso_callback');
  const first=await login();assert.equal(first.response.status,200);const full=await first.response.json();mark('sso_token_identity');assert.equal((await api('GET','/users/me',undefined,full.token)).id,viewer.id);
  mark('native_password_equivalence');
  const passwordViewer=(await api('POST','/tokens',{identity:'viewer@sso.example.test',secret:password})).token;
  compareProfiles(await api('GET','/users/me?expand=permissions',undefined,passwordViewer),await api('GET','/users/me?expand=permissions',undefined,full.token),viewer.id);
  compareClaims(await tokenModel().load(passwordViewer),await tokenModel().load(full.token),viewer.id);
  mark('viewer_permissions');
  const deniedBody={name:'Forbidden',nickname:'No',email:'forbidden@sso.example.test',roles:['admin'],auth:{type:'password',secret:password}};
  async function denial(token){const response=await fetch('http://127.0.0.1:3000/users',{method:'POST',headers:{...headers,Authorization:'Bearer '+token},body:JSON.stringify(deniedBody)});return {status:response.status,body:await response.json()};}
  const nativeDenied=await denial(passwordViewer),ssoDenied=await denial(full.token);
  lastApi={route:'/users',method:'POST',status:ssoDenied.status,expected:nativeDenied.status,native_status:nativeDenied.status,sso_status:ssoDenied.status,native_error_code:nativeDenied.body?.error?.code,sso_error_code:ssoDenied.body?.error?.code};
  compareDenials(nativeDenied,ssoDenied);
  const unauthorized=await userModel.query().where('email','forbidden@sso.example.test').first();
  checked('no_unauthorized_user',()=>assert.equal(unauthorized,undefined));
  console.log('PERMISSION_EQUIVALENCE '+JSON.stringify({native_status:nativeDenied.status,sso_status:ssoDenied.status,canonical_profile:true,canonical_scope:true,no_new_user:true}));
  mark('ticket_replay');
  assert.equal((await post('callback',{ticket:first.ticket,state:first.state},first.cookie)).status,401);
  mark('setup_2fa');
  const setup=await api('POST','/users/me/2fa',{},full.token);
  mark('enable_2fa');
  await api('POST','/users/me/2fa/enable',{code:await generate({secret:setup.secret})},full.token);
  mark('sso_2fa_challenge');
  const second=await login();const challenge=await second.response.json();assert.equal(challenge.requires_2fa,true);assert.equal(challenge.token,undefined);
  mark('verify_2fa');
  const completed=await post('2fa',{challenge:challenge.challenge,code:await generate({secret:setup.secret})},second.cookie);assert.equal(completed.status,200);
  assert.equal((await api('GET','/users/me',undefined,(await completed.json()).token)).id,viewer.id);
  mark('disabled_user');
  await userModel.query().findById(viewer.id).patch({is_disabled:1});assert.equal((await login()).response.status,401);
  mark('unlink_user');
  await manageLinks(['sso','unlink',discord],linksPath,getUser);assert.equal((await login()).response.status,401);
  console.log('PASS: real NPM user token, viewer permissions, native 2FA, replay, disabled account and unlink. Broker is local synthetic adapter; no Staff/internet calls.');
} catch(error) { const report=diagnostic(stage,error,lastApi);writeFileSync('/data/dci-sso-native-failure.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});console.error('FAIL '+JSON.stringify(report));process.exitCode=1; }
finally {if(testServer)await new Promise(r=>{testServer.closeAllConnections();testServer.close(r);});if(db)await db().destroy();}
