import { Kbd } from "../common/Kbd";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const mod = isMac ? "\u2318" : "Ctrl";
const shift = isMac ? "\u21E7" : "Shift";

const ASCII_ART = [
	"███████╗ ██████╗ ██████╗ ██╗██████╗ ████████╗ █████╗ ",
	"██╔════╝██╔════╝ ██╔══██╗██║██╔══██╗╚══██╔══╝██╔══██╗",
	"███████╗██║      ██████╔╝██║██████╔╝   ██║   ███████║",
	"╚════██║██║      ██╔══██╗██║██╔═══╝    ██║   ██╔══██║",
	"███████║╚██████╗ ██║  ██║██║██║        ██║   ██║  ██║",
	"╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝        ╚═╝   ╚═╝  ╚═╝",
].join("\n");

const quickActions = [
	{ keys: [mod, "P"], label: "ファイルを開く", action: "commandPalette", needsWorkspace: true },
	{
		keys: [mod, shift, "F"],
		label: "ワークスペース検索",
		action: "workspaceSearch",
		needsWorkspace: true,
	},
	{ keys: ["F1"], label: "ショートカット一覧", action: "help", needsWorkspace: false },
] as const;

const shortcuts = [
	{ keys: [mod, "T"], label: "新しいタブ" },
	{ keys: [mod, "S"], label: "保存" },
	{ keys: [mod, "B"], label: "サイドバー" },
	{ keys: [mod, "L"], label: "リスト切り替え" },
] as const;

interface NewTabContentProps {
	onAction: (action: "commandPalette" | "workspaceSearch" | "help") => void;
	hasWorkspace: boolean;
}

export function NewTabContent({ onAction, hasWorkspace }: NewTabContentProps) {
	return (
		<div className="flex h-full select-none flex-col items-center justify-center gap-10">
			<div className="flex flex-col items-center gap-2">
				<pre
					className="text-[11px]"
					role="img"
					aria-label="scripta"
					style={{
						lineHeight: 1,
						letterSpacing: "-0.05em",
						background: "#c86868",
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
						backgroundClip: "text",
					}}
				>
					{ASCII_ART}
				</pre>
				<p className="text-sm italic text-text-secondary/40">Verba volant, scripta manent.</p>
			</div>

			<div className="flex flex-col gap-6">
				<section className="flex flex-col gap-1.5">
					<h3 className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary/60">
						クイックアクション
					</h3>
					{quickActions
						.filter((item) => !item.needsWorkspace || hasWorkspace)
						.map((item) => (
							<button
								key={item.action}
								type="button"
								onClick={() => onAction(item.action)}
								className="flex items-center justify-between gap-6 rounded px-2 py-1 text-left text-xs text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
							>
								<span>{item.label}</span>
								<span className="flex items-center gap-0.5">
									{item.keys.map((key) => (
										<Kbd key={key}>{key}</Kbd>
									))}
								</span>
							</button>
						))}
				</section>

				<section className="flex flex-col gap-1.5">
					<h3 className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary/60">
						ショートカット
					</h3>
					{shortcuts.map((item) => (
						<div
							key={item.label}
							className="flex items-center justify-between gap-6 px-2 py-1 text-xs text-text-secondary"
						>
							<span>{item.label}</span>
							<span className="flex items-center gap-0.5">
								{item.keys.map((key) => (
									<Kbd key={key}>{key}</Kbd>
								))}
							</span>
						</div>
					))}
				</section>
			</div>
		</div>
	);
}
