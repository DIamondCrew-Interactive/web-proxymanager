# Izolovaný Docker smoke test pro DIA-01

**Stav podle operátora DIA-01:** custom build, secret scan a image invariants prošly.
První integrační běh skončil na health timeoutu kvůli chybějícím publikovaným portům.
Smoke-02 potvrdil opravu networkingu, běžící custom image a PASS kontroly existujících
kontejnerů; následně selhal HTTPS handshake kvůli chybějícímu DNS SNI v klientu.
Produkční NPM zůstal beze změny. Oprava SNI čeká na smoke-03; zde na Windows Docker není dostupný.

HTTPS klient nyní otevírá TCP výhradně na `127.0.0.1:18443` a před HTTP požadavkem
volá `SSLContext.wrap_socket(..., server_hostname="tls.smoke.dci.test")`.
Samostatný `SSLContext(PROTOCOL_TLS_CLIENT)` načte pouze konkrétní self-signed
`private/test-certificate.pem` z tohoto běhu, který byl nahrán do testovacího NPM.
`CERT_REQUIRED` a hostname verification zůstávají zapnuté; systémové trust store
ani globální SSL nastavení se nemění. Poté odešle `GET /smoke` s HTTP Host
`tls.smoke.dci.test` a ověří status 200 i přesný JSON backendu pro port 8080.
Stejný certifikát se ověřuje před restartem, po restartu i po rollbacku.
Viz [Python SSLContext](https://docs.python.org/3/library/ssl.html#ssl.SSLContext.wrap_socket).

## Jediný příkaz pro celý test

Použijte čistý zdrojový balíček tohoto projektu v samostatné složce, například
`/opt/dci-proxy-manager-source`, nikoli produkční adresář NPM. Potřeba je Docker
Engine, Compose v2, Buildx, Python 3.11+, OpenSSL a Gitleaks **8.24.2**. Skript
neinstaluje hostitelské balíčky a odmítá vzdálený Docker context. Předem ověřte
volné místo v Docker storage i testovacím adresáři; doporučeno alespoň 16 GiB.
Builder má limit 2 CPU / 4 GiB, NPM 1 CPU / 1 GiB, browser 1 CPU / 2 GiB.
Stále sdílejí prostředky hostu; zvolte dobu s dostatečnou rezervou, nebo jiný Docker host.

Ze zdrojového adresáře:

```bash
sudo python3 scripts/smoke.py \
  --workdir /var/tmp/dci-npm-smoke-01 \
  --gitleaks /usr/local/bin/gitleaks
```

Adresář `--workdir` **nesmí existovat**, nesmí být uvnitř zdrojového repo ani uvnitř
`/opt/nginx-proxy-manager` a nesmí být jejich nadřazenou cestou. Každý běh generuje
unikátní projekt `dci-npm-smoke-<random>` a unikátní image tag. Pro opakování zvolte
novou cestu, například `...-02`. Není nutný Node/npm na hostu.

| Služba | Publikovaný port |
| --- | --- |
| Testovací admin UI/API | `127.0.0.1:18081` → 81 |
| Testovací HTTP proxy | `127.0.0.1:18080` → 80 |
| Testovací HTTPS proxy | `127.0.0.1:18443` → 443 |

Povoleny jsou pouze uvedené porty; přepínače jiné hodnoty odmítnou. Porty musí být
volné (také ručně spuštěný `dci-npm-manual-test` je může blokovat). Test sám žádný
cizí kontejner nezastaví. Porty 80/81/443 na hostu se nikdy nepoužijí.
Generuje se blokový `compose.yaml` s explicitním `host_ip: 127.0.0.1`.
NPM má vlastní běžnou bridge síť `publishing` a interní síť `default`; backend je
pouze v interní síti a nepublikuje porty. Browser sdílí namespace testovacího NPM.
NPM/browser tak mohou mít odchozí konektivitu; nejde již o úplný zákaz egressu.
ACME issuance zůstává vypnuté a `IP_RANGES_FETCH_ENABLED=false` zachované.

Původní konfigurace připojovala NPM pouze k `internal: true`. Chování s prázdným
`NetworkSettings.Ports` odpovídá [hlášení Moby pro Engine 20.10](https://github.com/moby/moby/issues/44986).
Chyba parseru JSON nebyla prokázána. Samotné přejmenování souboru by tuto síťovou
chybu neřešilo. Po startu, deployi, restartu a rollbacku skript kontroluje skutečné
`HostConfig.PortBindings` i `NetworkSettings.Ports`, projektové labels a mounty
ještě před čekáním na backend health. Chybějící nebo wildcard binding ihned selže.

Pokud Gitleaks na hostu není, lze ho připravit bez instalace do systémových cest
do nového soukromého adresáře (oficiální release + checksum). Spusťte tento blok
v samostatném shellu a poté použijte vypsanou cestu místo `/usr/local/bin/gitleaks`:

```bash
set -euo pipefail
tools_dir="$(mktemp -d /var/tmp/dci-npm-tools.XXXXXX)"
cd "$tools_dir"
curl -fsSLO https://github.com/gitleaks/gitleaks/releases/download/v8.24.2/gitleaks_8.24.2_linux_x64.tar.gz
curl -fsSLO https://github.com/gitleaks/gitleaks/releases/download/v8.24.2/gitleaks_8.24.2_checksums.txt
sha256sum --ignore-missing --check gitleaks_8.24.2_checksums.txt
tar -xzf gitleaks_8.24.2_linux_x64.tar.gz gitleaks
printf '%s\n' "$tools_dir/gitleaks"
```

## Co skript skutečně provede při spuštění

1. Zkontroluje prostředí, porty a nové cesty. Pořídí pouze hashový inventář existujících
   kontejnerů pro pozdější porovnání konfigurace, stavu a časů startu.
2. Spustí Gitleaks na source allowlistu a připraví source ZIP. Stáhne stock NPM
   2.15.1 podle přesného digestu a ověří ID vůči snapshotu. Vytvoří vlastní omezený
   Buildx builder, sestaví custom image a samostatný připnutý Chromium runner.
3. Ověří prefix `RootFS.Layers` vůči stock image a shodu runtime nastavení.
   V uloženém image TAR prohlédne **všechny přidané vrstvy**: povolí pouze statický
   frontend a licenci. Odmítne zápisy do `/data`, `/etc/letsencrypt`, jiné backend
   soubory, DB, `.env`, privátní klíče, symlinky a whiteouty. Přidané soubory oskenuje.
4. Spustí stock NPM s novým `/data` a `/etc/letsencrypt`; prvním API setupem vytvoří
   náhodné testovací přihlašovací údaje. Ověří, že DB neobsahuje žádné proxy hosts.
5. Použije **skutečný `scripts/ops.py backup` a `deploy`** na testovací projekt.
   Produkční Compose ani žádné produkční volumes nevstupují do těchto příkazů.
6. V custom image ověří health/version/auth/API, založí testovací Access List a usera,
   vygeneruje lokální self-signed certifikát, provede SSL validate/create/upload API.
7. Chromium přes skutečnou login page otevře dashboard, Access Lists, Certificates,
   Users, Settings a Audit Logs. Přes UI vytvoří `smoke.dci.test`, změní port backendu
   z 8080 na 8081, zkontroluje všechny taby editoru a uložený WebSocket přepínač.
   Otevře Let's Encrypt HTTP/DNS a custom SSL dialogy, ale nevydá ACME certifikát.
8. Ověří `nginx -t`, vygenerovaný WebSocket config, HTTP odpověď skutečného backendu,
   WebSocket 101 handshake **i echo datového frame** a HTTPS s lokálním certifikátem.
   Zkontroluje auditní události created/updated.
9. Restartuje pouze testovací NPM. Porovná testovací hosty, users, Access Lists,
   certifikáty, Settings a markery v obou mountech. Znovu provede HTTP/HTTPS/WS.
10. Použije skutečný `ops.py rollback`. Ověří původní image ID a stock login HTML,
    přetrvání všech dat vytvořených **až po záloze** a znovu HTTP/HTTPS/WebSocket provoz.
11. Standardně zastaví a odstraní pouze kontejnery/síť vlastního testovacího projektu
    a vlastní builder. Neodstraňuje žádné datové adresáře, nepoužívá globální prune
    ani `down -v`. Ověří, že původní kontejnery nebyly restartované nebo změněné.

„Image nemění `/data` a `/etc/letsencrypt`“ znamená, že **build nepřidává žádné vrstvy
s jejich obsahem**. Běžící NPM do testovacího `/data` samozřejmě zapisuje DB a config;
jinak by nebylo možné ověřit persistenci. Produkční cesty se nemountují ani nekopírují.

## Výstupy a předání

- `<workdir>/report.json`: PASS/FAIL/NOT_RUN jednotlivých bran, přesný image ID,
  build manifest digest a explicitní `registry_digest: null` (nic se nepushuje).
- `<workdir>/failure.txt` a jednotlivé `*.log`: soukromá diagnostika případného selhání.
- `<workdir>/diagnostics/`: při integračním selhání nebo Ctrl+C, ještě před cleanupem,
  Compose ps, inspect vlastních testovacích kontejnerů, NetworkSettings.Ports a
  posledních 2000 řádků stdout/stderr logů app/backendu. Každý sběr má timeout;
  selhání jednoho příkazu neblokuje další. Tyto soubory nejsou součástí release.
- `<workdir>/existing-containers-check.json`: konkrétní změněná pole nebo chyby
  inspect. Kontrolují se pouze původní ID, nikoli dočasné kontejnery builderu/UI.
  Změna konfigurace/startu/stavu je FAIL; chyba čtení je NOT_VERIFIED, nikoli
  tvrzení o změně produkce. Obojí blokuje VERIFIED. Health probe data a pořadí
  mountů porovnání neovlivňují. Původní příčina tohoto FAIL není bez diagnostiky doložená.
- `<workdir>/private`, `data`, `letsencrypt`, `backup`: soukromá testovací data.
  Obsahují náhodná hesla/testovací klíče a **nikdy nesmějí do repa ani release**.
- `<workdir>/release/`: source ZIP, oskenovaný image TAR, version lock a report,
  plus SHA-256 souborů. Soubor **`VERIFIED` vznikne pouze po úspěchu všech bran**.
  Při chybě vznikne `NOT_VERIFIED`; balíček se nesmí publikovat.

Image tag je `diamondcrew-interactive/proxy-manager:2.15.1-dci.1.0.0-smoke-<random>`.
Finální release musí přetagovat **tento otestovaný image ID**, ne provádět nový build.
Hash image TAR, image ID a OCI/registry digest jsou různé identifikátory; report je
rozlišuje. Veřejný registry digest bude existovat teprve po budoucím pushi.

Pokud chcete testovací web po běhu prohlížet, přidejte `--keep-running`. Po úspěšném
rollback testu bude běžet stock NPM. Údaje jsou v soukromém `private/credentials.json`.
Pro zobrazení custom image znovu použijte `ops.py deploy` s **testovací** zálohou a
tagem z reportu. Otevření webu přes SSH tunel, bez úpravy produkční proxy:

```bash
ssh -L 18081:127.0.0.1:18081 uzivatel@DIA-01
```

Poté otevřete `http://127.0.0.1:18081`. Pro pozdější zastavení použijte přesnou
hodnotu `project` z reportu a jeho Compose soubor:

```bash
sudo docker compose -p dci-npm-smoke-HODNOTA_Z_REPORTU \
  -f /var/tmp/dci-npm-smoke-01/compose.yaml --profile test down --remove-orphans
```

## Lokální ověření přípravy

Python syntax check a **24 unit testů** prošly; generovaný YAML byl nezávisle
parsován a porovnán s původním datovým modelem. Detekce Playwright scénáře prošla dříve.
Zahrnují izolaci Compose, odmítnutí produkčních portů/cest, image ancestry/config,
kontrolu vrstev a lokální HTTP/WebSocket self-test pomocného backendu. Tento
self-test nepoužil NPM ani Docker a **nenahrazuje integrační výsledek**.
Čtyři nové regresní testy ověřují explicitní TCP loopback/SNI a skutečný lokální TLS
server, který odmítá chybějící SNI. Prověřují úspěšný handshake/Host/path/body,
odmítnutí důvěryhodného certifikátu s chybným hostname a nedůvěryhodného certifikátu
se správným hostname. Klíče vznikají pouze v dočasném adresáři a po testech se odstraní.

Skutečné Docker/rollback/persistence výsledky stále čekají na spuštění výše.
ACME issuance/renewal a DNS challenge se do internetu záměrně netestují; lokální
SSL API + custom HTTPS a Let's Encrypt dialogy jsou součástí připraveného smoke testu.

Docker dokumentace: [omezený samostatný builder](https://docs.docker.com/build/builders/drivers/docker-container/)
a [archivace image včetně vrstev](https://docs.docker.com/reference/cli/docker/image/save/).
