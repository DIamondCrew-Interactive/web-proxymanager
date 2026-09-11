# Update a kompatibilita

Motiv je svázaný s NPM 2.15.1 a konkrétním upstream commitem. Pro další upstream:

1. V samostatném checkoutu ověřit tag, commit, release notes, backend verzi a registry
   digest nové verze. Zdokumentovat případné DB migrace a možnosti downgrade.
2. Upravit `upstream.lock.json` a oba digesty v Dockerfile. Aktualizovat verzi motivu.
3. Porovnat každý z jedenácti patchovaných souborů. Znovu zkontrolovat SHA-256 a
   kontext patchů; automatické selhání není důvod vypnout kontrolu hashů.
4. Prověřit třídy Tabler, Bootstrap modaly/tabs, React Select, router a theme context.
   Vyzkoušet přístupnost, klávesnici, dlouhé domény, mobilní viewport i světlý režim.
5. Zkontrolovat read-only dashboard dotazy a oprávnění. Vyhodnotit přidanou zátěž
   načtení seznamů hostů/certifikátů u velkých instalací; nepředpokládat stránkování,
   které upstream API neposkytuje.
6. Použít nový upstream lockfile bez svévolného dependency upgradu. Build, lint,
   upstream Vitest, Playwright, integrity a secret scan musí znovu projít.
7. Na izolované kopii persistentních dat ověřit engine, ACME staging, WebSockets
   a celý checklist. Kopie nesmí spustit produkční ACME obnovy či veřejný provoz.
8. Připravit nový backup současného stavu a otestovat rollback. `ops.py` je záměrně
   striktní pro první nasazení ze zachyceného stock image ID; pro budoucí verzi se
   musí aktualizovat po auditu. Nepřeskakovat ochranu proti jinému image.

CSS není univerzální přes všechny verze. Upstream změna struktury menu/modalu může
porušit layout, přístupnost či viditelnost ovládání. Rebuild stejného commitu může
změnit hashe assetů při změně toolchainu; proto je připnutý i builder a Yarn lock.
Registry digest a zdrojový commit pinují různá data a oba se musí zkontrolovat.

Pro změnu pouze motivu na 2.15.1 je rollback image-only. Downgrade po budoucí
upstream DB migraci může vyžadovat konzistentní obnovu DB i ostatních dat; postup
pro reskin takový downgrade negarantuje. Neukládat žádné produkční zálohy do repo.

Hlavní bundle upstream aplikace je velký (přibližně 2.4 MB minifikovaný). Tento reskin
nemění jeho lazy-loading nebo vnitřní dependency architekturu. Vite upozornění na
velikost chunku je zdokumentováno, nikoli umlčeno zvýšením limitu.
