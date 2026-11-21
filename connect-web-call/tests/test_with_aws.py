import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


WRAPPER = Path(__file__).resolve().parents[1] / 'bin/with-aws'


class CredentialBoundary(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.dotenv = self.root / '.env'
        self.dotenv.write_text('AWS_ACCESS_KEY_ID=host\nAWS_SECRET_ACCESS_KEY=host-secret\n'
                               'AWS_ACCESS_KEY_ID_CONNECT_CUSTOMER = connect\n'
                               'AWS_SECRET_ACCESS_KEY_CONNECT_CUSTOMER = connect-secret\n'
                               'CLOUNDFLARE_API_TOKEN=test-dns\nUNRELATED=$(touch SENTINEL)\n')
        aws = self.root / 'aws'
        aws.write_text('#!/usr/bin/env python3\nimport os, sys\n'
                       'from configparser import RawConfigParser\n'
                       'assert sys.argv[1:3] == ["sts", "get-caller-identity"]\n'
                       'key = os.getenv("AWS_ACCESS_KEY_ID")\n'
                       'if not key:\n'
                       ' c = RawConfigParser(); c.read(os.environ["AWS_SHARED_CREDENTIALS_FILE"])\n'
                       ' key = c[os.environ["AWS_PROFILE"]]["aws_access_key_id"]\n'
                       'print({"host":"157264476192", "connect":"086971655102"}.get(key, "000000000000"))\n')
        aws.chmod(0o700)
        self.env = dict(os.environ, PATH=str(self.root) + ':' + os.environ['PATH'],
                        ENV_FILE=str(self.dotenv), AWS_PROFILE='unrelated',
                        AWS_ACCESS_KEY_ID='ambient', AWS_SESSION_TOKEN='stale',
                        AWS_ENDPOINT_URL='https://invalid.example', TF_CLI_ARGS_apply='-auto-approve')

    def invoke(self, scope, script):
        return subprocess.run([sys.executable, str(WRAPPER), scope, sys.executable, '-c', script],
                              env=self.env, cwd=self.root, capture_output=True, text=True)

    def test_hosting_has_no_connect_credentials_or_ambient_overrides(self):
        r = self.invoke('hosting', 'import os; e=os.environ; assert e["AWS_ACCESS_KEY_ID"] == "host"; '
                        'assert e["CLOUDFLARE_API_TOKEN"] == "test-dns"; assert e["ENV_FILE"]=="/dev/null"; '
                        'assert not any(k in e for k in ["AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_ENDPOINT_URL", '
                        '"UNRELATED", "TF_CLI_ARGS_apply", "AWS_SECRET_ACCESS_KEY_CONNECT_CUSTOMER"])')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse((self.root / 'SENTINEL').exists())

    def test_profiles_are_distinct_and_removed_after_command(self):
        r = self.invoke('infra', 'import os, configparser, pathlib; e=os.environ; '
                        'assert "AWS_ACCESS_KEY_ID" not in e and "CLOUDFLARE_API_TOKEN" not in e; '
                        'p=pathlib.Path(e["AWS_SHARED_CREDENTIALS_FILE"]); assert p.stat().st_mode & 0o077 == 0; '
                        'c=configparser.RawConfigParser(); c.read(p); '
                        'assert c["poc-connect"]["aws_secret_access_key"] == "connect-secret"; '
                        'assert c["poc-hosting"]["aws_access_key_id"] == "host"; print(p)')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(Path(r.stdout.strip()).exists())

    def test_connect_cannot_receive_hosting_or_dns_credentials(self):
        r = self.invoke('connect', 'import os; e=os.environ; assert e["AWS_ACCESS_KEY_ID"] == "connect"; '
                        'assert "CLOUDFLARE_API_TOKEN" not in e and "AWS_PROFILE" not in e')
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_wrong_hosting_account_cannot_run_command(self):
        self.dotenv.write_text(self.dotenv.read_text().replace('ID=host\n', 'ID=connect\n'))
        r = self.invoke('hosting', 'from pathlib import Path; Path("ran").touch()')
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.root / 'ran').exists())

    def test_termination_removes_profile_file(self):
        import selectors
        cmd = 'import os,signal;print(os.environ["AWS_SHARED_CREDENTIALS_FILE"],flush=True);signal.pause()'
        with subprocess.Popen([sys.executable, str(WRAPPER), 'infra', sys.executable, '-c', cmd],
                              cwd=self.root, env=self.env, stdout=subprocess.PIPE, text=True,
                              start_new_session=True) as proc:
            try:
                with selectors.DefaultSelector() as sel:
                    sel.register(proc.stdout, selectors.EVENT_READ)
                    self.assertTrue(sel.select(10), 'child did not start')
                path = Path(proc.stdout.readline().strip())
                self.assertTrue(path.is_file())
                proc.terminate()
                proc.wait(timeout=10)
                self.assertFalse(path.exists())
            finally:
                import signal
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_wrong_connect_account_cannot_run_command(self):
        self.dotenv.write_text(self.dotenv.read_text().replace(' = connect\n', ' = host\n'))
        r = self.invoke('infra', 'from pathlib import Path; Path("ran").touch()')
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.root / 'ran').exists())
        self.assertNotIn('connect-secret', r.stdout + r.stderr)


if __name__ == '__main__':
    unittest.main()
