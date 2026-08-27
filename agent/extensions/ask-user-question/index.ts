import { type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, Text, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { cancelAskUserQuestionBatch, withAskUserQuestionQueue } from "./queue.js";

const MAX_OPTIONS = 50;
const OptionSchema = Type.Object({
	label: Type.String({
		minLength: 1,
		maxLength: 500,
		description:
			'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
	}),
	value: Type.Optional(
		Type.String({
			maxLength: 500,
			description: "Optional machine-readable value returned for the option. Defaults to the label.",
		}),
	),
	description: Type.Optional(Type.String({ maxLength: 1_000, description: "Optional extra detail shown below the option." })),
});

type AskOptionInput = Static<typeof OptionSchema>;

const AskUserQuestionParams = Type.Object({
	question: Type.String({
		minLength: 1,
		maxLength: 4_000,
		description: "The single question to ask the user. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({ maxLength: 4_000, description: "Optional extra context or instructions shown under the question." }),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			maxItems: MAX_OPTIONS,
			description:
				"Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users can choose Other and type a custom answer when options are provided.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set to true to allow multiple answers to be selected for a question." }),
	),
});
type AskUserQuestionParams = Static<typeof AskUserQuestionParams>;

interface AskOption {
	label: string;
	value: string;
	description?: string;
}

interface DisplayOption extends AskOption {
	id: string;
	index?: number;
	isOther?: boolean;
	isSubmit?: boolean;
	isSkip?: boolean;
}

interface TextAnswer {
	type: "text";
	label: string;
	value: string;
}

interface OptionAnswer {
	type: "option";
	label: string;
	value: string;
	index: number;
}

interface OtherAnswer {
	type: "other";
	label: string;
	value: string;
}

type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
type AskUserQuestionStatus = "answered" | "skipped" | "cancelled" | "unavailable";
type AskUserQuestionMode = "text" | "single-select" | "multi-select";
type ChoiceInteraction = { kind: "answered"; answers: AskAnswer[] } | { kind: "skipped" };

interface AskUserQuestionResultDetails {
	status: AskUserQuestionStatus;
	question: string;
	context?: string;
	mode: AskUserQuestionMode;
	answers: AskAnswer[];
	message?: string;
}

function normalizeOptions(options: AskOptionInput[] | undefined): AskOption[] {
	return (options ?? [])
		.slice(0, MAX_OPTIONS)
		.map((option) => {
			const label = option.label.trim();
			return {
				label,
				value: option.value?.trim() || label,
				description: option.description?.trim() || undefined,
			};
		})
		.filter((option) => option.label.length > 0);
}

function getOtherLabel(options: AskOption[]): string {
	return options.some((option) => option.label.toLowerCase() === "other") ? "Other (custom)" : "Other";
}

function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

function formatAnswerForModel(answer: AskAnswer): string {
	switch (answer.type) {
		case "text":
			return answer.label;
		case "other":
			return `Other: ${answer.label}`;
		case "option":
			return `${answer.index}. ${answer.label}`;
	}
}

function answerSortRank(answer: AskAnswer): number {
	switch (answer.type) {
		case "option":
			return answer.index;
		case "other":
			return Number.MAX_SAFE_INTEGER - 1;
		case "text":
			return Number.MAX_SAFE_INTEGER;
	}
}

function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
	return [...answers].sort((left, right) => answerSortRank(left) - answerSortRank(right));
}

function buildStructuredResult(
	status: AskUserQuestionStatus,
	question: string,
	mode: AskUserQuestionMode,
	answers: AskAnswer[],
	context?: string,
	message?: string,
): AskUserQuestionResultDetails {
	return { status, question, context, mode, answers, message };
}

function cancelledResult(question: string, mode: AskUserQuestionMode, context?: string) {
	const message = "User cancelled the question";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("cancelled", question, mode, [], context, message),
	};
}

function skippedResult(question: string, mode: AskUserQuestionMode, context?: string) {
	const message = "User skipped the question";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("skipped", question, mode, [], context, message),
	};
}

