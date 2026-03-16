export function Kbd({ children }: { children: string }) {
	return (
		<kbd className="inline-flex min-w-[20px] items-center justify-center rounded border border-border bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] leading-none text-text-secondary shadow-[0_1px_0_0_var(--color-border)]">
			{children}
		</kbd>
	);
}
