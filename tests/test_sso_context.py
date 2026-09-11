"""Regression guards for the effective root Docker context, including legacy builders."""
from pathlib import Path
import shlex
import unittest

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {
    'sso/prepare.mjs', 'sso/SSOLogin.tsx', 'sso/core.mjs', 'sso/router.mjs',
    'sso/routes.mjs', 'sso/links.mjs', 'sso/cli.mjs', 'sso/upstream-guards.json',
    'sso/dci-proxymanager',
}

class SSOContextTests(unittest.TestCase):
    def test_root_allowlist_exposes_all_explicit_sso_copy_sources(self):
        rules = (ROOT / '.dockerignore').read_text().splitlines()
        sources = set()
        for line in (ROOT / 'sso/Dockerfile').read_text().splitlines():
            fields = shlex.split(line)
            if fields and fields[0] == 'COPY' and not fields[1].startswith('--from='):
                for source in fields[1:-1]:
                    self.assertNotEqual(source, 'sso', 'Do not silently COPY an empty filtered SSO directory')
                    if source.startswith('sso/'):
                        sources.add(source)
                        self.assertTrue((ROOT / source).is_file(), source)
                        self.assertIn('!' + source, rules, source + ' must be allowed by root ignore rules')
        self.assertEqual(sources, REQUIRED)
        self.assertFalse((ROOT / 'sso/Dockerfile.dockerignore').exists(), 'Use one effective root allowlist on old and new Docker')

    def test_context_target_checks_sources_before_expensive_upstream_prepare(self):
        source = (ROOT / 'sso/Dockerfile').read_text()
        context, frontend = source.split('FROM context-check AS frontend', 1)
        self.assertIn(' AS context-check', context)
        self.assertIn('node --check /work/sso/prepare.mjs', context)
        self.assertNotIn('RUN node scripts/prepare.mjs', context)
        self.assertIn('RUN node scripts/prepare.mjs', frontend)
        for required in REQUIRED:
            self.assertIn(required, context)

    def test_sso_context_remains_a_runtime_file_allowlist(self):
        rules = (ROOT / '.dockerignore').read_text().splitlines()
        self.assertEqual(rules[0], '**')
        self.assertEqual({rule[1:] for rule in rules if rule.startswith('!sso/') and rule != '!sso/'}, REQUIRED)
        for deny in ('**/.env*', '**/*.pem', '**/*.key', '**/*.db', '**/*.sqlite*'):
            self.assertIn(deny, rules)
            self.assertGreater(rules.index(deny), max(rules.index('!' + path) for path in REQUIRED))

if __name__ == '__main__':
    unittest.main()
