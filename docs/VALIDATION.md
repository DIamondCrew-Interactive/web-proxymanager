# Ověření a předprodukční checklist

Navazující Docker ověření: [přesný izolovaný deployment/smoke script](DOCKER-SMOKE.md).
Docker v lokálním prostředí nadále není dostupný. Po opravě orchestrace prošlo
24 unit testů včetně port mappingů, izolace, diagnostiky a porovnání původních
kontejnerů. YAML round-trip prošel nezávislým parserem. Nejde o Docker integrační výsledky.
Operátor DIA-01 potvrdil build, secret scan a image invariants původní verze;
smoke-02 potvrdil networking a production isolation PASS, ale skončil na chybějícím
TLS SNI v HTTPS klientu. Oprava pro smoke-03 prošla čtyřmi novými TLS testy, včetně
reálného lokálního handshake a odmítnutí chybného hostname či nedůvěryhodného certifikátu.

Lokální ověření na Windows, Node 24.14.0, Yarn 1.22.22 a Chromium 145.
Žádný test se nepřipojoval k DIA-01 ani nepoužíval produkční credentials.

| Kontrola | Výsledek |
| --- | --- |
| Upstream tag, commit a package verze | 2.15.1, ověřeno |
| Docker registry AMD64 config digest vs. snapshot image ID | přesná shoda |
| Frozen Yarn install + locale compile | prošlo |
| `tsc && vite build` | prošlo |
| Biome lint, VCS ignore vypnuto | 228 souborů, bez diagnostik |
| Původní Vitest locale testy | 10/10 prošlo |
| Playwright na skutečném sestaveném frontendu | 11/11 prošlo |
| Python bezpečnostní testy backup/deploy/rollback | 6/6 prošlo |
| Porovnání nedotčených upstream zdrojů | 383 souborů byte-identical, stejný yarn.lock |
| Gitleaks distribuovaných zdrojů + static dist | bez nálezů |
| Docker image build/runtime | **neprovedeno: Docker není v prostředí dostupný** |
| Skutečné ACME, Nginx proxy, WebSockets a obnova zálohy | **neprovedeno: vyžaduje izolovaný Docker host** |

Vite hlásí velký hlavní chunk (~2.4 MB / ~739 kB gzip). Jde o architekturu původní
aplikace, nikoli chybu TypeScriptu. Původní přímý Vitest příkaz na Windows narazil
na dev hook `spawn yarn ENOENT`; testy úspěšně proběhly s přiloženou konfigurací,
která používá stejné testy, happy-dom a upstream setup, bez dev-server hooků.

## Prohlížečové scénáře

1. Brand, tmavý výchozí režim, login a přesný původní `POST /api/tokens` payload.
2. 2FA challenge, cancel a ověření původním `/api/tokens/2fa` kontraktem.
3. Dashboard a navigace na všech devět sekcí, bez JS výjimek a zápisů při prohlížení.
4. Proxy Host editor: přepnutí všech panelů, úprava portu, PUT a zachování WebSockets,
   domén a přiřazeného certifikátu.
5. Uživatel s omezenými právy: skryté odkazy a žádné dotazy chráněných přehledů.
6. Mobil 390 × 844: hamburger, zavření navigace, editor v šířce viewportu a Escape.
7. Create dialogy Proxy/Redirection/Stream/404/Access List/User a jejich taby.
8. Let's Encrypt HTTP, DNS a custom certificate dialogy.
9. Vytvoření Proxy Hostu a kontrola původního POST endpointu i hodnot payloadu.
10. Světlý režim, přetrvání preference a odhlášení.
11. Tablet 820 × 1180: zalomení navigace bez horizontálního přetečení stránky.

Zachované upstream soubory zahrnují veškeré modaly, validace, API klienty,
authentication context, mutations a backend. Testy s mock API dokazují funkci UI
a kontrakt požadavků, nikoli úspěšné provedení operace skutečným proxy enginem.
Nelze proto tvrdit, že 100 % produkční funkčnosti bylo integračně ověřeno.

## Rozšířený integrační checklist

Aktuální uživatelem požadovaná release brána je přesně popsaná v `DOCKER-SMOKE.md`.
Internetové ACME issuance/renewal testy nejsou podmínkou této offline smoke brány;
následující seznam popisuje také širší regresní ověření pro budoucí změny upstreamu.

Na izolovaném Docker hostu sestavit image příkazem v README a zkontrolovat jeho
verzi, entrypoint, volumes, ports, runtime prostředí a diff vůči stock základu.
Testovací stack musí mít vlastní projekt, loopback porty a samostatné prázdné
datové adresáře. Nikdy nemountovat produkční `/data` či `/etc/letsencrypt` do testů.

- Login: správné/chybné heslo, 2FA, recovery, změna hesla, session expiry, logout.
- Proxy/Redirection/Streams/404: create/edit/delete/enable/disable; skutečný HTTP,
  HTTPS, redirect status, TCP i UDP provoz podle používané konfigurace.
- Proxy editor: hostname/IP, port, WebSocket upgrade, cache, exploit protection,
  custom locations a advanced Nginx config; otestovat skutečný WebSocket handshake.
- SSL: upload testovacího certifikátu, přiřazení, download, expirace a obnova.
  ACME ověřovat s testovacími doménami a staging prostředím; žádné produkční klíče
  nebo DNS credentials do zdrojů, artefaktů či screenshotů.
- Access Lists: Basic Auth a IP allow/deny musí fungovat v samotném proxy provozu.
- Users: administrator i omezený uživatel, změny práv a profilu; Audit Logs musí
  zachytit provedené testovací změny.
- Settings: změna Default Site v izolovaném stacku a odpovídající HTTP odpověď.
- UI: dlouhé domény, mnoho řádků, search/sort, dropdowny u posledních řádků tabulky,
  chyby validace, API chyby, klávesnice, jazyk, mobil a velké modaly.
- Záloha: ověřit diskovou kapacitu, TAR obsah, checksumy, načtení uloženého image
  a obnovu dat na samostatném testovacím hostu. Zálohu neodesílat do CI.
- Rollback motivu: vytvořit změnu v testovací konfiguraci, vrátit stock image a
  ověřit, že nová změna zůstala v DB a všechny služby dál fungují.

Teprve po těchto kontrolách lze na DIA-01 spustit připravený backup a následný
deployment. Při zjištění rozdílu mountů/portů/sítí/DB/image se postup zastaví k auditu.

## Náhledy

Všechny zachycují syntetické `example.test` domény a dokumentační IP rozsah.

- [Dashboard](previews/dashboard.png)
- [Login](previews/login.png)
- [Proxy Host editor](previews/proxy-editor.png)
- [Mobilní editor](previews/mobile-editor.png)
