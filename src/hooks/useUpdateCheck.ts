import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useRef, useState } from "react";
import { checkForUpdate, openExternal } from "../lib/commands";
import { loadLastUpdateCheck, saveLastUpdateCheck } from "../lib/store";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function useUpdateCheck(enabled: boolean) {
	const [dialogOpen, setDialogOpen] = useState(false);
	const [description, setDescription] = useState("");
	const releaseUrlRef = useRef("");

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;

		(async () => {
			try {
				const lastCheck = await loadLastUpdateCheck();
				if (Date.now() - lastCheck < CHECK_INTERVAL_MS) return;

				const currentVersion = await getVersion();
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

	const dismissDialog = () => setDialogOpen(false);
	const openReleasePage = () => {
		if (releaseUrlRef.current) {
			void openExternal(releaseUrlRef.current);
		}
		setDialogOpen(false);
	};

	return { dialogOpen, description, dismissDialog, openReleasePage };
}
