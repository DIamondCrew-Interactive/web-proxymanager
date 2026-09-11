import test from 'node:test';
import assert from 'node:assert/strict';
import { compareProfiles,compareClaims,compareDenials } from './native-permissions.mjs';
import { diagnostic } from './native-diagnostics.mjs';
const denial=status=>({status,body:{error:{code:status,message:status===404?'Not Found - /users':'Permission Denied'}}});
test('Denial equivalence accepts exact pinned native fallback, rejects escalation/mismatch/500/validation',()=>{
 for(const code of [403,404])compareDenials(denial(code),denial(code));
 for(const code of [200,201,400,500])assert.throws(()=>compareDenials(denial(code),denial(code)));
 assert.throws(()=>compareDenials(denial(404),denial(403)));
 assert.throws(()=>compareDenials(denial(404),{status:404,body:{error:{code:404,message:'Other failure'}}}));
});
test('Canonical account permissions and native token scopes must match without admin role',()=>{
 const profile={id:2,roles:[],permissions:{visibility:'user',proxy_hosts:'manage'}};
 compareProfiles(profile,structuredClone(profile),2);
 assert.throws(()=>compareProfiles(profile,{...profile,roles:['admin']},2));
 assert.throws(()=>compareProfiles(profile,{...profile,permissions:{visibility:'all'}},2));
 const claims={attrs:{id:2},scope:['user'],iss:'api'};compareClaims(claims,structuredClone(claims),2);
 assert.throws(()=>compareClaims(claims,{...claims,scope:['admin']},2));
});
test('Permission diagnostic exposes only allowlisted assertion and numeric comparison statuses',()=>{
 let error;try{compareDenials(denial(404),denial(403));}catch(e){error=e;}
 const result=diagnostic('viewer_permissions',error,{route:'/users',method:'POST',status:403,expected:404,native_status:404,sso_status:403,native_error_code:404,sso_error_code:403,token:'never print'});
 assert.equal(result.assertion_label,'sso_permission_equivalence');assert.equal(result.api.native_status,404);assert.equal(result.api.sso_status,403);assert.ok(!JSON.stringify(result).includes('never print'));
});
