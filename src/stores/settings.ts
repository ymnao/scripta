import { create } from "zustand";
import { DEFAULT_FILE_TREE_EXCLUDE_PATTERNS, type FontFamily, saveSetting } from "../lib/store";
import {
	SLIDE_PREVIEW_WIDTH_RATIO_DEFAULT,
	SLIDE_PREVIEW_WIDTH_RATIO_MAX,
	SLIDE_PREVIEW_WIDTH_RATIO_MIN,
	SLIDE_THUMBNAILS_VISIBLE_DEFAULT,
} from "../types/slide";
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
	slidePreviewWidthRatio: number;
	slideThumbnailsVisible: boolean;
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
	setSlidePreviewWidthRatio: (ratio: number) => void;
	setSlideThumbnailsVisible: (visible: boolean) => void;
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
		slidePreviewWidthRatio: SLIDE_PREVIEW_WIDTH_RATIO_DEFAULT,
		slideThumbnailsVisible: SLIDE_THUMBNAILS_VISIBLE_DEFAULT,
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
		// writer 側で clamp。ここが SoT なので future caller (migration / IPC / 別コンポーネント等)
		// が範囲外を書いても disk に out-of-range が漏れず、次回 loadSettings で default fallback
		// して preference が消える事故を防ぐ。
		setSlidePreviewWidthRatio: persist("slidePreviewWidthRatio", (ratio) =>
			Math.min(SLIDE_PREVIEW_WIDTH_RATIO_MAX, Math.max(SLIDE_PREVIEW_WIDTH_RATIO_MIN, ratio)),
		),
		setSlideThumbnailsVisible: persist("slideThumbnailsVisible"),
		hydrate: (values: Partial<SettingsValues>) => {
			set(values);
		},
	};
});
