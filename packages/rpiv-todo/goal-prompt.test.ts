import { describe, expect, it } from "vitest";
import { buildGoalInstructions } from "./goal-prompt.ts";
import { GoalChange } from "./goal-state.ts";

function draft() {
	return new GoalChange(
		{ tasks: [], nextId: 1 },
		{
			version: 1,
			id: "run",
			session: "test",
			scope: "Deliver report",
			phase: "planning",
			status: "planning",
			selected: [],
			evidence: {},
		},
	);
}

describe("adaptive goal prompts", () => {
	it("reads older snapshots and preserves their finding when adding progress", () => {
		const c = draft();
		c.goal.finding = "Reports require a cursor";
		c.record({ kind: "progress", message: "Located the client" });
		expect(buildGoalInstructions(c.state, c.goal)).toContain("Reports require a cursor");
		expect(c.goal.updates).toHaveLength(2);
	});

	it("retains distinct findings and failures, rejects duplicates and carries verified work forward", () => {
		const c = draft();
		c.plan([
			{ subject: "Build", description: "Build client", criteria: "Build exits zero" },
			{ subject: "Verify", description: "Run client", criteria: "Report matches" },
		]);
		const failure = {
			kind: "failure" as const,
			approach: "Offset query",
			message: "Offset rejected",
			next: "Use cursor",
		};
		expect(c.record(failure)).toBe(true);
		expect(c.record(failure)).toBe(false);
		c.record({ kind: "finding", message: "Server requires a cursor" });
		c.record({ kind: "finding", message: "Cursor comes from headers" });
		c.complete(1, "build", "exit 0");
		const prompt = buildGoalInstructions(c.state, c.goal);
		for (const value of [
			"Server requires a cursor",
			"Cursor comes from headers",
			"Offset rejected",
			"exit 0",
			"Report matches",
		])
			expect(prompt).toContain(value);
		expect(prompt).not.toContain("latest proposed next step");
	});

	it("replaces a stale proposed next step when a later tool fails", () => {
		const c = draft();
		c.record({ kind: "progress", message: "Query ready", next: "Deploy query" });
		c.record({ kind: "failure", approach: "bash", message: "Query rejected" });
		const prompt = buildGoalInstructions(c.state, c.goal);
		expect(prompt).toContain("Revise the approach");
		expect(prompt).not.toContain("latest proposed next step");
	});
});
