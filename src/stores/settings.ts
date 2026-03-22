import { create } from "zustand";
import type { FontFamily } from "../lib/store";
import {
	saveAutoSaveDelay,
	saveAutoUpdateCheck,
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
	/** Set state without persisting — used for initial hydration from store */
	hydrate: (values: Partial<SettingsValues>) => void;
}

export const useSettingsStore = create<SettingsState>()((set) => ({
	showLineNumbers: true,
	fontSize: 14,
	autoSaveDelay: 2000,
	highlightActiveLine: false,
	fontFamily: "monospace",
	trimTrailingWhitespace: true,
	showLinkCards: true,
	scratchpadVolatile: true,
	autoUpdateCheck: true,
	setShowLineNumbers: (show: boolean) => {
		void saveShowLineNumbers(show);
		set({ showLineNumbers: show });
	},
	setFontSize: (size: number) => {
		void saveFontSize(size);
		set({ fontSize: size });
	},
	setAutoSaveDelay: (delay: number) => {
		void saveAutoSaveDelay(delay);
		set({ autoSaveDelay: delay });
	},
	setHighlightActiveLine: (highlight: boolean) => {
		void saveHighlightActiveLine(highlight);
		set({ highlightActiveLine: highlight });
	},
	setFontFamily: (family: FontFamily) => {
		void saveFontFamily(family);
		set({ fontFamily: family });
	},
	setTrimTrailingWhitespace: (trim: boolean) => {
		void saveTrimTrailingWhitespace(trim);
		set({ trimTrailingWhitespace: trim });
	},
	setShowLinkCards: (show: boolean) => {
		void saveShowLinkCards(show);
		set({ showLinkCards: show });
	},
	setScratchpadVolatile: (volatile: boolean) => {
		void saveScratchpadVolatile(volatile);
		set({ scratchpadVolatile: volatile });
	},
	setAutoUpdateCheck: (enabled: boolean) => {
		void saveAutoUpdateCheck(enabled);
		set({ autoUpdateCheck: enabled });
	},
	hydrate: (values: Partial<SettingsValues>) => {
		set(values);
	},
}));
