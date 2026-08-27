import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { SubagentIpcClient } from "./ipc.ts";
import { truncateSubagentResult } from "./launch.ts";

function lastAssistantText(messages: readonly unknown[]): string {
	for (const rawMessage of [...messages].reverse()) {
		const message = rawMessage as { role?: unknown; content?: unknown };
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		return message.content
			.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

export default function subagentChildExtension(pi: ExtensionAPI): void {
	const socketPath = process.env.PI_SUBAGENT_SOCKET;
	const token = process.env.PI_SUBAGENT_TOKEN;
	const owner = process.env.PI_SUBAGENT_OWNER;
	const childSessionId = process.env.PI_SUBAGENT_CHILD_SESSION_ID;
	if (!socketPath || !token || !owner || !childSessionId) return;

	let client: SubagentIpcClient | undefined;
	let resultSent = false;

	pi.on("session_start", async () => {
		client = await SubagentIpcClient.connect({ socketPath, token, owner });
	});

	pi.on("agent_end", (event, ctx) => {
		if (!client || resultSent) return;
		resultSent = true;
		const text = truncateSubagentResult(lastAssistantText(event.messages));
		void client.request("result", { childSessionId, text })
			.then(() => ctx.shutdown())
			.catch(() => ctx.shutdown());
	});

	pi.on("session_shutdown", () => {
		void client?.close();
	});
}
