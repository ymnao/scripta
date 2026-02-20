import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
	id: string;
	label: string;
	onClick: () => void;
	danger?: boolean;
	separator?: boolean;
}

interface ContextMenuProps {
	position: { x: number; y: number };
	items: ContextMenuItem[];
	onClose: () => void;
}

export function ContextMenu({ position, items, onClose }: ContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [adjustedPos, setAdjustedPos] = useState(position);

	useLayoutEffect(() => {
		const el = menuRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const x = Math.min(position.x, window.innerWidth - rect.width - 4);
		const y = Math.min(position.y, window.innerHeight - rect.height - 4);
		setAdjustedPos({ x: Math.max(0, x), y: Math.max(0, y) });
	}, [position]);

	useEffect(() => {
		const handleClick = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		};
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		const handleScroll = () => onClose();

		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleKey);
		document.addEventListener("scroll", handleScroll, true);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleKey);
			document.removeEventListener("scroll", handleScroll, true);
		};
	}, [onClose]);

	return createPortal(
		<div
			ref={menuRef}
			role="menu"
			className="fixed z-50 min-w-36 rounded-md border border-border bg-bg-primary py-1 shadow-lg"
			style={{ left: adjustedPos.x, top: adjustedPos.y }}
		>
			{items.map((item) =>
				item.separator ? (
					<hr key={item.id} className="my-1 border-t border-border" />
				) : (
					<button
						key={item.id}
						type="button"
						role="menuitem"
						className={`w-full px-3 py-1.5 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 ${
							item.danger ? "text-red-500" : "text-text-primary"
						}`}
						onClick={() => {
							item.onClick();
							onClose();
						}}
					>
						{item.label}
					</button>
				),
			)}
		</div>,
		document.body,
	);
}
