import { create } from "zustand";
import { scanUnresolvedWikilinks } from "../lib/commands";
import { basename } from "../lib/path";
import type { UnresolvedWikilink, WikilinkReference } from "../types/wikilink";
import { createScanAction } from "./createScanAction";

export function buildInitialContent(
	pageName: string,
	draft: string,
	references: WikilinkReference[],
): string {
	let content = `# ${pageName}\n\n`;
	if (draft) {
		content += `${draft}\n\n`;
	}
	if (references.length > 0) {
		content += "---\n\n> **参照元コンテキスト**\n>\n";
		for (const ref of references) {
			const fileName = basename(ref.filePath);
			content += `> _${fileName} (行 ${ref.lineNumber}):_\n`;
			content += `> ${ref.lineContent.trim()}\n>\n`;
		}
	}
	return content;
}

export interface CreateTarget {
	pageName: string;
	references: WikilinkReference[];
}

interface WikilinkState {
	unresolvedLinks: UnresolvedWikilink[];
	drafts: Record<string, string>;
	loading: boolean;
	sortBy: "name" | "count";
	createTarget: CreateTarget | null;
	_scanId: number;

	scan: (workspacePath: string) => Promise<void>;
	setDraft: (pageName: string, content: string) => void;
	getDraft: (pageName: string) => string;
	removeDraft: (pageName: string) => void;
	setSortBy: (sortBy: "name" | "count") => void;
	setCreateTarget: (pageName: string, references: WikilinkReference[]) => void;
	clearCreateTarget: () => void;
	reset: () => void;
}

export const useWikilinkStore = create<WikilinkState>()((set, get) => ({
	unresolvedLinks: [],
	drafts: {},
	loading: false,
	sortBy: "name",
	createTarget: null,
	_scanId: 0,

	scan: createScanAction<WikilinkState, [string], UnresolvedWikilink[]>({
		api: () => scanUnresolvedWikilinks,
		applyResult: (links) => ({ unresolvedLinks: links }),
		errorMessage: "Failed to scan unresolved wikilinks:",
	})(set, get),

	setDraft: (pageName: string, content: string) => {
		set((state) => ({
			drafts: { ...state.drafts, [pageName]: content },
		}));
	},

	getDraft: (pageName: string) => {
		return get().drafts[pageName] ?? "";
	},

	removeDraft: (pageName: string) => {
		set((state) => {
			const { [pageName]: _, ...rest } = state.drafts;
			return { drafts: rest };
		});
	},

	setSortBy: (sortBy: "name" | "count") => {
		set({ sortBy });
	},

	setCreateTarget: (pageName: string, references: WikilinkReference[]) => {
		set({ createTarget: { pageName, references } });
	},

	clearCreateTarget: () => {
		set({ createTarget: null });
	},

	reset: () => {
		set({
			unresolvedLinks: [],
			drafts: {},
			loading: false,
			createTarget: null,
			_scanId: get()._scanId + 1,
		});
	},
}));
