const isMac = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

export function TabBar() {
	return (
		<div
			data-tauri-drag-region
			className={`flex h-7 shrink-0 items-center border-b border-border bg-bg-primary ${isMac ? "pl-20" : ""} text-text-secondary`}
		>
			{/* タブがここに並ぶ */}
		</div>
	);
}
