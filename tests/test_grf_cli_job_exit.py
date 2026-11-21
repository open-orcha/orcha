"""Exercise the released GRF CLI's real managed-child exit path when available.

The admission transport is stubbed because the project suite is offline; the
released CLI parser, action validation, run_managed child launch and exit status
propagation run unchanged.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys

import pytest

GRF_ROOT = Path('/grf-release')
GRF_CLIENT = GRF_ROOT / 'grf_client.py'
pytestmark = pytest.mark.skipif(
    os.name != 'posix' or not GRF_CLIENT.is_file(),
    reason='requires the isolated Linux sandbox and its read-only GRF release',
)


def test_released_grf_cli_propagates_failed_and_corrected_child_exit(tmp_path, monkeypatch):
    sys.path.insert(0, str(GRF_ROOT))
    spec = importlib.util.spec_from_file_location('grf_client_under_test', GRF_CLIENT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    class LocalAdmission:
        def __init__(self, config):
            self.config = config

        def admit(self, action):
            assert action['scope'] == 'orcha-task-acceptance'

    monkeypatch.setattr(module, 'Client', LocalAdmission)
    action_file = tmp_path / 'acceptance.grf'
    config_file = tmp_path / 'enrollment.json'
    ca_file, cert_file, key_file = (tmp_path / name for name in ('ca.pem', 'client.pem', 'client.key'))
    for path in (ca_file, cert_file, key_file):
        path.write_text('offline fixture; admission transport is replaced', encoding='utf-8')
    config_file.write_text(json.dumps({
        'host': 'localhost', 'port': 443,
        'ca': str(ca_file), 'cert': str(cert_file), 'key': str(key_file),
        'project': 'public-test', 'policy': 'public-1',
    }), encoding='utf-8')

    def run_child(exit_code):
        action = {
            'argv': [sys.executable, '-c', f'import sys; sys.exit({exit_code})'],
            'cwd': str(tmp_path), 'scope': 'orcha-task-acceptance', 'identity': 'isolated-test',
        }
        document = tmp_path / f'action-{exit_code}.grf'
        document.write_text(
            '```grf:context id="downstream-example"\n'
            + json.dumps({'format': 'grf.downstream-preview/v1', 'action': action})
            + '\n```\n',
            encoding='utf-8',
        )
        monkeypatch.setattr(sys, 'argv', ['grf_client.py', str(document), '--config', str(config_file)])
        return module.main()

    assert run_child(17) == 17
    assert run_child(0) == 0
