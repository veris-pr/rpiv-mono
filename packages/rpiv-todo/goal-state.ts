import { randomUUID } from "node:crypto";
import type { TaskState } from "./state/state.ts";
import { applyTaskMutation } from "./state/state-reducer.ts";
import type { Task, TaskAction, TaskMutationParams } from "./tool/types.ts";

export const identity = "rpivGoalItem";
type Phase = "planning" | "running";
export interface Goal {
	version: 1;
	session: string;
	id: string;
	scope: string;
	phase: Phase;
	status: Phase | "paused" | "completed" | "cancelled";
	selected: { id: number; key: string }[];
	current?: number;
	reason?: string;
	question?: string;
	answer?: string;
	finding?: string;
	updates?: GoalUpdate[];
	evidence: Record<string, { check: string; result: string }>;
}
export interface GoalUpdate {
	kind: "progress" | "finding" | "failure";
	item?: number;
	message: string;
	approach?: string;
	next?: string;
}
export interface DraftItem {
	subject: string;
	description: string;
	criteria: string;
	prerequisites?: number[];
}
export function active(g: Goal | undefined): g is Goal {
	return !!g && g.status !== "cancelled" && g.status !== "completed";
}
export function parseScope(input: string) {
	const s = input.trim();
	if (!s) return { kind: "all" } as const;
	const single = /^complete todo item #(\d+)$/i.exec(s);
	const range = /^complete todo items #(\d+)\s*-\s*#?(\d+)$/i.exec(s);
	if (single || range) {
		const first = Number((single ?? range)![1]),
			last = range ? Number(range[2]) : first;
		if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first)
			throw Error("Use positive IDs in ascending order.");
		return { kind: "ids", first, last } as const;
	}
	if (/^complete todo items?\b/i.test(s)) throw Error("Use complete todo item #3 or complete todo items #2-#5.");
	return { kind: "objective" } as const;
}
export function pause(g: Goal, reason: string) {
	g.status = "paused";
	g.reason = reason;
}
export function currentTask(state: TaskState, g: Goal) {
	return state.tasks.find((t) => t.id === g.current);
}
export class GoalChange {
	constructor(
		public state: TaskState,
		public goal: Goal,
	) {}
	record(update: GoalUpdate): boolean {
		if (!update.message.trim()) throw Error("A concrete result or observation is required.");
		const entry = { ...update, item: update.item ?? this.goal.current };
		const history: GoalUpdate[] =
			this.goal.updates ?? (this.goal.finding ? [{ kind: "finding", message: this.goal.finding }] : []);
		if (
			history.some(
				(previous) =>
					previous.kind === entry.kind &&
					previous.item === entry.item &&
					previous.message === entry.message &&
					previous.approach === entry.approach &&
					previous.next === entry.next,
			)
		)
			return false;
		this.goal.updates = [...history, entry];
		return true;
	}
	private write(action: TaskAction, params: TaskMutationParams) {
		const r = applyTaskMutation(this.state, action, params);
		if (r.op.kind === "error") throw Error(r.op.message);
		this.state = r.state;
	}
	select(tasks: Task[]) {
		for (const t of tasks) {
			const key = randomUUID();
			this.write("update", { id: t.id, metadata: { [identity]: key } });
			this.goal.selected.push({ id: t.id, key });
		}
	}
	plan(items: DraftItem[]) {
		if (this.goal.status !== "planning" || !items.length) throw Error("A planning goal needs at least one item.");
		const ids: number[] = [];
		for (const item of items) {
			if (!item.subject.trim() || !item.description.trim() || !item.criteria.trim())
				throw Error("Every item needs a subject, description and done criteria.");
			const deps = item.prerequisites ?? [];
			if (deps.some((n) => !Number.isInteger(n) || n < 1 || n > ids.length))
				throw Error("Prerequisites must reference earlier plan rows, numbered from 1.");
			const id = this.state.nextId,
				key = randomUUID();
			this.write("create", {
				subject: item.subject,
				description: `${item.description}\nDone when: ${item.criteria}`,
				blockedBy: deps.map((n) => ids[n - 1]),
				metadata: { [identity]: key },
			});
			ids.push(id);
			this.goal.selected.push({ id, key });
		}
		this.goal.phase = "running";
		this.advance();
	}
	advance() {
		const g = this.goal;
		const remaining: Task[] = [];
		for (const ref of g.selected) {
			const t = this.state.tasks.find((row) => row.id === ref.id);
			if (!t || t.status === "deleted" || t.metadata?.[identity] !== ref.key) {
				pause(g, `Selected item #${ref.id} was deleted or replaced.`);
				return;
			}
			if (t.status !== "completed") remaining.push(t);
		}
		const ready = remaining.filter(
			(t) => !t.blockedBy?.some((id) => this.state.tasks.find((row) => row.id === id)?.status !== "completed"),
		);
		const next = ready.find((t) => t.id === g.current) ?? ready[0];
		if (!next && remaining.length) {
			pause(
				g,
				"Waiting on prerequisites: " +
					remaining
						.map((t) => `#${t.id} needs ${(t.blockedBy ?? []).map((id) => `#${id}`).join(", ")}`)
						.join("; "),
			);
			return;
		}
		if (g.current !== next?.id) this.release();
		g.current = next?.id;
		g.reason = undefined;
		g.question = undefined;
		if (!next) {
			g.status = "completed";
			return;
		}
		if (next.status !== "in_progress") this.write("update", { id: next.id, status: "in_progress" });
		g.status = "running";
	}
	release() {
		const g = this.goal,
			t = currentTask(this.state, g);
		if (t?.status === "in_progress" && g.selected.some((r) => r.id === t.id && t.metadata?.[identity] === r.key))
			this.write("update", { id: t.id, status: "pending" });
		g.current = undefined;
	}
	complete(id: number, check: string, result: string) {
		const g = this.goal,
			t = currentTask(this.state, g);
		if (
			g.status !== "running" ||
			!t ||
			t.id !== id ||
			!g.selected.some((r) => r.id === id && r.key === t.metadata?.[identity]) ||
			t.status !== "in_progress"
		)
			throw Error("The current item changed.");
		if (!check.trim() || !result.trim()) throw Error("Provide the check performed and its observed result.");
		if (t.blockedBy?.some((id) => this.state.tasks.find((row) => row.id === id)?.status !== "completed"))
			throw Error("Prerequisites are unfinished.");
		g.evidence[id] = { check, result };
		this.record({ kind: "progress", item: id, message: `Verified ${check}: ${result}` });
		this.write("update", { id, status: "completed" });
		g.current = undefined;
		this.advance();
	}
}
