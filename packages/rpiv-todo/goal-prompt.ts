import { currentTask, type Goal, type GoalUpdate } from "./goal-state.ts";
import type { TaskState } from "./state/state.ts";

/** Build each turn's priorities from the current list and persisted observations. */
export function buildGoalInstructions(state: TaskState, goal: Goal): string {
	const updates = goal.updates ?? [];
	const findings = updates.filter((update) => update.kind === "finding");
	if (goal.finding && !findings.some((update) => update.message === goal.finding)) {
		findings.push({ kind: "finding", message: goal.finding });
	}
	const failures = updates.filter((update) => update.kind === "failure");
	const currentUpdates = updates.filter((update) => update.item === undefined || update.item === goal.current);
	const next = currentUpdates
		.slice()
		.reverse()
		.find((update) => update.next || update.kind === "failure")?.next;
	const selected = state.tasks.filter((task) => goal.selected.some((ref) => ref.id === task.id));
	const progress: GoalUpdate[] = updates.filter((update) => update.kind === "progress").slice(-8);
	const context = {
		phase: goal.phase,
		objective: goal.scope,
		current: currentTask(state, goal),
		answer: goal.answer,
		completed: selected
			.filter((task) => task.status === "completed")
			.map((task) => ({ id: task.id, subject: task.subject, evidence: goal.evidence[task.id] })),
		remaining: selected
			.filter((task) => task.status !== "completed")
			.map((task) => ({ id: task.id, subject: task.subject, status: task.status, blockedBy: task.blockedBy })),
		progress,
		findings,
		failedApproaches: failures,
		next,
	};
	const directions = [
		"Use goal_step for this run. Preserve the objective, selected scope and done criteria. Treat recorded observations as evidence to assess.",
		"In planning, investigate and clarify material decisions with ask, then submit plan items with done criteria and 1-based earlier prerequisite indexes.",
		"In running, work only on the current item. Verify its done criteria then complete with its id, check and observed result. Never claim success based on a promise.",
		"Record concrete progress with progress, discoveries with finding, and failed approaches with failure (approach, observed result and a revised next step). Use ask for user decisions and block for obstacles.",
	];
	if (currentUpdates.some((update) => update.kind === "failure")) {
		directions.push(
			"Revise the approach using the failed attempts and their observed errors. Diagnose the cause before retrying. Explain what changed before repeating an attempt. Use ask or block if recovery needs user input.",
		);
	}
	if (findings.length)
		directions.push(
			"Apply the recorded findings to the current work and verification. Recheck any assumption contradicted by new evidence.",
		);
	if (progress.length || Object.keys(goal.evidence).length)
		directions.push(
			"Build on recorded progress and verified completions. Compare the remaining work with the current done criteria and choose the smallest useful next step.",
		);
	if (next) directions.push(`Assess the latest proposed next step against the current todo and evidence: ${next}`);
	return `Goal: ${JSON.stringify(context)}\n${directions.join("\n")}`;
}
