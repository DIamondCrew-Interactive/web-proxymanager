// Strict diagnostic allowlist: never serialize errors, request bodies or headers.
const stages=new Set(['backend_health','native_imports','mounted_sso_route','create_admin','password_login','create_viewer','link_viewer','start_synthetic_broker_adapter','sso_callback','sso_token_identity','viewer_permissions','native_password_equivalence','ticket_replay','setup_2fa','enable_2fa','sso_2fa_challenge','verify_2fa','disabled_user','unlink_user']);
const names=new Set(['Error','AssertionError','TypeError','SyntaxError','RangeError','AbortError','TimeoutError']);
const codes=new Set(['ERR_ASSERTION','ECONNREFUSED','ETIMEDOUT','ENOENT','EACCES','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE']);
const routes=new Set(['/','/sso/status','/users','/tokens','/users/me','/users/me?expand=permissions','/users/me/2fa','/users/me/2fa/enable','/sso/start','/sso/callback','/sso/2fa']);
export function diagnostic(stage,error,lastApi){
 const result={stage:stages.has(stage)?stage:'unknown',error_type:names.has(error?.name)?error.name:'Error',error_code:codes.has(error?.code)?error.code:'UNKNOWN'};
 if(lastApi&&routes.has(lastApi.route)&&['GET','POST'].includes(lastApi.method))result.api={route:lastApi.route,method:lastApi.method,status:Number.isInteger(lastApi.status)?lastApi.status:null,expected:Number.isInteger(lastApi.expected)?lastApi.expected:null};
 const labels=new Set(['identity_id','identity_roles','identity_permissions','token_user_id','token_scope','native_permission_denial','sso_permission_equivalence','no_unauthorized_user']);
 if(labels.has(error?.ssoAssertion))result.assertion_label=error.ssoAssertion;
 if(result.api)for(const key of ['native_status','sso_status','native_error_code','sso_error_code'])if(Number.isInteger(lastApi[key]))result.api[key]=lastApi[key];
 return result;
}
