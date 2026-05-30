export interface ClassifiedReason {
	reason: string;
	isReload: boolean;
	isTerminal: boolean;
	shouldConsolidate: boolean;
}

export function classifyReason(reason: string | undefined, defaultReason: string): ClassifiedReason {
	const r = reason || defaultReason;
	const isReload = r === "reload";
	const isTerminal = r === "quit";
	const shouldConsolidate = !isReload;
	return {
		reason: r,
		isReload,
		isTerminal,
		shouldConsolidate,
	};
}

export function shouldSwap(startGen: number, currentGen: number): boolean {
	return startGen === currentGen;
}

export interface LifecycleActions {
	extract: "none" | "background" | "blocking";
	reconcile: "none" | "background";
}

export const LIFECYCLE_MATRIX: Record<string, LifecycleActions> = {
	startup: {
		extract: "none",
		reconcile: "background",
	},
	reload: {
		extract: "none",
		reconcile: "none",
	},
	new: {
		extract: "background",
		reconcile: "background",
	},
	resume: {
		extract: "background",
		reconcile: "background",
	},
	fork: {
		extract: "background",
		reconcile: "background",
	},
	quit: {
		extract: "blocking",
		reconcile: "none",
	},
};

export function getLifecycleActions(reason: string | undefined, defaultReason: string): LifecycleActions {
	const r = reason || defaultReason;
	return LIFECYCLE_MATRIX[r] || { extract: "none", reconcile: "none" };
}

export interface CapturedCtx {
	cwd: string;
	model: any;
	modelRegistry: any;
	thinkingLevel: any;
}

export function captureCtx(ctx: { cwd?: string; model?: any; modelRegistry?: any; thinkingLevel?: any }): CapturedCtx {
	return {
		cwd: ctx.cwd ?? process.cwd(),
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		thinkingLevel: ctx.thinkingLevel,
	};
}

