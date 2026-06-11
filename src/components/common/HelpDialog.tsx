import { X } from "lucide-react";
import { useId } from "react";
import { MOD_KEY_LABEL, SHIFT_KEY_LABEL } from "../../lib/platform";
import { DialogBase } from "./DialogBase";
import { Kbd } from "./Kbd";

interface HelpDialogProps {
	open: boolean;
	onClose: () => void;
}

interface ShortcutGroup {
	title: string;
	shortcuts: { keys: string[][]; action: string }[];
}

const groups: ShortcutGroup[] = [
	{
		title: "書式",
		shortcuts: [
			{ keys: [[MOD_KEY_LABEL, "B"]], action: "太字（エディタ内）" },
			{ keys: [[MOD_KEY_LABEL, "I"]], action: "斜体" },
			{ keys: [[MOD_KEY_LABEL, SHIFT_KEY_LABEL, "X"]], action: "取り消し線" },
			{ keys: [[MOD_KEY_LABEL, "1\u20136"]], action: "見出し 1\u20136" },
			{ keys: [[MOD_KEY_LABEL, "L"]], action: "リストの切り替え" },
			{ keys: [[MOD_KEY_LABEL, SHIFT_KEY_LABEL, "L"]], action: "チェックボックスの切り替え" },
			{ keys: [[MOD_KEY_LABEL, "\u21A9"]], action: "チェック / チェック解除" },
			{ keys: [[MOD_KEY_LABEL, SHIFT_KEY_LABEL, "T"]], action: "テーブルを挿入" },
		],
	},
	{
		title: "ファイル",
		shortcuts: [
			{ keys: [[MOD_KEY_LABEL, "S"]], action: "保存" },
			{ keys: [[MOD_KEY_LABEL, "T"]], action: "新しいタブ" },
			{ keys: [[MOD_KEY_LABEL, "W"]], action: "タブを閉じる" },
			{
				keys: [
					[MOD_KEY_LABEL, "["],
					["Alt", "\u2190"],
				],
				action: "戻る",
			},
			{
				keys: [
					[MOD_KEY_LABEL, "]"],
					["Alt", "\u2192"],
				],
				action: "進む",
			},
		],
	},
	{
		title: "ナビゲーション",
		shortcuts: [
			{ keys: [[MOD_KEY_LABEL, SHIFT_KEY_LABEL, "["]], action: "前のタブ" },
			{ keys: [[MOD_KEY_LABEL, SHIFT_KEY_LABEL, "]"]], action: "次のタブ" },
			{ keys: [[MOD_KEY_LABEL, "G"]], action: "指定行へジャンプ" },
		],
	},
	{
		title: "検索",
		shortcuts: [
			{ keys: [[MOD_KEY_LABEL, "F"]], action: "検索" },
			{ keys: [[MOD_KEY_LABEL, "H"]], action: "置換" },
			{ keys: [[MOD_KEY_LABEL, "P"]], action: "コマンドパレット" },
			{ keys: [[MOD_KEY_LABEL, SHIFT_KEY_LABEL, "F"]], action: "ワークスペース検索" },
		],
	},
	{
		title: "表示",
		shortcuts: [
			{ keys: [[MOD_KEY_LABEL, "/"]], action: "サイドバーの切り替え" },
			{ keys: [[MOD_KEY_LABEL, SHIFT_KEY_LABEL, "S"]], action: "スライドビュー" },
			{ keys: [[MOD_KEY_LABEL, "J"]], action: "スクラッチパッド" },
			{ keys: [[MOD_KEY_LABEL, "E"]], action: "ファイルエクスプローラー" },
			{ keys: [[MOD_KEY_LABEL, SHIFT_KEY_LABEL, "E"]], action: "エクスポート" },
			{ keys: [[MOD_KEY_LABEL, SHIFT_KEY_LABEL, "U"]], action: "未解決リンク" },
			{ keys: [[MOD_KEY_LABEL, ","]], action: "設定" },
			{ keys: [["F1"]], action: "ヘルプ" },
		],
	},
];

function KeyCombo({ keys }: { keys: string[][] }) {
	return (
		<span className="inline-flex items-center gap-1">
			{keys.map((combo, ci) => (
				<span key={combo.join("+")} className="inline-flex items-center gap-0.5">
					{ci > 0 && <span className="mx-0.5 text-text-secondary">/</span>}
					{combo.map((key) => (
						<Kbd key={key}>{key}</Kbd>
					))}
				</span>
			))}
		</span>
	);
}

export function HelpDialog({ open, onClose }: HelpDialogProps) {
	const titleId = useId();

	return (
		<DialogBase open={open} onClose={onClose} ariaLabelledBy={titleId} size="md" fixedHeight>
			<div className="flex shrink-0 items-center justify-between">
				<h2 id={titleId} className="text-sm font-semibold text-text-primary">
					キーボードショートカット
				</h2>
				<button
					type="button"
					onClick={onClose}
					aria-label="閉じる"
					className="rounded p-0.5 text-text-secondary hover:bg-black/10 hover:text-text-primary dark:hover:bg-white/10"
				>
					<X size={16} />
				</button>
			</div>

			<div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto">
				{groups.map((group) => (
					<section key={group.title}>
						<h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
							{group.title}
						</h3>
						<div className="space-y-1">
							{group.shortcuts.map((s) => (
								<div
									key={s.action}
									className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-bg-secondary"
								>
									<span className="text-xs text-text-primary">{s.action}</span>
									<KeyCombo keys={s.keys} />
								</div>
							))}
						</div>
					</section>
				))}
			</div>
		</DialogBase>
	);
}
