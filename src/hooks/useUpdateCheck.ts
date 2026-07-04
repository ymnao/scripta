import { useCallback, useEffect, useRef, useState } from "react";
import { checkForUpdate, getAppVersion, openExternal } from "../lib/commands";
import { loadLastUpdateCheck, saveSetting } from "../lib/store";
import { useToastStore } from "../stores/toast";
import type { UpdateInfo } from "../types/update";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function formatUpdateDescription(info: UpdateInfo): string {
	return `新しいバージョン v${info.latestVersion} が利用可能です（現在 v${info.currentVersion}）。GitHub Releases からダウンロードできます。`;
}

export function useUpdateCheck(enabled: boolean) {
	const [dialogOpen, setDialogOpen] = useState(false);
	const [description, setDescription] = useState("");
	// state は UI 表示用、ref は trigger の race guard。React 19 でも StrictMode の
	// 二重起動下で state 経由だと set→read 間に gap があるため両方を併用する。
	const [manualCheckInProgress, setManualCheckInProgress] = useState(false);
	const releaseUrlRef = useRef("");
	const inProgressRef = useRef(false);

	// auto / manual 両経路から呼ばれる dialog state 更新の single entry point。
	// React setter は stable のため deps=[] で安定参照 (useEffect から呼ぶので memoize 必要)。
	const applyUpdateInfo = useCallback((info: UpdateInfo) => {
		setDescription(formatUpdateDescription(info));
		releaseUrlRef.current = info.releaseUrl;
		setDialogOpen(true);
	}, []);

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;

		void (async () => {
			try {
				const lastCheck = await loadLastUpdateCheck();
				if (cancelled || Date.now() - lastCheck < CHECK_INTERVAL_MS) return;

				const currentVersion = await getAppVersion();
				if (cancelled) return;

				const info = await checkForUpdate(currentVersion);
				if (cancelled) return;

				await saveSetting("lastUpdateCheck", Date.now());
				if (cancelled) return;

				if (info.hasUpdate) {
					applyUpdateInfo(info);
				}
			} catch {
				// ネットワークエラー等はサイレントにスキップ
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [enabled, applyUpdateInfo]);

	/**
	 * 手動アップデートチェック。`enabled` (= autoUpdateCheck トグル) に関係なく
	 * 常にネットワーク確認を行う (ユーザ明示操作なので auto 設定をオーバーライド)。
	 * 多重起動は ref で抑止し、結果は更新あり=ダイアログ / 最新=success toast /
	 * 失敗=error toast で通知する。24h timer も bump され、次回起動時の auto-check を
	 * 抑制する (意図的 — 直近で手動確認した直後の再チェックは不要)。
	 */
	const triggerManualCheck = async (): Promise<void> => {
		if (inProgressRef.current) return;
		inProgressRef.current = true;
		setManualCheckInProgress(true);
		try {
			const currentVersion = await getAppVersion();
			const info = await checkForUpdate(currentVersion);

			// lastCheck の永続化失敗は手動チェック結果の表示を阻害しない。
			void saveSetting("lastUpdateCheck", Date.now()).catch(() => {});

			if (info.hasUpdate) {
				applyUpdateInfo(info);
			} else {
				useToastStore
					.getState()
					.addToast("success", `お使いのバージョンは最新です (v${info.currentVersion})`);
			}
		} catch {
			useToastStore.getState().addToast("error", "アップデートの確認に失敗しました");
		} finally {
			inProgressRef.current = false;
			setManualCheckInProgress(false);
		}
	};

	const dismissDialog = () => setDialogOpen(false);
	const openReleasePage = () => {
		if (releaseUrlRef.current) {
			void openExternal(releaseUrlRef.current);
		}
		setDialogOpen(false);
	};

	return {
		dialogOpen,
		description,
		dismissDialog,
		openReleasePage,
		triggerManualCheck,
		manualCheckInProgress,
	};
}
