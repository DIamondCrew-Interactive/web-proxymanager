import { useEffect, useRef, useState } from 'react';
import AuthStore from 'src/modules/AuthStore';
async function post(path: string, body: object = {}) {
  const response = await fetch('/api/sso/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw Error('SSO sign-in failed. Try password sign-in or contact your administrator.');
  return response.json();
}
export default function SSOLogin() {
  const callback = window.location.pathname === '/auth/sso/callback';
  const started = useRef(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState('');
  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(callback);
  const accept = (data: any) => {
    if (data.requires_2fa && typeof data.challenge === 'string') { setChallenge(data.challenge); return; }
    if (typeof data.token !== 'string' || typeof data.expires !== 'string') throw Error('Invalid sign-in response');
    AuthStore.set({ token: data.token, expires: data.expires });
    window.location.replace('/');
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (callback) {
      const params = new URLSearchParams(window.location.search);
      const body = { ticket: params.get('ticket'), state: params.get('state') };
      window.history.replaceState(null, '', '/auth/sso/callback');
      post('callback', body).then(accept).catch(e => setError(e.message)).finally(() => setBusy(false));
    } else {
      fetch('/api/sso/status', { credentials: 'same-origin' }).then(r => r.json()).then(d => setEnabled(d.enabled === true)).catch(() => {});
    }
  }, []);
  const start = async () => {
    setBusy(true); setError('');
    try { const data = await post('start'); const url = new URL(data.url); if (url.origin !== 'https://staff.diamondcrew.net' || url.pathname !== '/sso/proxymanager') throw Error('Invalid SSO destination'); window.location.assign(url.href); }
    catch (e) { setError(e instanceof Error ? e.message : 'SSO unavailable'); setBusy(false); }
  };
  if (!callback && !enabled) return null;
  return <div className={callback ? 'container container-tight py-5' : 'mb-3'}>
    {callback && <h1>DiamondCrew Interactive · Proxy Manager</h1>}
    {error && <div role="alert" className="alert alert-danger">{error}</div>}
    {challenge ? <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { accept(await post('2fa', { challenge, code })); } catch (e) { setChallenge(''); setError(e instanceof Error ? e.message : 'Verification failed'); } finally { setBusy(false); } }}>
      <label className="form-label">NPM verification code<input className="form-control" value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" required maxLength={20} /></label>
      <button className="btn btn-primary" disabled={busy}>Verify</button>
    </form> : <button type="button" className="btn btn-primary w-100" disabled={busy} onClick={start}>{busy ? 'Signing in…' : 'Continue with DiamondCrew Interactive'}</button>}
    {callback && <a className="d-block mt-3" href="/">Use password sign-in</a>}
  </div>;
}
