# Fixed tasks (pallets/flask)

Source: the organizers' PDF, as provided by the project owner on 2026-11-20. Copied word for word, including the verification steps.

Target repository: pallets/flask release tag 3.1.3, commit 22d92470 (checked out at `fixtures/flask`).

## Task A
Open src/flask/helpers.py, select the function get_debug_flag, and instruct: "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false." Review and accept the diff. Verify: FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())" shows False.

## Task B
In the agent panel, with no files mentioned, instruct: "Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands." Review the hunks and accept. Show the TrueForge session for this run. Verify: pytest tests/test_cli.py -q passes, then run the new command against any Flask app and show the masked JSON; the diff must touch at least three files.

## Task C
Configure TrueForge with an unreachable endpoint or an invalid key, then repeat Task A. Verify: the editor stays responsive, the user sees a clear message or a second configured model takes over automatically, and git status shows no files changed.
