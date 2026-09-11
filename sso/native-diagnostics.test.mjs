import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnostic } from './native-diagnostics.mjs';
test('Native diagnostic keeps fixed stage/status and discards secrets/stack/assertion operands',()=>{
 const sensitive='never-serialize-this';
 const error={name:'AssertionError',code:'ERR_ASSERTION',message:sensitive,stack:sensitive,actual:sensitive,expected:sensitive};
 const result=diagnostic('sso_token_identity',error,{route:'/users/me',method:'GET',status:401,expected:200,body:sensitive,headers:{Authorization:sensitive}});
 assert.deepEqual(result,{stage:'sso_token_identity',error_type:'AssertionError',error_code:'ERR_ASSERTION',api:{route:'/users/me',method:'GET',status:401,expected:200}});
 assert.ok(!JSON.stringify(result).includes(sensitive));
 assert.deepEqual(diagnostic(sensitive,{name:sensitive,code:sensitive},{route:'/callback?token='+sensitive,method:'POST'}),{stage:'unknown',error_type:'Error',error_code:'UNKNOWN'});
});
