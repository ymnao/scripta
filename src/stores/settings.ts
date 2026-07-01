import { create } from "zustand";
import {
	DEFAULT_FILE_TREE_EXCLUDE_PATTERNS,
	type FontFamily,
	saveAutoSaveDelay,
	saveAutoUpdateCheck,
	saveFileTreeExcludePatterns,
	saveFileTreeShowHidden,
	saveFontFamily,
	saveFontSize,
	saveHighlightActiveLine,
	saveScratchpadVolatile,
	saveShowLineNumbers,
	saveShowLinkCards,
	saveTrimTrailingWhitespace,
} from "../lib/store";

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
	const makeSetter =
		<K extends keyof SettingsValues>(key: K, save: (value: SettingsValues[K]) => Promise<void>) =>
		(value: SettingsValues[K]) => {
			void save(value);
			set({ [key]: value } as Partial<SettingsState>);
		};

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
		setShowLineNumbers: makeSetter("showLineNumbers", saveShowLineNumbers),
		setFontSize: makeSetter("fontSize", saveFontSize),
		setAutoSaveDelay: makeSetter("autoSaveDelay", saveAutoSaveDelay),
		setHighlightActiveLine: makeSetter("highlightActiveLine", saveHighlightActiveLine),
		setFontFamily: makeSetter("fontFamily", saveFontFamily),
		setTrimTrailingWhitespace: makeSetter("trimTrailingWhitespace", saveTrimTrailingWhitespace),
		setShowLinkCards: makeSetter("showLinkCards", saveShowLinkCards),
		setScratchpadVolatile: makeSetter("scratchpadVolatile", saveScratchpadVolatile),
		setAutoUpdateCheck: makeSetter("autoUpdateCheck", saveAutoUpdateCheck),
		setFileTreeShowHidden: makeSetter("fileTreeShowHidden", saveFileTreeShowHidden),
		setFileTreeExcludePatterns: makeSetter("fileTreeExcludePatterns", saveFileTreeExcludePatterns),
		hydrate: (values: Partial<SettingsValues>) => {
			set(values);
		},
	};
});
