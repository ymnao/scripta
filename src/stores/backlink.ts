import { create } from "zustand";
import { scanBacklinks } from "../lib/commands";
import type { BacklinkSource } from "../types/wikilink";

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

	scan: async (workspacePath: string, targetFilePath: string) => {
		const scanId = get()._scanId + 1;
		// 別ターゲットへ切り替わった瞬間に古い結果を消し、UI で混同を防ぐ。
		// 同一ターゲットの再スキャン中は前回結果を残し、loading インジケータだけ出す。
		const targetChanged = get().currentTargetPath !== targetFilePath;
		set({
			loading: true,
			_scanId: scanId,
			currentTargetPath: targetFilePath,
			...(targetChanged ? { backlinks: [] } : {}),
		});
		try {
			const links = await scanBacklinks(workspacePath, targetFilePath);
			// 古いリクエストの結果は破棄する
			if (get()._scanId !== scanId) return;
			set({ backlinks: links, loading: false });
		} catch (error) {
			if (get()._scanId !== scanId) return;
			console.error("Failed to scan backlinks:", error);
			set({ loading: false });
		}
	},

	reset: () => {
		set({
			backlinks: [],
			loading: false,
			currentTargetPath: null,
			_scanId: get()._scanId + 1,
		});
	},
}));