function unavailableResult(question: string, mode: AskUserQuestionMode, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], context, message),
	};
}

function answeredResult(question: string, context: string | undefined, mode: AskUserQuestionMode, answers: AskAnswer[]) {
	let text: string;
	if (mode === "text") {
		const answer = answers[0];
		text = answer.label.length > 0 ? `User answered: ${answer.label}` : "User submitted an empty response";
	} else if (mode === "single-select") {
		text = `User selected: ${formatAnswerForModel(answers[0])}`;
	} else {
		text = `User selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
	}

	return {
		content: [{ type: "text" as const, text }],
		details: buildStructuredResult("answered", question, mode, answers, context),
	};
}

async function askText(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const editor = new Editor(tui, createEditorTheme(theme));
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		let settled = false;
		let onAbort: (() => void) | undefined;

		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			if (onAbort) signal?.removeEventListener("abort", onAbort);
			done(value);
		};

		editor.onSubmit = (value) => finish(value.trim());
		onAbort = () => {
			cancelAskUserQuestionBatch();
			finish(null);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		function refresh() {
			cachedLines = undefined;
			editor.invalidate();
			tui.requestRender();
		}

		function render(width: number): string[] {
			// The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
			// invalidate() on terminal resize, so render() can be re-entered with a
			// new width. Returning stale wider lines trips the TUI width guard and
			// crashes the process.
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));
			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");
			for (const line of editor.render(Math.max(1, width - 2))) add(` ${line}`);
			lines.push("");
			add(theme.fg("dim", " Enter submit • Esc cancel"));
			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput(data) {
				if (matchesKey(data, Key.escape)) {
					cancelAskUserQuestionBatch();
					finish(null);
					return;
				}
				editor.handleInput(data);
				refresh();
			},
			dispose() {
				if (onAbort) signal?.removeEventListener("abort", onAbort);
			},
		};
	});
}

async function askSingleChoice(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
	signal: AbortSignal | undefined,
): Promise<ChoiceInteraction | null> {
	const allOptions: DisplayOption[] = [
		...options.map((option, index) => ({ ...option, id: `option:${index}`, index: index + 1 })),
		{ id: "other", label: getOtherLabel(options), value: "__other__", isOther: true },
		{ id: "skip", label: "Skip this question", value: "__skip__", isSkip: true },
	];

	return ctx.ui.custom<ChoiceInteraction | null>((tui, theme, _kb, done) => {
		let optionIndex = 0;
		let editMode = false;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		let settled = false;
		let onAbort: (() => void) | undefined;
		const editor = new Editor(tui, createEditorTheme(theme));

		const finish = (value: ChoiceInteraction | null) => {
			if (settled) return;
			settled = true;
			if (onAbort) signal?.removeEventListener("abort", onAbort);
			done(value);
		};

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (trimmed) finish({ kind: "answered", answers: [{ type: "other", label: trimmed, value: trimmed }] });
		};
		onAbort = () => {
			cancelAskUserQuestionBatch();
			finish(null);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		function refresh() {
			cachedLines = undefined;
			editor.invalidate();
			tui.requestRender();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					cancelAskUserQuestionBatch();
					finish(null);
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const selected = allOptions[optionIndex];
				if (selected.isSkip) {
					finish({ kind: "skipped" });
				} else if (selected.isOther) {
					editMode = true;
					editor.setText("");
					refresh();
				} else {
					finish({
						kind: "answered",
						answers: [{ type: "option", label: selected.label, value: selected.value, index: selected.index! }],
					});
				}
				return;
			}
			if (matchesKey(data, Key.escape)) {
				cancelAskUserQuestionBatch();
				finish(null);
			}
		}

		function render(width: number): string[] {
			// The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
			// invalidate() on terminal resize, so render() can be re-entered with a
			// new width. Returning stale wider lines trips the TUI width guard and
			// crashes the process.
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));
			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");

			for (let i = 0; i < allOptions.length; i += 1) {
				const option = allOptions[i];
				const focused = i === optionIndex;
				const prefix = focused ? theme.fg("accent", "> ") : "  ";
				const label = option.isOther || option.isSkip ? option.label : `${option.index}. ${option.label}`;
				add(`${prefix}${focused ? theme.fg("accent", label) : theme.fg(option.isSkip ? "dim" : "text", label)}`);
				if (option.description) addWrapped(lines, theme.fg("muted", option.description), width, "     ");
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) add(` ${line}`);
				lines.push("");
				add(theme.fg("dim", " Enter submit • Esc cancel"));
			} else {
				lines.push("");
				add(theme.fg("dim", " ↑↓ navigate • Enter select • Esc cancel"));
			}

			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
			dispose() {
				if (onAbort) signal?.removeEventListener("abort", onAbort);
			},
		};
	});
}

async function askMultiChoice(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
	signal: AbortSignal | undefined,
): Promise<ChoiceInteraction | null> {
	const choiceItems: DisplayOption[] = options.map((option, index) => ({
		...option,
		id: `option:${index}`,
		index: index + 1,
	}));
	const allItems: DisplayOption[] = [
		...choiceItems,
		{ id: "other", label: getOtherLabel(options), value: "__other__", isOther: true },
		{ id: "submit", label: "Submit", value: "__submit__", isSubmit: true },
		{ id: "skip", label: "Skip this question", value: "__skip__", isSkip: true },
	];

	return ctx.ui.custom<ChoiceInteraction | null>((tui, theme, _kb, done) => {
		let optionIndex = 0;
		let editMode = false;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		let settled = false;
		let onAbort: (() => void) | undefined;
		const selected = new Map<string, AskAnswer>();
		const editor = new Editor(tui, createEditorTheme(theme));

		const finish = (value: ChoiceInteraction | null) => {
			if (settled) return;
			settled = true;
			if (onAbort) signal?.removeEventListener("abort", onAbort);
			done(value);
		};

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			selected.set("other", { type: "other", label: trimmed, value: trimmed });
			editMode = false;
			refresh();
		};
		onAbort = () => {
			cancelAskUserQuestionBatch();
			finish(null);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		function refresh() {
			cachedLines = undefined;
			editor.invalidate();
			tui.requestRender();
		}

		function toggleOption(item: DisplayOption) {
			if (selected.has(item.id)) {
				selected.delete(item.id);
			} else {
				selected.set(item.id, {
					type: "option",
					label: item.label,
					value: item.value,
					index: item.index!,
				});
			}
			refresh();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					cancelAskUserQuestionBatch();
					finish(null);
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allItems.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			const current = allItems[optionIndex];
			if (matchesKey(data, Key.space)) {
				if (current.isSubmit || current.isSkip) return;
				if (current.isOther) {
					if (selected.has("other")) {
						selected.delete("other");
						refresh();
					} else {
						editMode = true;
						editor.setText("");
						refresh();
					}
					return;
				}
				toggleOption(current);
				return;
			}

			if (matchesKey(data, Key.enter)) {
				if (current.isSkip) {
					finish({ kind: "skipped" });
				} else if (current.isSubmit) {
					if (selected.size > 0) finish({ kind: "answered", answers: sortAnswers([...selected.values()]) });
				} else if (current.isOther) {
					editMode = true;
					editor.setText(selected.get("other")?.label ?? "");
					refresh();
				} else {
					toggleOption(current);
				}
				return;
			}

			if (matchesKey(data, Key.escape)) {
				cancelAskUserQuestionBatch();
				finish(null);
			}
		}

		function render(width: number): string[] {
			// The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
			// invalidate() on terminal resize, so render() can be re-entered with a
			// new width. Returning stale wider lines trips the TUI width guard and
			// crashes the process.
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));
			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");

			for (let i = 0; i < allItems.length; i += 1) {
				const item = allItems[i];
				const focused = i === optionIndex;
				const prefix = focused ? theme.fg("accent", "> ") : "  ";

				if (item.isSubmit) {
					const label = selected.size > 0 ? `✓ ${item.label} (${selected.size} selected)` : `○ ${item.label}`;
					add(`${prefix}${focused ? theme.fg("accent", label) : theme.fg(selected.size > 0 ? "success" : "dim", label)}`);
					continue;
				}
				if (item.isSkip) {
					add(`${prefix}${focused ? theme.fg("accent", item.label) : theme.fg("dim", item.label)}`);
					continue;
				}
				if (item.isOther) {
					const other = selected.get("other");
					const marker = other ? "[x]" : "[ ]";
					const suffix = other ? ` — ${other.label}` : "";
					add(`${prefix}${focused ? theme.fg("accent", `${marker} ${item.label}${suffix}`) : theme.fg(other ? "success" : "text", `${marker} ${item.label}${suffix}`)}`);
					continue;
				}

				const checked = selected.has(item.id);
				const label = `${checked ? "[x]" : "[ ]"} ${item.index}. ${item.label}`;
				add(`${prefix}${focused ? theme.fg("accent", label) : theme.fg(checked ? "success" : "text", label)}`);
				if (item.description) addWrapped(lines, theme.fg("muted", item.description), width, "     ");
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) add(` ${line}`);
				lines.push("");
				add(theme.fg("dim", " Enter save • Esc cancel"));
			} else {
				lines.push("");
				if (selected.size === 0) add(theme.fg("warning", " Select at least one answer before submitting."));
				add(theme.fg("dim", " ↑↓ navigate • Space toggle • Enter edit/submit/skip • Esc cancel"));
			}

			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
			dispose() {
				if (onAbort) signal?.removeEventListener("abort", onAbort);
			},
		};
	});
}

export default function askUserQuestion(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding.",
		promptSnippet: "Ask exactly one clarifying, preference, or decision question before continuing.",
		promptGuidelines: [
			"Ask exactly one question per tool call.",
			"For multiple questions, make separate ask_user_question tool calls.",
			"Users can select Other to provide custom text when options are provided.",
			"Use multiSelect: true only when multiple answers are needed for one question.",
			'If recommending an option, place it first and append "(Recommended)" to its label.',
			"Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params: AskUserQuestionParams, signal, _onUpdate, ctx) {
			const question = params.question.trim();
			const context = params.details?.trim() || undefined;
			const options = normalizeOptions(params.options);
			const mode: AskUserQuestionMode = options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select";

			if (signal?.aborted) return cancelledResult(question, mode, context);
			if (!ctx.hasUI) return unavailableResult(question, mode, "ask_user_question requires interactive mode UI", context);

			return withAskUserQuestionQueue(
				signal,
				async () => {
					if (mode === "text") {
						const answer = await askText(ctx, question, context, signal);
						if (answer === null) return cancelledResult(question, mode, context);
						return answeredResult(question, context, mode, [{ type: "text", label: answer, value: answer }]);
					}

					const interaction =
						mode === "single-select"
							? await askSingleChoice(ctx, question, context, options, signal)
							: await askMultiChoice(ctx, question, context, options, signal);
					if (!interaction || interaction.kind === "skipped") {
						return interaction?.kind === "skipped" ? skippedResult(question, mode, context) : cancelledResult(question, mode, context);
					}
					return answeredResult(question, context, mode, interaction.answers);
				},
				() => cancelledResult(question, mode, context),
			);
		},

		renderCall(args, theme) {
			const options = normalizeOptions(args.options);
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", args.question);
			if (args.multiSelect) text += theme.fg("dim", " [multi-select]");
			if (options.length > 0) {
				const labels = [...options.map((option) => option.label), getOtherLabel(options)].join(", ");
				text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.status === "cancelled") return new Text(theme.fg("warning", details.message || "Cancelled"), 0, 0);
			if (details.status === "skipped") return new Text(theme.fg("dim", details.message || "Skipped"), 0, 0);
			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", details.message || "ask_user_question unavailable"), 0, 0);
			}

			const lines = details.answers.map((answer) => {
				switch (answer.type) {
					case "text":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label || "(empty response)")}`;
					case "other":
						return `${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", answer.label)}`;
					case "option":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`;
				}
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
