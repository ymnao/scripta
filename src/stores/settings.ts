import { create } from "zustand";
import { DEFAULT_FILE_TREE_EXCLUDE_PATTERNS, type FontFamily, saveSetting } from "../lib/store";
import { createPersistedSetter } from "./store-helpers";

interface SettingsValues {
	showLineNumbers: boolean;
	fontSize: number;
	autoSaveDelay: number;
	highlightActiveLine: boolean;
	fontFamily: FontFamily;
	trimTrailingWhitespace: boolean;
	showLinkCards: boolean;
	scratchpadVolatile: boolean;
	autoUpdateCheck: boolean;
	fileTreeShowHidden: boolean;
	fileTreeExcludePatterns: string;
}

interface SettingsState extends SettingsValues {
	setShowLineNumbers: (show: boolean) => void;
	setFontSize: (size: number) => void;
	setAutoSaveDelay: (delay: number) => void;
	setHighlightActiveLine: (highlight: boolean) => void;
	setFontFamily: (family: FontFamily) => void;
	setTrimTrailingWhitespace: (trim: boolean) => void;
	setShowLinkCards: (show: boolean) => void;
	setScratchpadVolatile: (volatile: boolean) => void;
	setAutoUpdateCheck: (enabled: boolean) => void;
	setFileTreeShowHidden: (show: boolean) => void;
	setFileTreeExcludePatterns: (patterns: string) => void;
	/** Set state without persisting — used for initial hydration from store */
	hydrate: (values: Partial<SettingsValues>) => void;
}

export const useSettingsStore = create<SettingsState>()((set) => {
	const persist = createPersistedSetter<SettingsValues>(set, saveSetting);
	return {
		showLineNumbers: true,
		fontSize: 14,
		autoSaveDelay: 2000,
		highlightActiveLine: false,
		fontFamily: "monospace",
		trimTrailingWhitespace: true,
		showLinkCards: true,
		scratchpadVolatile: true,
		autoUpdateCheck: true,
		fileTreeShowHidden: false,
		fileTreeExcludePatterns: DEFAULT_FILE_TREE_EXCLUDE_PATTERNS,
		setShowLineNumbers: persist("showLineNumbers"),
		setFontSize: persist("fontSize"),
		setAutoSaveDelay: persist("autoSaveDelay"),
		setHighlightActiveLine: persist("highlightActiveLine"),
		setFontFamily: persist("fontFamily"),
		setTrimTrailingWhitespace: persist("trimTrailingWhitespace"),
		setShowLinkCards: persist("showLinkCards"),
		setScratchpadVolatile: persist("scratchpadVolatile"),
		setAutoUpdateCheck: persist("autoUpdateCheck"),
		setFileTreeShowHidden: persist("fileTreeShowHidden"),
		setFileTreeExcludePatterns: persist("fileTreeExcludePatterns"),
		hydrate: (values: Partial<SettingsValues>) => {
			set(values);
		},
	};
});
