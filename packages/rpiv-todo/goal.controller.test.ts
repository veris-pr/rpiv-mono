import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGoals } from "./goal.ts";
import { getState } from "./state/store.ts";
import { __resetState, registerTodoTool, TOOL_NAME } from "./todo.ts";

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	const goals = registerGoals(pi, async () => {});
	registerTodoTool(pi, goals.guard, goals.changed);
	const todo = captured.tools.get(TOOL_NAME);
	const step = captured.tools.get("goal_step");
	const goal = captured.commands.get("goal");
	const pause = captured.commands.get("goal-pause");
	const resume = captured.commands.get("goal-resume");
	const cancel = captured.commands.get("goal-cancel");
	const input = captured.events.get("input")?.[0];
	const beforeStart = captured.events.get("before_agent_start")?.[0];
	if (!todo || !step || !goal || !pause || !resume || !cancel || !input || !beforeStart) {
		throw new Error("Goal controller did not register its commands, tool and handlers.");
	}
	return { pi, captured, todo, step, goal, pause, resume, cancel, input, beforeStart };
}

async function callTodo(
	todo: ReturnType<typeof setup>["todo"],
	ctx: ReturnType<typeof createMockCtx>,
	params: Record<string, unknown>,
) {
	return todo.execute?.("todo-call", params as never, undefined as never, undefined as never, ctx as never);
}

beforeEach(() => {
	vi.useFakeTimers();
	__resetState();
});
afterEach(() => {
	vi.useRealTimers();
	__resetState();
});

describe("goal controller", () => {
	it("freezes a range and prevents the ordinary todo tool from completing its selected row", async () => {
		const { todo, goal } = setup();
		const ctx = createMockCtx({ hasUI: true });
		await callTodo(todo, ctx, { action: "create", subject: "first" });
		await callTodo(todo, ctx, { action: "create", subject: "second" });

		await goal.handler("complete todo item #1", ctx as never);
		const direct = await callTodo(todo, ctx, { action: "update", id: 1, status: "completed" });

		expect(direct?.content[0]).toMatchObject({ text: expect.stringContaining("Use goal_step") });
		expect(getState("test-session").tasks[0].status).toBe("in_progress");
		expect(getState("test-session").tasks[1].status).toBe("pending");
	});

	it("keeps a question and answer through resume, then permits verified completion", async () => {
		const { pi, captured, todo, step, goal, resume, input, beforeStart } = setup();
		const ctx = createMockCtx({ hasUI: true });
		(ctx as unknown as { hasPendingMessages: () => boolean }).hasPendingMessages = () => false;
		await callTodo(todo, ctx, { action: "create", subject: "first" });
		await goal.handler("complete todo item #1", ctx as never);

		await vi.runOnlyPendingTimersAsync();
		const event = { prompt: vi.mocked(pi.sendUserMessage).mock.calls[0][0], systemPrompt: "base" };
		await beforeStart(event as never, ctx as never);
		await step.execute?.(
			"goal-call",
			{ action: "ask", message: "Which target?" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		await input({ source: "interactive", text: "The staging target." } as never, ctx as never);
		await resume.handler("", ctx as never);

		const resumed = captured.entries.at(-1)?.data as { goal?: { answer?: string; status?: string } };
		expect(resumed.goal).toMatchObject({ answer: "The staging target.", status: "running" });
		await vi.runOnlyPendingTimersAsync();
		const resumeEvent = { prompt: vi.mocked(pi.sendUserMessage).mock.calls[1][0], systemPrompt: "base" };
		await beforeStart(resumeEvent as never, ctx as never);
		await step.execute?.(
			"goal-call",
			{ action: "complete", id: 1, check: "Checked the target", result: "Staging is selected." } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);

		const completed = captured.entries.at(-1)?.data as {
			goal?: { evidence?: Record<string, { check: string }>; status?: string };
		};
		expect(completed.goal).toMatchObject({ status: "completed", evidence: { 1: { check: "Checked the target" } } });
	});

	it("pauses a running goal without changing its current row", async () => {
		const { todo, goal, pause } = setup();
		const ctx = createMockCtx({ hasUI: true });
		await callTodo(todo, ctx, { action: "create", subject: "first" });
		await goal.handler("complete todo item #1", ctx as never);
		await pause.handler("", ctx as never);

		expect(getState("test-session").tasks[0].status).toBe("in_progress");
		const notified = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notified).toHaveBeenLastCalledWith(expect.stringContaining("Paused by user."), "info");
	});

	it("releases the current row when cancellation ends a goal", async () => {
		const { todo, goal, cancel } = setup();
		const ctx = createMockCtx({ hasUI: true });
		await callTodo(todo, ctx, { action: "create", subject: "first" });
		await goal.handler("complete todo item #1", ctx as never);
		await cancel.handler("", ctx as never);

		expect(getState("test-session").tasks[0].status).toBe("pending");
	});
});
