import { useCallback, useEffect, useRef, useState } from "react";
import { checkForUpdate, getAppVersion, openExternal } from "../lib/commands";
import { loadLastUpdateCheck, saveLastUpdateCheck } from "../lib/store";
import { useToastStore } from "../stores/toast";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function useUpdateCheck(enabled: boolean) {
	const [dialogOpen, setDialogOpen] = useState(false);
	const [description, setDescription] = useState("");
	const [manualCheckInProgress, setManualCheckInProgress] = useState(false);
	const releaseUrlRef = useRef("");
	const inProgressRef = useRef(false);

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;

		(async () => {
			try {
				const lastCheck = await loadLastUpdateCheck();
				if (cancelled || Date.now() - lastCheck < CHECK_INTERVAL_MS) return;

				const currentVersion = await getAppVersion();
				if (cancelled) return;

				const info = await checkForUpdate(currentVersion);
				if (cancelled) return;

				await saveLastUpdateCheck(Date.now());
				if (cancelled) return;

				if (info.hasUpdate) {
					setDescription(
						`新しいバージョン v${info.latestVersion} が利用可能です（現在 v${info.currentVersion}）。GitHub Releases からダウンロードできます。`,
					);
					releaseUrlRef.current = info.releaseUrl;
					setDialogOpen(true);
				}
			} catch {
				// ネットワークエラー等はサイレントにスキップ
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [enabled]);

	const triggerManualCheck = useCallback(async () => {
		// 多重起動防止。state ではなく ref で判定して再レンダー間で race しないようにする。
		if (inProgressRef.current) return;
		inProgressRef.current = true;
		setManualCheckInProgress(true);
		try {
			const currentVersion = await getAppVersion();
			const info = await checkForUpdate(currentVersion);

			// lastCheck の永続化失敗は手動チェック結果の表示を阻害しない。
			void saveLastUpdateCheck(Date.now()).catch(() => {});

			if (info.hasUpdate) {
				setDescription(
					`新しいバージョン v${info.latestVersion} が利用可能です（現在 v${info.currentVersion}）。GitHub Releases からダウンロードできます。`,
				);
				releaseUrlRef.current = info.releaseUrl;
				setDialogOpen(true);
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
	}, []);

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
