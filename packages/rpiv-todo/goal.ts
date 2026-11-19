import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { active, currentTask, type Goal, GoalChange, identity, parseScope, pause } from "./goal-state.ts";
import { getState, sid } from "./state/store.ts";
import { persistTodo } from "./todo.ts";
import type { TaskMutationParams } from "./tool/types.ts";

const prefix = "[rpiv-goal turn ";
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
const parameters = Type.Object({
	action: Type.String({ description: "plan, ask, block, finding, or complete" }),
	items: Type.Optional(
		Type.Array(
			Type.Object({
				subject: Type.String(),
				description: Type.String(),
				criteria: Type.String(),
				prerequisites: Type.Optional(Type.Array(Type.Integer())),
			}),
		),
	),
	id: Type.Optional(Type.Integer()),
	check: Type.Optional(Type.String()),
	result: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
});
interface Session {
	goal?: Goal;
	token?: string;
	timer?: ReturnType<typeof setTimeout>;
	work: boolean;
	authorized: boolean;
	closed: boolean;
}
export function registerGoals(pi: ExtensionAPI, refresh: (ctx: ExtensionContext) => Promise<void>) {
	const sessions = new Map<string, Session>();
	function live(ctx: ExtensionContext) {
		const id = sid(ctx);
		let s = sessions.get(id);
		if (!s) {
			s = { work: false, authorized: false, closed: false };
			sessions.set(id, s);
		}
		return s;
	}
	function stop(s: Session) {
		clearTimeout(s.timer);
		s.timer = undefined;
		s.token = undefined;
		s.authorized = false;
		s.work = false;
		s.closed = true;
	}
	function report(ctx: ExtensionContext, g: Goal) {
		const state = getState(sid(ctx)),
			t = currentTask(state, g);
		const done = g.selected.filter((r) =>
			state.tasks.some((t) => t.id === r.id && t.metadata?.[identity] === r.key && t.status === "completed"),
		).length;
		return [
			`${g.status} · ${g.scope}`,
			`${done}/${g.selected.length} complete (${g.selected.length - done} remaining)`,
			t ? `#${t.id} ${t.subject}` : "",
			g.reason,
			g.answer ? `Answer: ${g.answer}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}
	function save(ctx: ExtensionContext, c: GoalChange) {
		const s = live(ctx);
		try {
			persistTodo(pi, ctx, c.state, { tasks: c.state.tasks, nextId: c.state.nextId, goal: c.goal });
		} catch (error) {
			stop(s);
			if (active(s.goal)) {
				s.goal = structuredClone(s.goal);
				pause(s.goal, "Checkpoint failed. Inspect the current todo and resume.");
			}
			throw error;
		}
		s.goal = c.goal;
		if (c.goal.status === "paused" || !active(c.goal)) stop(s);
		if (ctx.hasUI) ctx.ui.setStatus?.("rpiv-goal", `${c.goal.status} · ${c.goal.scope}`);
		void refresh(ctx).catch(() => {});
	}
	function change(ctx: ExtensionContext) {
		const g = live(ctx).goal;
		if (!g) throw Error("No goal on this branch.");
		return new GoalChange(getState(sid(ctx)), structuredClone(g));
	}
	function hold(ctx: ExtensionContext, reason: string) {
		const c = change(ctx);
		pause(c.goal, reason);
		save(ctx, c);
	}
	function schedule(ctx: ExtensionContext) {
		const s = live(ctx);
		if (s.token || !active(s.goal) || s.goal.status === "paused") return;
		const token = randomUUID();
		s.token = token;
		const dispatch = () => {
			try {
				if (s.token !== token) return;
				if (!ctx.isIdle() || ctx.hasPendingMessages()) {
					s.timer = setTimeout(dispatch, 50);
					return;
				}
				pi.sendUserMessage(`${prefix + token}]`, { deliverAs: "followUp" });
			} catch (error) {
				stop(s);
				if (!/stale after session replacement/.test(String(error)))
					hold(ctx, `Could not dispatch goal turn: ${String(error)}`);
			}
		};
		s.timer = setTimeout(dispatch, 0);
	}
	function restore(ctx: ExtensionContext) {
		const s = live(ctx);
		stop(s);
		s.goal = undefined;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type !== "custom" || e.customType !== "rpiv-todo-state") continue;
			const g = (e.data as { goal?: Goal } | null)?.goal;
			if (g?.version === 1 && g.session === sid(ctx)) s.goal = g;
		}
		if (active(s.goal) && s.goal.status !== "paused") hold(ctx, "Interrupted. Check the current item and resume.");
		else if (ctx.hasUI) ctx.ui.setStatus?.("rpiv-goal", s.goal?.status);
	}
	function start(input: string, ctx: ExtensionContext) {
		if (active(live(ctx).goal))
			throw Error("An active goal already exists. Use /goal-status, /goal-resume or /goal-cancel.");
		const spec = parseScope(input),
			phase = spec.kind === "objective" ? "planning" : "running";
		const g: Goal = {
			version: 1,
			session: sid(ctx),
			id: randomUUID(),
			scope: input.trim() || "All unfinished todos",
			phase,
			status: phase,
			selected: [],
			evidence: {},
		};
		const c = new GoalChange(getState(sid(ctx)), g);
		if (spec.kind !== "objective") {
			const rows = c.state.tasks.filter(
				(t) =>
					t.status !== "deleted" &&
					(spec.kind === "all" ? t.status !== "completed" : t.id >= spec.first && t.id <= spec.last),
			);
			if (spec.kind === "ids" && !rows.length) throw Error("No existing items in this selection.");
			if (spec.kind === "ids" && rows.length !== spec.last - spec.first + 1)
				ctx.ui.notify(
					`Existing IDs in range: ${rows.map((t) => `#${t.id}`).join(", ")}. Missing or deleted IDs skipped.`,
					"info",
				);
			c.select(rows);
			c.advance();
		}
		save(ctx, c);
		schedule(ctx);
	}
	for (const name of ["goal", "goal-status", "goal-pause", "goal-resume", "goal-cancel"]) {
		pi.registerCommand(name, {
			description: {
				goal: "Run all todos, a selected ID/range, or a free-text objective.",
				"goal-status": "Show goal progress.",
				"goal-pause": "Pause goal execution.",
				"goal-resume": "Resume the original goal.",
				"goal-cancel": "End the current goal.",
			}[name]!,
			handler: async (args, ctx) => {
				try {
					const s = live(ctx);
					if (name === "goal") start(args, ctx);
					else if (name !== "goal-status") {
						if (!active(s.goal)) throw Error("No active goal.");
						const c = change(ctx),
							g = c.goal;
						if (name === "goal-resume") {
							if (g.status !== "paused") throw Error("Goal is already active.");
							if (g.question && !g.answer) throw Error("Answer the question in chat before resuming.");
							g.status = g.phase;
							g.reason = undefined;
							g.question = undefined;
							if (g.phase === "running") c.advance();
							save(ctx, c);
							schedule(ctx);
						} else {
							if (name === "goal-pause" && g.status === "paused") throw Error(g.reason ?? "Already paused.");
							if (name === "goal-pause") pause(g, "Paused by user.");
							else {
								c.release();
								g.status = "cancelled";
								g.reason = undefined;
							}
							save(ctx, c);
							if (!ctx.isIdle()) ctx.abort();
						}
					}
					ctx.ui.notify(s.goal ? report(ctx, s.goal) : "No goal on this branch.", "info");
				} catch (err) {
					ctx.ui.notify(String(err), "error");
				}
			},
		});
	}
	pi.on("input", (event, ctx) => {
		const g = live(ctx).goal;
		if (
			g?.status === "paused" &&
			g.question &&
			event.source !== "extension" &&
			event.text.trim() &&
			!event.text.startsWith("/")
		) {
			const c = change(ctx);
			c.goal.answer = [g.answer, event.text.trim()].filter(Boolean).join("\n");
			save(ctx, c);
		}
		return { action: "continue" };
	});
	pi.on("before_agent_start", (e, ctx) => {
		const s = live(ctx),
			g = s.goal;
		s.authorized = false;
		s.work = false;
		s.closed = false;
		if ("prompt" in e && e.prompt.startsWith(prefix)) {
			if (!s.token || e.prompt !== `${prefix + s.token}]` || !active(g) || g.status === "paused") {
				s.closed = true;
				ctx.abort();
				return { systemPrompt: `${e.systemPrompt}\nStale goal dispatch. Stop immediately.` };
			}
			s.token = undefined;
			s.authorized = true;
			const task = currentTask(getState(sid(ctx)), g);
			return {
				systemPrompt:
					e.systemPrompt +
					"\nGoal: " +
					JSON.stringify({
						phase: g.phase,
						objective: g.scope,
						current: task,
						answer: g.answer,
						finding: g.finding,
					}) +
					"\nUse goal_step for this run. In planning, investigate and clarify material decisions with ask, then submit plan items with done criteria and 1-based earlier prerequisite indexes. In running, work only on the current item. Verify its done criteria then complete with its id, check and observed result. Use ask for user decisions, block for obstacles, finding for concrete research results. Never claim success based on a promise.",
			};
		}
		if (g?.status === "paused")
			return {
				systemPrompt: `${e.systemPrompt}\nThe goal is paused. Discuss only until the user runs /goal-resume.`,
			};
	});
	pi.on("tool_call", (e, ctx) => {
		const s = live(ctx);
		if (s.closed) return { block: true, reason: "This goal turn has ended." };
		if (
			s.goal?.status === "paused" &&
			!["read", "grep", "find", "ls"].includes(e.toolName) &&
			!(e.toolName === "todo" && ["list", "get"].includes(String((e.input as { action?: string }).action)))
		)
			return { block: true, reason: "Goal paused. Discuss or use /goal-resume." };
	});
	pi.on("tool_result", (e, ctx) => {
		const s = live(ctx);
		if (s.authorized && !e.isError && !["goal_step", "todo"].includes(e.toolName)) s.work = true;
	});
	pi.on("agent_end", (e, ctx) => {
		const s = live(ctx);
		if (!s.authorized) return;
		s.authorized = false;
		if (!active(s.goal) || s.goal.status === "paused") return;
		const last = e.messages.filter((m) => m.role === "assistant").at(-1);
		if (last?.stopReason === "error" || last?.stopReason === "aborted") {
			hold(ctx, "Agent run interrupted or failed.");
			return;
		}
		if (!s.work) {
			hold(ctx, "No observed work or finding. Review and resume.");
			return;
		}
		schedule(ctx);
	});
	pi.registerTool({
		name: "goal_step",
		label: "Goal progress",
		description:
			"Drive an active /goal. Submit a plan, ask a question, report a blocker or finding, or verify the current item.",
		parameters,
		async execute(_id, p, _signal, _update, ctx) {
			try {
				const s = live(ctx);
				if (!s.authorized || s.closed || !active(s.goal) || s.goal.status === "paused")
					throw Error("No executing goal turn.");
				const c = change(ctx),
					g = c.goal;
				if (p.action === "complete") c.complete(p.id ?? 0, p.check ?? "", p.result ?? "");
				else if (p.action === "plan") c.plan(p.items ?? []);
				else {
					const msg = p.message?.trim();
					if (!msg) throw Error("A message is required.");
					if (p.action === "ask" || p.action === "block") {
						pause(g, msg);
						g.question = p.action === "ask" ? msg : undefined;
						g.answer = undefined;
					} else if (p.action === "finding") {
						if (g.finding === msg) throw Error("Finding already recorded.");
						g.finding = msg;
					} else throw Error("Unknown goal action.");
				}
				save(ctx, c);
				s.work = true;
				s.closed = true;
				if (g.status === "paused") ctx.ui.notify(g.reason!, "info");
				return { ...text(report(ctx, g)), terminate: true };
			} catch (err) {
				return { ...text(String(err)), isError: true };
			}
		},
	});
	return {
		restore,
		shutdown(id: string) {
			const s = sessions.get(id);
			if (s) stop(s);
			sessions.delete(id);
		},
		guard(ctx: ExtensionContext, p: TaskMutationParams) {
			if (p.metadata?.[identity] !== undefined || p.tasks?.some((t) => t.metadata?.[identity] !== undefined))
				return "Goal identity is reserved.";
			const s = live(ctx);
			const g = s.goal;
			if (s.authorized && !["list", "get"].includes(String(p.action)))
				return "Use goal_step to change the goal and its todos together.";
			if (active(g) && p.status && g.selected.some((r) => r.id === p.id))
				return "Use goal_step to verify selected work.";
			if (active(g) && g.status === "paused" && !["list", "get"].includes(String(p.action)))
				return "Goal is paused.";
		},
		changed(ctx: ExtensionContext) {
			const g = live(ctx).goal;
			if (!active(g) || g.status !== "running") return;
			const c = change(ctx);
			c.advance();
			if (c.goal.status !== g.status || c.goal.current !== g.current) save(ctx, c);
		},
	};
}
