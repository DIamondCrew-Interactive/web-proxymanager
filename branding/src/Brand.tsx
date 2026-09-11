export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className={`dc-brand${compact ? ' dc-brand-compact' : ''}`}>
    <img src="/diamondcrew/logo.png" alt="" width={64} height={64} />
    <span className="dc-wordmark"><strong>DiamondCrew</strong><span>Interactive</span><small>Proxy Manager</small></span>
  </span>;
}
