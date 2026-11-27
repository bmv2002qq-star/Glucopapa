"""Execute the pinned workflow's source and host steps in a new detached worktree."""
import argparse
import os
import subprocess
import tempfile
from pathlib import Path

import yaml

parser = argparse.ArgumentParser()
parser.add_argument("checkout", type=Path, help="repository containing the pinned commit")
parser.add_argument("worktree", type=Path, help="new worktree location")
args = parser.parse_args()
base = "d410dfabf1108e403eb12ccd7a9b564d78081502"
worktree = args.worktree.resolve()
subprocess.run(["git", "-C", str(args.checkout), "worktree", "add", "--detach", str(worktree), base], check=True)
workflow = worktree/".github/workflows/gfstorage-year-v11-qa.yml"
steps = yaml.safe_load(workflow.read_text())["jobs"]["q11-qa"]["steps"]
with tempfile.TemporaryDirectory(prefix="gfstorage-replay-") as tmp:
    env = dict(os.environ, GITHUB_WORKSPACE=str(worktree), RUNNER_TEMP=tmp)
    for i in [1,*range(4,57)]:
        if i == 29 or "run" not in steps[i]:
            continue
        print(f"{i} {steps[i]['name']}", flush=True)
        subprocess.run(["bash", "-ec", steps[i]["run"]], cwd=worktree, env=env, check=True)
