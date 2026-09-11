# Secret scan

Provedeno lokálně 2026-09-11 pomocí **Gitleaks 8.24.2**. Oficiální stažený ZIP
scanneru byl ověřen vůči SHA-256 v release checksums. Reporty používají `--redact`;
do terminálu nebyly vypisovány hodnoty nálezů.

| Rozsah | Výsledek |
| --- | --- |
| Původní export `export-proxymanager` | 19 nálezů ve veřejných upstream příkladech |
| Allowlist nových distribuovaných zdrojů | 0 nálezů |
| Sestavené statické soubory frontendu | 0 nálezů |

Nálezy v exportu jsou v šesti souborech: API schemas tokenů/login-as/2FA, schema
uploadu certifikátu a `certbot/dns-plugins.json`. Po normalizaci konců řádků byly
**celé soubory porovnány s backendem veřejného upstream tagu v2.15.1 a jsou shodné**.
Nejde o potvrzené produkční secrets. Původní export přesto zůstává vyloučený z
distribuce, protože obsahuje provozní konfiguraci a může obsahovat citlivý kontext.

Scanner není důkaz absolutní absence všech možných tajemství. Gitleaks nemusel
kontrolovat ignorované dependencies; node_modules není součást předávaných zdrojů.
Bezpečnost předání stojí také na explicitním allowlistu: žádné `.env`, DB, certifikáty,
private keys, container inspect, produkční Compose nebo datové volumes se nekopírují.
Bitmapa loga pochází přímo od uživatele, screenshoty jsou ze syntetického testovacího
prostředí. Testovací sessions/domény nejsou platné produkční credentials.

Reprodukce:

```bash
python3 scripts/secret-scan.py --gitleaks /path/to/gitleaks --package
gitleaks dir .build/frontend/dist --redact --no-banner \
  --report-format json --report-path .build/frontend-secret-scan.json
```

ZIP vznikne jen po úspěšném scanu. `.build/source-manifest.json` obsahuje hash
každého distribuovaného souboru. Redigované reporty zůstávají lokálně v `.build`
nebo `.cache`; nepublikují se spolu s produkčními podklady.

Přesný stock NPM image obsahuje veřejný CA trust store a upstream ukázky. Nelze
odstranit jeho legitimní certifikační infrastrukturu a současně tvrdit, že engine
zůstal shodný. Zakázána je distribuce produkčních certifikátů, klíčů a credentials.
