import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const [mode, target] = process.argv.slice(2);
function replace(file, before, after) {
  const path = join(target, file); let text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  if (text.split(before).length !== 2) throw Error('Upstream patch mismatch: ' + file);
  writeFileSync(path, text.replace(before, after));
}
if (mode === 'frontend') {
  copyFileSync(join(import.meta.dirname, 'SSOLogin.tsx'), join(target, 'src/diamondcrew/SSOLogin.tsx'));
  replace('index.html', '<head>', '<head>\n<meta name="referrer" content="no-referrer" />');
  replace('src/pages/Login/index.tsx', 'import { Field, Form, Formik }', 'import SSOLogin from "src/diamondcrew/SSOLogin";\nimport { Field, Form, Formik }');
  replace('src/pages/Login/index.tsx', '\t\t\t<Formik\n', '\t\t\t<SSOLogin />\n\t\t\t<Formik\n');
  replace('src/Router.tsx', 'import { lazy, Suspense }', 'import SSOLogin from "src/diamondcrew/SSOLogin";\nimport { lazy, Suspense }');
  replace('src/Router.tsx', '\tif (!authenticated) {', '\tif (window.location.pathname === "/auth/sso/callback") return <SSOLogin />;\n\n\tif (!authenticated) {');
} else if (mode === 'backend') {
  const source = readFileSync(join(target, 'app.js'), 'utf8').replaceAll('\r\n', '\n');
  const guards = JSON.parse(readFileSync(join(import.meta.dirname, 'upstream-guards.json'), 'utf8'));
  if (createHash('sha256').update(source).digest('hex') !== guards['backend/app.js']) throw Error('Backend upstream checksum mismatch');
  replace('app.js', 'import bodyParser', 'import dciSSO from "./dci-sso/routes.mjs";\nimport bodyParser');
  replace('app.js', 'app.use("/", mainRoutes);', 'app.use("/sso", dciSSO);\napp.use("/", mainRoutes);');
} else throw Error('Expected frontend/backend and target directory');
