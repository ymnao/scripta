import type { ExternalFileConflictState } from "../../hooks/useExternalFileConflict";
import { basename } from "../../lib/path";
import { Dialog } from "../common/Dialog";

interface AppNotificationDialogsProps {
	updateDialogOpen: boolean;
	updateDescription: string;
	onUpdateConfirm: () => void;
	onUpdateCancel: () => void;
	externalConflict: ExternalFileConflictState;
}

export function AppNotificationDialogs({
	updateDialogOpen,
	updateDescription,
	onUpdateConfirm,
	onUpdateCancel,
	externalConflict: {
		externalConflict,
		handleConflictReload,
		handleConflictKeep,
		handleDeletedDirtyDiscard,
		handleDeletedDirtyKeep,
	},
}: AppNotificationDialogsProps) {
	return (
		<>
			<Dialog
				open={updateDialogOpen}
				title="アップデートのお知らせ"
				description={updateDescription}
				confirmLabel="ダウンロードページを開く"
				cancelLabel="後で"
				onConfirm={onUpdateConfirm}
				onCancel={onUpdateCancel}
			/>

			<Dialog
				open={externalConflict?.type === "modified"}
				title="ファイルが外部で変更されました"
				description={`「${externalConflict ? basename(externalConflict.path) : ""}」がエディタの外部で変更されました。未保存の変更があります。`}
				confirmLabel="再読み込み"
				cancelLabel="自分の変更を保持"
				onConfirm={handleConflictReload}
				onCancel={handleConflictKeep}
			/>

			<Dialog
				open={externalConflict?.type === "deleted"}
				title="ファイルが外部で削除されました"
				description={`「${externalConflict ? basename(externalConflict.path) : ""}」がエディタの外部で削除されました。未保存の変更があります。`}
				confirmLabel="破棄"
				cancelLabel="編集を続ける"
				onConfirm={handleDeletedDirtyDiscard}
				onCancel={handleDeletedDirtyKeep}
			/>
		</>
	);
}
