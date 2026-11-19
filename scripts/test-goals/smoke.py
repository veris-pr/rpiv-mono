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
        assert any(update["message"] == "Fixture reports use cursors." for update in state["goal"]["updates"])
        assert any(update["message"] == "Cursor parsing implemented." for update in state["goal"]["updates"])
        assert any(update.get("next") == "Read the cursor from response headers." for update in state["goal"]["updates"])
        entries = [json.loads(line) for line in pi.session.read_text().splitlines()]
        turns = [entry for entry in entries if entry.get("type") == "custom_message" and entry.get("customType") == "rpiv-goal-turn"]
        assert turns and any(turn["content"] == "Working on todo #3 — Row 3" for turn in turns)
        assert all("[rpiv-goal turn" not in str(turn["content"]) for turn in turns)

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
        pi.send("/goal cache recovery")
        state = pi.wait(lambda s: s["goal"].get("question") == "Which fixture?")
        assert any("Probe failed" in update["message"] for update in state["goal"]["updates"])
        recovery_entries = [json.loads(line) for line in pi.session.read_text().splitlines()]
        assert sum(entry.get("content") == "Planning — cache recovery" for entry in recovery_entries) == 1
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
        requests = [json.loads(line) for line in (profile / "prompt-audit.jsonl").read_text().splitlines()]
        assert len(requests) > 10
        for request_index, (previous, current) in enumerate(zip(requests, requests[1:])):
            assert current["systemPrompt"] == previous["systemPrompt"], "System prompt changed between requests"
            # Pi recreates custom-message timestamps from session-entry timestamps
            # on replay. Providers serialize the role/content/tool fields.
            prior_messages = [{key: value for key, value in message.items() if key != "timestamp"} for message in previous["messages"]]
            prefix = [{key: value for key, value in message.items() if key != "timestamp"} for message in current["messages"][:len(prior_messages)]]
            if prefix != prior_messages:
                mismatch = next((index for index, pair in enumerate(zip(prior_messages, prefix)) if pair[0] != pair[1]), len(prefix))
                raise AssertionError(f"Request {request_index + 1} changed message {mismatch}: {prior_messages[mismatch:mismatch+1]} -> {prefix[mismatch:mismatch+1]}")
    finally:
        pi.close()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as directory:
        check(Path(directory))
    print("Passed range, restart, adaptive recovery, clarification, cancellation and append-only request prefixes.")
