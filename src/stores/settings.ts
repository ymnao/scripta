import { create } from "zustand";
import type { FontFamily, IndentSize } from "../lib/store";
import {
	saveAutoSaveDelay,
	saveFontFamily,
	saveFontSize,
	saveHighlightActiveLine,
	saveIndentSize,
	saveShowLineNumbers,
	saveTrimTrailingWhitespace,
} from "../lib/store";

interface SettingsState {
	showLineNumbers: boolean;
	fontSize: number;
	autoSaveDelay: number;
	indentSize: IndentSize;
	highlightActiveLine: boolean;
	fontFamily: FontFamily;
	trimTrailingWhitespace: boolean;
	setShowLineNumbers: (show: boolean) => void;
	setFontSize: (size: number) => void;
	setAutoSaveDelay: (delay: number) => void;
	setIndentSize: (size: IndentSize) => void;
	setHighlightActiveLine: (highlight: boolean) => void;
	setFontFamily: (family: FontFamily) => void;
	setTrimTrailingWhitespace: (trim: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()((set) => ({
	showLineNumbers: true,
	fontSize: 14,
	autoSaveDelay: 2000,
	indentSize: 2,
	highlightActiveLine: false,
	fontFamily: "monospace",
	trimTrailingWhitespace: true,
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
	setIndentSize: (size: IndentSize) => {
		void saveIndentSize(size);
		set({ indentSize: size });
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
}));
