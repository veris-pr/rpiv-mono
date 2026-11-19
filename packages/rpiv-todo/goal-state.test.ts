import { describe, expect, it } from "vitest";
import { GoalChange, parseScope } from "./goal-state.ts";
import { applyTaskMutation } from "./state/state-reducer.ts";

function draft() {
	return new GoalChange(
		{ tasks: [], nextId: 1 },
		{
			version: 1,
			session: "test",
			id: "run",
			scope: "Verify output",
			phase: "planning",
			status: "planning",
			selected: [],
			evidence: {},
		},
	);
}
const first = { subject: "Build", description: "Build project", criteria: "Build exits zero" };
const second = { subject: "Inspect", description: "Inspect output", criteria: "Output matches", prerequisites: [1] };

describe("goal selection", () => {
	it("distinguishes objectives, the whole list, a single row and a range", () => {
		expect(parseScope("  ")).toEqual({ kind: "all" });
		expect(parseScope("complete todo item #2")).toEqual({ kind: "ids", first: 2, last: 2 });
		expect(parseScope("complete todo items #2-#5")).toEqual({ kind: "ids", first: 2, last: 5 });
		expect(parseScope("investigate the report")).toEqual({ kind: "objective" });
	});
	it.each(["complete todo item #0", "complete todo items #5-2", "complete todo item #x"])("rejects %s", (s) => {
		expect(() => parseScope(s)).toThrow();
	});
});
describe("goal transitions", () => {
	it("commits evidence for the selected row and leaves later additions pending", () => {
		const c = draft();
		c.plan([first, second]);
		c.state = applyTaskMutation(c.state, "create", { subject: "Outside scope" }).state;
		expect(() => c.complete(2, "check", "pass")).toThrow();
		expect(() => c.complete(1, "build", "")).toThrow();
		c.complete(1, "build", "exit 0");
		expect(c.goal.current).toBe(2);
		c.complete(2, "inspect", "matched");
		expect(c.goal.status).toBe("completed");
		expect(c.goal.evidence[1]).toEqual({ check: "build", result: "exit 0" });
		expect(c.state.tasks[2].status).toBe("pending");
	});
	it("pauses on an external prerequisite and resumes when it completes", () => {
		const c = draft();
		c.plan([first, second]);
		c.goal.selected.shift();
		c.advance();
		expect(c.goal.status).toBe("paused");
		c.state = applyTaskMutation(c.state, "update", { id: 1, status: "completed" }).state;
		c.advance();
		expect(c.goal.current).toBe(2);
	});
	it("detects clear and ID reuse, and cancellation leaves the replacement alone", () => {
		const c = draft();
		c.plan([first]);
		c.state = applyTaskMutation(c.state, "clear", {}).state;
		c.state = applyTaskMutation(c.state, "create", { subject: "Replacement" }).state;
		c.advance();
		expect(c.goal.status).toBe("paused");
		expect(() => c.complete(1, "check", "pass")).toThrow();
		c.release();
		expect(c.state.tasks[0].status).toBe("pending");
	});
});
