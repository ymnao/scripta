import type { ReactNode } from "react";

interface Section {
	key: string;
	label: string;
}

interface SidebarDialogLayoutProps {
	sections: Section[];
	activeSection: string;
	onSectionChange: (key: string) => void;
	navAriaLabel: string;
	contentSpacing?: "tight" | "normal";
	children: ReactNode;
}

export function SidebarDialogLayout({
	sections,
	activeSection,
	onSectionChange,
	navAriaLabel,
	contentSpacing = "normal",
	children,
}: SidebarDialogLayoutProps) {
	return (
		<div className="mt-4 flex min-h-0 flex-1 gap-4">
			<nav className="w-36 shrink-0 space-y-0.5" aria-label={navAriaLabel}>
				{sections.map((s) => (
					<button
						key={s.key}
						type="button"
						onClick={() => onSectionChange(s.key)}
						className={`w-full rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
							activeSection === s.key
								? "bg-blue-600 text-white"
								: "text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
						}`}
					>
						{s.label}
					</button>
				))}
			</nav>
			<div
				className={`min-w-0 flex-1 overflow-y-auto ${contentSpacing === "tight" ? "space-y-2" : "space-y-3"}`}
			>
				{children}
			</div>
		</div>
	);
}
