import { Link } from 'react-router-dom';
import { HasPermission } from 'src/components';
import { useProxyHosts, useCertificates } from 'src/hooks';
import { T } from 'src/locale';
import { PROXY_HOSTS, CERTIFICATES, VIEW } from 'src/modules/Permissions';

// Mount queries inside upstream permission boundaries, including for restricted users.
function Hosts() {
  const query = useProxyHosts();
  return <section className="card">
    <div className="card-header"><h3 className="card-title"><T id="proxy-hosts" /></h3><Link to="/nginx/proxy" aria-label="Proxy Hosts">→</Link></div>
    {query.isPending ? <p className="p-3" role="status"><T id="loading" /></p> : query.isError ? <p className="p-3 text-danger" role="alert">{query.error.message}</p> : !query.data?.length ? <p className="p-3 text-secondary"><T id="empty-subtitle" /></p> :
      <div className="table-responsive"><table className="table table-hover"><thead><tr><th><T id="domain-names" /></th><th><T id="column.destination" /></th><th><T id="column.status" /></th></tr></thead><tbody>
      {[...query.data].sort((a, b) => b.createdOn.localeCompare(a.createdOn)).slice(0, 5).map(host => <tr key={host.id}>
        <td className="domain-name">{host.domainNames.join(', ')}</td><td>{host.forwardScheme}://{host.forwardHost}:{host.forwardPort}</td>
        <td><span className={`badge ${host.enabled ? 'bg-green-lt' : 'bg-secondary-lt'}`}><T id={host.enabled ? 'enabled' : 'disabled'} /></span></td>
      </tr>)}</tbody></table></div>}
  </section>;
}

function Certificates() {
  const query = useCertificates();
  return <section className="card">
    <div className="card-header"><h3 className="card-title"><T id="certificates" /></h3><Link to="/certificates" aria-label="SSL Certificates">→</Link></div>
    {query.isPending ? <p className="p-3" role="status"><T id="loading" /></p> : query.isError ? <p className="p-3 text-danger" role="alert">{query.error.message}</p> : !query.data?.length ? <p className="p-3 text-secondary"><T id="empty-subtitle" /></p> :
      <div className="table-responsive"><table className="table table-hover"><thead><tr><th><T id="domain-names" /></th><th><T id="column.expires" /></th></tr></thead><tbody>
      {[...query.data].sort((a, b) => a.expiresOn.localeCompare(b.expiresOn)).slice(0, 5).map(cert => <tr key={cert.id}>
        <td className="domain-name">{cert.domainNames.join(', ') || cert.niceName}</td>
        <td><time className={new Date(cert.expiresOn).getTime() < Date.now() ? 'text-danger' : 'text-secondary'} dateTime={cert.expiresOn}>{cert.expiresOn ? new Date(cert.expiresOn).toLocaleDateString() : '—'}</time></td>
      </tr>)}</tbody></table></div>}
  </section>;
}

export function Overview() {
  return <div className="dc-overview">
    <HasPermission section={PROXY_HOSTS} permission={VIEW} hideError><Hosts /></HasPermission>
    <HasPermission section={CERTIFICATES} permission={VIEW} hideError><Certificates /></HasPermission>
  </div>;
}

export function Hero() {
  return <div className="dc-hero"><div className="dc-eyebrow">DiamondCrew Interactive</div><h2>Proxy Manager</h2></div>;
}
