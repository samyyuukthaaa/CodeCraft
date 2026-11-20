# Flask test fixture

The organizers require pallets/flask release tag **3.1.3**, commit **22d92470** (`22d924701a6ae2e4cd01e9a15bbaf3946094af65`, "release version 3.1.3", 2026-02-18). It lives in `fixtures/flask`, which is gitignored: CodeCraft never commits Flask's code. Flask is distributed under its own license (`fixtures/flask/LICENSE.txt`, BSD-3-Clause, Copyright 2010 Pallets), which is kept unmodified.

## Set up (reproducible)
```
git clone --depth 1 https://github.com/pallets/flask fixtures/flask
git -C fixtures/flask fetch --depth 1 origin tag 3.1.3
git -C fixtures/flask checkout --detach "3.1.3^{commit}"
git -C fixtures/flask rev-parse HEAD        # must print 22d924701a6ae2e4cd01e9a15bbaf3946094af65
py -3.12 -m venv fixtures/flask/.venv
fixtures/flask/.venv/Scripts/python -m pip install pytest==9.0.2 click==8.3.1 greenlet==3.3.1 iniconfig==2.3.0 asgiref==3.11.0 python-dotenv==1.2.1 werkzeug==3.1.5 jinja2==3.1.6 itsdangerous==2.2.0 markupsafe==3.0.3 blinker==1.9.0 colorama==0.4.6 pluggy==1.6.0 packaging==26.0 pygments==2.19.2
fixtures/flask/.venv/Scripts/python -m pip install --no-deps -e fixtures/flask
```
The pinned versions are the ones the 3.1.3 release's own `uv.lock` resolves for Python 3.12 (runtime dependencies plus the `tests` dependency group).

## Baseline (measured 2026-11-20, Windows 11, Python 3.12.10)
- `pytest -q` from `D:\CodeCraft\fixtures\flask`: **490 passed, 0 failed**.

## Two environment pitfalls found (not Flask bugs)
1. **Unpinned pytest breaks collection.** With pytest 9.2.0, `tests/test_cli.py` fails to import: `ImportError: cannot import name 'notset' from '_pytest.monkeypatch'` (the test uses a private pytest name). The release's locked `pytest==9.0.2` works. Fix: use the locked versions above; the tests are not modified.
2. **Drive-letter case on Windows.** Run from a working directory spelled `d:\...` (lowercase), 7 tests in `tests/test_cli.py` fail (`test_prepare_import[...]` x6, `test_run_cert_path`) because they compare `d:\...` with the resolved `D:\...`. From the canonical `D:\...` path all 490 pass. The scenario runner therefore starts Python with `cwd` set to `fs.realpathSync.native(...)`.
