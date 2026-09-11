import { mkdirSync, writeFileSync, renameSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { check, validDiscord, readLinks } from './core.mjs';
export async function manageLinks(args, path, getUser) {
  const [scope, action, first, second, ...extra] = args;
  const discord = action === 'link' ? second : first;
  const target = action === 'link' ? first : second;
  check(scope === 'sso' && ['link', 'unlink', 'list', 'show'].includes(action) && extra.length === 0);
  if (action === 'list') { check(discord === undefined); return readLinks(path); }
  check(validDiscord(discord));
  if (action === 'show') { check(target === undefined); return { discord, user_id: readLinks(path)[discord] ?? null }; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + '.lock'; mkdirSync(lock, { mode: 0o700 });
  try {
    const links = readLinks(path);
    if (action === 'link') {
      check(typeof target === 'string' && /^[1-9][0-9]*$/.test(target));
      const id = Number(target); check(Number.isSafeInteger(id));
      const user = await getUser(id); check(user && !user.is_deleted && !user.is_disabled);
      check(links[discord] === undefined || links[discord] === id);
      links[discord] = id;
    } else { check(target === undefined); delete links[discord]; }
    writeFileSync(path + '.new', JSON.stringify(links, null, 2) + '\n', { mode: 0o600 });
    renameSync(path + '.new', path);
    return { discord, user_id: links[discord] ?? null };
  } finally { rmdirSync(lock); }
}
