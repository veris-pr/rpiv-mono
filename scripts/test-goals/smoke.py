"""Exercise the installed Pi CLI against this checkout in an isolated offline profile."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
EXTENSION = HERE.parents[1] / "packages/rpiv-todo/index.ts"


class Pi:
    def __init__(self, profile):
        self.session = profile / "records/session.jsonl"
        self.session.parent.mkdir(exist_ok=True)
        self.events = []
        self.process = subprocess.Popen(
            ["pi", "--offline", "--mode", "rpc", "--session-dir", str(self.session.parent),
             "--session", str(self.session), "--no-extensions", "-e", str(EXTENSION),
             "-e", str(HERE / "provider.ts"), "--provider", "fixture", "--model", "test"],
            cwd=profile, env={**os.environ, "PI_CODING_AGENT_DIR": str(profile)},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        threading.Thread(target=self.read_events, daemon=True).start()

    def read_events(self):
        for line in self.process.stdout:
            self.events.append(json.loads(line))

    def send(self, message):
        self.process.stdin.write(json.dumps({"type": "prompt", "message": message}) + "\n")
        self.process.stdin.flush()

    def wait(self, matches):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.session.exists():
                # The process may still be appending the last line.
                lines = self.session.read_bytes().split(b"\n")[:-1]
                entries = map(json.loads, reversed(lines))
                latest = next((e["data"] for e in entries if e.get("customType") == "rpiv-todo-state"), None)
                if latest and matches(latest):
                    return latest
            time.sleep(0.05)
        raise AssertionError(f"Timed out waiting for goal state. Recent events: {self.events[-5:]}")

    def close(self):
        self.process.terminate()
        self.process.wait(timeout=5)


def check(profile):
    pi = Pi(profile)
    try:
        pi.send("seed-six")
        pi.wait(lambda s: len(s["tasks"]) == 6)
        pi.send("/goal complete todo items #2-#5")
        pi.wait(lambda s: s.get("goal", {}).get("question") == "Which fixture?")
        pi.send("Use local fixture")
        pi.wait(lambda s: s["goal"].get("answer") == "Use local fixture")
        pi.close()
        pi = Pi(profile)
        pi.send("/goal-resume")
        state = pi.wait(lambda s: s["goal"]["status"] == "completed")
        assert [t["status"] for t in state["tasks"]] == ["pending"] + ["completed"] * 4 + ["pending"]
        assert set(state["goal"]["evidence"]) == {"2", "3", "4", "5"}

        pi.send("/goal investigate fixture")
        pi.wait(lambda s: s["goal"].get("question") == "Which fixture?")
        pi.send("First fixture")
        pi.wait(lambda s: s["goal"].get("answer") == "First fixture")
        pi.send("/goal-resume")
        pi.wait(lambda s: s["goal"]["status"] == "completed" and len(s["tasks"]) == 7)
        pi.send("/goal pause on empty response")
        pi.wait(lambda s: s["goal"]["status"] == "paused" and "No observed work" in s["goal"]["reason"])
        pi.send("/goal-cancel")
        pi.wait(lambda s: s["goal"]["status"] == "cancelled")
        pi.send("/goal slow planning")
        pi.wait(lambda s: s["goal"]["status"] == "planning")
        pi.send("/goal-pause")
        pi.wait(lambda s: s["goal"].get("reason") == "Paused by user.")
        pi.send("/goal-resume")
        pi.wait(lambda s: s["goal"]["status"] == "planning")
        pi.close()
        pi = Pi(profile)
        pi.wait(lambda s: s["goal"]["status"] == "paused" and "Interrupted" in s["goal"]["reason"])
        pi.send("/goal-cancel")
        pi.wait(lambda s: s["goal"]["status"] == "cancelled")
        pi.send("/goal")
        state = pi.wait(lambda s: s["goal"]["status"] == "completed")
        assert set(state["goal"]["evidence"]) == {"1", "6"}
    finally:
        pi.close()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as directory:
        check(Path(directory))
    print("Passed range, restart, clarification, planning, no-progress pause, cancel and default goal.")
