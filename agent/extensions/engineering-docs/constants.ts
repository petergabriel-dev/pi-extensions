// Engineering docs constants

export const DOCS_DIR = "docs/engineering";
export const MANIFEST_FILE = "manifest.json";
export const DECISIONS_DIR = "decisions";
export const DECISIONS_INDEX = "README.md";

export const SPOKE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export const SPOKE_MARKER_START = "<!-- pi-docs:start (generated — edit docs/engineering/, not this block) -->";
export const SPOKE_MARKER_END = "<!-- pi-docs:end -->";

export const MANAGED_BY = "pi-docs-extension";
export const MANIFEST_VERSION = 1;

// Canonical doc files created by init
export const CANONICAL_DOCS = [
	"README.md",
	"architecture.md",
	"dev-workflow.md",
	"conventions.md",
	"invariants.md",
	"traps.md",
] as const;

// ADR template file
export const ADR_TEMPLATE = "ADR-template.md";

// Session entry types
export const ENTRY_DOCS_STATE = "engineering-docs:state";
export const ENTRY_DOCS_REMINDER_SNOOZE = "engineering-docs:reminder-snooze";

// Workflow mode types (mirrored from workflow-modes)
export type WorkflowMode = "off" | "discuss" | "plan" | "build" | "review" | "design";

export interface WorkflowState {
	mode: WorkflowMode;
	hasPlan: boolean;
	plan?: string;
}

// Docs manifest schema
export interface DocsManifest {
	version: number;
	kind: "engineering-docs";
	managedBy: string;
	entrypoint: string;
	canonicalDocs: string[];
	generated: string[];
}

// ADR metadata (YAML-style frontmatter parsed from ADR files)
export interface ADRMetadata {
	id: string;
	title: string;
	status: "Proposed" | "Active" | "Superseded" | "Deprecated";
	date: string;
	decision: string[];
	why: string[];
	affectsDocs: string[];
	affectsCode: string[];
	consequencesGood: string[];
	consequencesBadRisk: string[];
	readWhen: string[];
	supersedes?: string;
}

// Valid docs area tags
export const DOCS_AREA_TAGS = [
	"architecture",
	"dev-workflow",
	"conventions",
	"invariants",
	"traps",
	"decisions",
] as const;

export type DocsAreaTag = (typeof DOCS_AREA_TAGS)[number];

export const ADR_ACTION_TAGS = ["new", "update", "supersede"] as const;
export type ADRActionTag = (typeof ADR_ACTION_TAGS)[number];

// File patterns to ignore for docs-relevant change tracking
export const IGNORE_PATTERNS = [
	/\/node_modules\//,
	/\/\.git\//,
	/\/dist\//,
	/\/build\//,
	/\/\.next\//,
	/\/coverage\//,
	/\/__pycache__\//,
	/\/\.cache\//,
	/\/logs?\//,
	/\.log$/,
	/\/tmp\//,
	/\/\.tmp\//,
	/\.min\.(js|css)$/,
	/\.map$/,
	/\.d\.ts$/,
	/\/docs\/engineering\//,  // Don't remind about docs changes themselves
] as const;
