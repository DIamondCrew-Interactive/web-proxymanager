import assert from 'node:assert/strict';
export function checked(label, action){try{return action();}catch(error){error.ssoAssertion=label;throw error;}}
export function compareProfiles(native,sso,expectedId){
 checked('identity_id',()=>{assert.equal(native.id,expectedId);assert.equal(sso.id,expectedId);});
 checked('identity_roles',()=>{assert.ok(Array.isArray(native.roles));assert.ok(Array.isArray(sso.roles));assert.deepEqual([...sso.roles].sort(),[...native.roles].sort());assert.ok(!sso.roles.includes('admin'));});
 checked('identity_permissions',()=>{assert.ok(native.permissions&&sso.permissions);assert.deepEqual(sso.permissions,native.permissions);assert.equal(native.permissions.visibility,'user');});
}
export function compareClaims(native,sso,expectedId){
 checked('token_user_id',()=>{assert.equal(native.attrs.id,expectedId);assert.equal(sso.attrs.id,expectedId);});
 checked('token_scope',()=>{assert.deepEqual(native.scope,['user']);assert.deepEqual(sso.scope,native.scope);assert.equal(sso.iss,native.iss);});
}
export function compareDenials(native,sso){
 // NPM 2.15.1 Access.can throws PermissionError without `new`. That throws
 // undefined, route next(undefined) reaches the Not Found fallback (404).
 // Also accept correctly constructed 403, but only if native and SSO agree.
 const valid=(r)=>(r.status===403&&r.body?.error?.code===403&&r.body.error.message==='Permission Denied') ||
                 (r.status===404&&r.body?.error?.code===404&&r.body.error.message==='Not Found - /users');
 checked('native_permission_denial',()=>assert.ok(valid(native)));
 checked('sso_permission_equivalence',()=>{assert.ok(valid(sso));assert.equal(sso.status,native.status);assert.deepEqual(sso.body.error,native.body.error);});
}
