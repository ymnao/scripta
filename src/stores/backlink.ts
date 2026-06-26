import { create } from "zustand";
import { scanBacklinks } from "../lib/commands";
import type { BacklinkSource } from "../types/wikilink";
import { createScanAction } from "./createScanAction";

interface BacklinkState {
	backlinks: BacklinkSource[];
	loading: boolean;
	currentTargetPath: string | null;
	_scanId: number;

	scan: (workspacePath: string, targetFilePath: string) => Promise<void>;
	reset: () => void;
}

export const useBacklinkStore = create<BacklinkState>()((set, get) => ({
	backlinks: [],
	loading: false,
	currentTargetPath: null,
	_scanId: 0,

	scan: createScanAction<BacklinkState, [string, string], BacklinkSource[]>({
		api: () => scanBacklinks,
		applyResult: (links) => ({ backlinks: links }),
		errorMessage: "Failed to scan backlinks:",
		// 別ターゲットへ切り替わった瞬間に古い結果を消し、UI で混同を防ぐ。
		// 同一ターゲットの再スキャン中は前回結果を残し、loading インジケータだけ出す。
		beforeScan: (state, [_workspacePath, targetFilePath]) => ({
			currentTargetPath: targetFilePath,
			...(state.currentTargetPath !== targetFilePath ? { backlinks: [] } : {}),
		}),
	})(set, get),

	reset: () => {
		set({
			backlinks: [],
			loading: false,
			currentTargetPath: null,
			_scanId: get()._scanId + 1,
		});
	},
}));
