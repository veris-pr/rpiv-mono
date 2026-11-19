import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
// Deterministic in-process provider for the Pi 0.80.2 RPC acceptance test.
export default function (pi) {
	pi.registerTool({
		name: "fixture_probe",
		label: "Fixture probe",
		description: "Return a predictable tool error for the cache test.",
		parameters: Type.Object({}),
		async execute() {
			throw Error("Probe failed because cursor is missing.");
		},
	});
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	pi.registerProvider("fixture", {
		api: "fixture-api",
		apiKey: "fixture",
		baseUrl: "https://unused.invalid",
		models: [
			{ id: "test", name: "test", reasoning: false, input: ["text"], cost, contextWindow: 100000, maxTokens: 1024 },
		],
		streamSimple(model, ctx) {
			appendFileSync(
				join(process.env.PI_CODING_AGENT_DIR, "prompt-audit.jsonl"),
				`${JSON.stringify({ messages: ctx.messages, systemPrompt: ctx.systemPrompt })}\n`,
			);
			const stream = createAssistantMessageEventStream();
			const last = ctx.messages.at(-1);
			let call;
			if (last.role === "user") {
				const serialized = JSON.stringify(last.content);
				if (serialized.includes("seed-six"))
					call = [
						"todo",
						{ action: "create", tasks: Array.from({ length: 6 }, (_, i) => ({ subject: "Row " + (i + 1) })) },
					];
				if (
					serialized.includes("Working on todo #") ||
					serialized.includes("Planning —") ||
					serialized.includes("Goal: ")
				) {
					const contents = ctx.messages.map((message) =>
						typeof message.content === "string"
							? message.content
							: message.content.map((part) => part.text ?? "").join("\n"),
					);
					const text = contents.findLast((content) => content.startsWith("Goal: "));
					const g = JSON.parse(text.slice("Goal: ".length).split("\n")[0]);
					if (g.objective === "cache recovery" && !g.failedApproaches.length) call = ["fixture_probe", {}];
					else if (
						g.current?.id === 2 &&
						!g.findings?.some((entry) => entry.message === "Fixture reports use cursors.")
					)
						call = ["goal_step", { action: "finding", message: "Fixture reports use cursors." }];
					else if (
						g.current?.id === 2 &&
						!g.progress?.some((entry) => entry.message === "Cursor parsing implemented.")
					)
						call = [
							"goal_step",
							{ action: "progress", message: "Cursor parsing implemented.", next: "Verify cursor handling." },
						];
					else if (
						g.current?.id === 3 &&
						!g.failedApproaches?.some((entry) => entry.approach === "Offset request")
					)
						call = [
							"goal_step",
							{
								action: "failure",
								approach: "Offset request",
								result: "Offset rejected.",
								next: "Read the cursor from response headers.",
							},
						];
					else if (
						g.current?.id === 3 &&
						g.answer &&
						(!g.findings?.length || !text.includes("Revise the approach"))
					)
						throw Error("Adaptive history was lost after restart.");
					else if (g.objective === "pause on empty response") call = undefined;
					else if (g.phase === "planning")
						call = g.answer
							? [
									"goal_step",
									{
										action: "plan",
										items: [
											{
												subject: "Review result",
												description: "Read the fixture",
												criteria: "Fixture reports ready",
											},
										],
									},
								]
							: ["goal_step", { action: "ask", message: "Which fixture?" }];
					else if (g.current.id === 3 && !g.answer)
						call = ["goal_step", { action: "ask", message: "Which fixture?" }];
					else
						call = [
							"goal_step",
							{
								action: "complete",
								id: g.current.id,
								check: "Inspect fixture",
								result: "Expected fixture row present",
							},
						];
				}
			}
			const content = call
				? { type: "toolCall", id: "call_" + Date.now(), name: call[0], arguments: call[1] }
				: { type: "text", text: "OK" };
			const m = {
				role: "assistant",
				content: [content],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } },
				stopReason: call ? "toolUse" : "stop",
				timestamp: Date.now(),
			};
			const send = () => {
				stream.push({ type: "start", partial: m });
				stream.push(
					call
						? { type: "toolcall_end", contentIndex: 0, toolCall: content, partial: m }
						: { type: "text_end", contentIndex: 0, content: "OK", partial: m },
				);
				stream.push({ type: "done", reason: m.stopReason, message: m });
				stream.end();
			};
			if (JSON.stringify(last.content).includes("Planning — slow planning")) setTimeout(send, 2000);
			else send();
			return stream;
		},
	});
}
