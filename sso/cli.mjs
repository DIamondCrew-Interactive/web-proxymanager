import userModel from '../models/user.js';
import db from '../db.js';
import { manageLinks } from './links.mjs';
try {
  if (process.getuid?.() !== 0) throw Error('Run through docker exec as container root');
  console.log(JSON.stringify(await manageLinks(process.argv.slice(2), '/data/dci-sso/links.json', id => userModel.query().findById(id)), null, 2));
} catch { console.error('Operation refused. Usage: dci-proxymanager sso link NPMuserID DiscordID | unlink DiscordID | list | show DiscordID'); process.exitCode = 1; }
finally { await db().destroy(); }
