import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
// Deterministic in-process provider for the Pi 0.80.2 RPC acceptance test.
export default function (pi) {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	pi.registerProvider("fixture", {
		api: "fixture-api",
		apiKey: "fixture",
		baseUrl: "https://unused.invalid",
		models: [
			{ id: "test", name: "test", reasoning: false, input: ["text"], cost, contextWindow: 100000, maxTokens: 1024 },
		],
		streamSimple(model, ctx) {
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
				if (serialized.includes("[rpiv-goal turn")) {
					const g = JSON.parse(ctx.systemPrompt.split("\nGoal: ").at(-1).split("\n")[0]);
					if (g.objective === "pause on empty response") call = undefined;
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
			if (ctx.systemPrompt.includes('"objective":"slow planning"')) setTimeout(send, 2000);
			else send();
			return stream;
		},
	});
}
