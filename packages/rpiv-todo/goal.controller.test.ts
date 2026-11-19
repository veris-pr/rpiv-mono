import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGoals } from "./goal.ts";
import { getState, replaceState } from "./state/store.ts";
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

function goalMessages(pi: ReturnType<typeof createMockPi>["pi"]) {
	return vi.mocked(pi.sendMessage).mock.calls.filter(([message]) => message.customType === "rpiv-goal-turn");
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
		const message = goalMessages(pi)[0][0];
		expect(message.content).toBe("Working on todo #1 — first");
		expect(message.display).toBe(true);
		const renderer = vi.mocked(pi.registerMessageRenderer).mock.calls[0][1];
		const component = renderer(
			{ ...message, role: "custom", timestamp: 0 },
			{
				expanded: false,
				outputPad: 0,
				keyText: () => "",
				keyHint: (_key, description) => description,
			},
			{
				fg: (_color: string, value: string) => value,
			} as never,
		);
		expect(component?.render(80).join("\n")).toContain("Working on todo #1 — first");
		expect(component?.render(80).join("\n")).not.toContain("rpiv-goal-turn");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		const event = { message, systemPrompt: "base" };
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
		const resumeEvent = { message: goalMessages(pi)[1][0], systemPrompt: "base" };
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

	it("keeps instructions in model context and rejects a dispatched message after pause", async () => {
		const { pi, todo, goal, pause, beforeStart } = setup();
		const ctx = { ...createMockCtx(), hasPendingMessages: () => false, abort: vi.fn() };
		await callTodo(todo, ctx, { action: "create", subject: "Build\n\u001b[31mreport" });
		await goal.handler("complete todo item #1", ctx as never);
		await vi.runOnlyPendingTimersAsync();
		const message = goalMessages(pi)[0][0];
		expect(message.content).toBe("Working on todo #1 — Build report");
		expect(vi.mocked(pi.sendMessage).mock.calls[0][0]).toMatchObject({
			display: false,
			content: expect.stringContaining("Use goal_step"),
		});
		expect(message.content).not.toContain("Use goal_step");
		await pause.handler("", ctx as never);
		await beforeStart({ message, systemPrompt: "base" }, ctx);
		expect(ctx.abort).toHaveBeenCalled();
	});

	it("labels planning turns with the objective", async () => {
		const { pi, goal } = setup();
		const ctx = { ...createMockCtx(), hasPendingMessages: () => false };
		await goal.handler("Investigate report", ctx as never);
		await vi.runOnlyPendingTimersAsync();
		expect(goalMessages(pi)[0][0].content).toBe("Planning — Investigate report");
	});

	it("reconciles current status immediately before dispatch", async () => {
		const { pi, todo, goal } = setup();
		const ctx = { ...createMockCtx(), hasPendingMessages: () => false };
		await callTodo(todo, ctx, { action: "create", subject: "first" });
		await callTodo(todo, ctx, { action: "create", subject: "second" });
		await goal.handler("", ctx as never);
		const state = structuredClone(getState("test-session"));
		state.tasks[0].status = "completed";
		replaceState("test-session", state);
		await vi.runOnlyPendingTimersAsync();
		expect(goalMessages(pi)[0][0].content).toBe("Working on todo #2 — second");
	});

	it("pauses before dispatch when a selected row was replaced", async () => {
		const { pi, todo, goal, captured } = setup();
		const ctx = { ...createMockCtx(), hasPendingMessages: () => false };
		await callTodo(todo, ctx, { action: "create", subject: "first" });
		await goal.handler("", ctx as never);
		replaceState("test-session", { tasks: [{ id: 1, subject: "replacement", status: "pending" }], nextId: 2 });
		await vi.runOnlyPendingTimersAsync();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(captured.entries.at(-1)?.data).toMatchObject({ goal: { status: "paused" } });
	});

	it("refines the next prompt using persisted findings, progress and a revised failed approach", async () => {
		const { pi, todo, goal, step, captured } = setup();
		const ctx = { ...createMockCtx(), hasPendingMessages: () => false };
		await callTodo(todo, ctx, { action: "create", subject: "first" });
		await goal.handler("", ctx as never);
		await vi.runOnlyPendingTimersAsync();
		for (const params of [
			{ action: "finding", message: "The API requires a cursor." },
			{ action: "progress", message: "The parser is implemented.", next: "Verify cursor handling." },
			{
				action: "failure",
				approach: "Use offset pagination",
				result: "Offset is rejected.",
				next: "Use the cursor returned by the API.",
			},
		]) {
			const result = await step.execute?.(
				"step",
				params as never,
				undefined as never,
				undefined as never,
				ctx as never,
			);
			expect(result).not.toMatchObject({ isError: true });
			await captured.events.get("agent_end")![0]({ messages: [] }, ctx);
			await vi.runOnlyPendingTimersAsync();
		}
		const instructions = (goalMessages(pi).at(-1)![0].details as { instructions: string }).instructions;
		for (const fact of [
			"The API requires a cursor.",
			"The parser is implemented.",
			"Offset is rejected.",
			"Use the cursor returned by the API.",
		])
			expect(instructions).toContain(fact);
		expect(instructions).toContain("Revise the approach");
	});

	it("records tool errors and changes the next prompt to recovery", async () => {
		const { pi, todo, goal, captured } = setup();
		const ctx = { ...createMockCtx(), hasPendingMessages: () => false };
		await callTodo(todo, ctx, { action: "create", subject: "first" });
		await goal.handler("", ctx as never);
		await vi.runOnlyPendingTimersAsync();
		const originalMessages = structuredClone(vi.mocked(pi.sendMessage).mock.calls);
		await captured.events.get("tool_result")![0](
			{
				toolName: "bash",
				input: { command: "npm run build" },
				content: [{ type: "text", text: "Missing generated client" }],
				isError: true,
			},
			ctx,
		);
		await captured.events.get("turn_end")?.[0](
			{ toolResults: [{}], message: { role: "assistant", stopReason: "toolUse" } },
			ctx,
		);
		const afterRefinement = vi.mocked(pi.sendMessage).mock.calls;
		expect(afterRefinement.length).toBeGreaterThan(originalMessages.length);
		expect(afterRefinement.slice(0, originalMessages.length)).toEqual(originalMessages);
		expect(afterRefinement.at(-1)![0]).toMatchObject({
			display: false,
			content: expect.stringContaining("Missing generated client"),
		});
		const count = afterRefinement.length;
		await captured.events.get("turn_end")?.[0](
			{ toolResults: [{}], message: { role: "assistant", stopReason: "toolUse" } },
			ctx,
		);
		expect(vi.mocked(pi.sendMessage).mock.calls).toHaveLength(count);
		await captured.events.get("agent_end")![0]({ messages: [] }, ctx);
		await vi.runOnlyPendingTimersAsync();
		const instructions = (goalMessages(pi).at(-1)![0].details as { instructions: string }).instructions;
		expect(instructions).toContain("Missing generated client");
		expect(instructions).toContain("Revise the approach");
	});

	it("finishes without dispatch when reconciliation finds the entire selection complete", async () => {
		const { pi, todo, goal, captured } = setup();
		const ctx = { ...createMockCtx(), hasPendingMessages: () => false };
		await callTodo(todo, ctx, { action: "create", subject: "first" });
		await goal.handler("", ctx as never);
		const state = structuredClone(getState("test-session"));
		state.tasks[0].status = "completed";
		replaceState("test-session", state);
		await vi.runOnlyPendingTimersAsync();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(captured.entries.at(-1)?.data).toMatchObject({ goal: { status: "completed" } });
	});
});
