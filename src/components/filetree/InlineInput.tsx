import { File, Folder } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface InlineInputProps {
	depth: number;
	defaultValue?: string;
	icon: "file" | "folder";
	onConfirm: (value: string) => void;
	onCancel: () => void;
}

export function InlineInput({
	depth,
	defaultValue = "",
	icon,
	onConfirm,
	onCancel,
}: InlineInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(defaultValue);
	const settledRef = useRef(false);

	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);

	const handleConfirm = () => {
		if (settledRef.current) return;
		const trimmed = value.trim();
		if (trimmed) {
			settledRef.current = true;
			onConfirm(trimmed);
		} else {
			settledRef.current = true;
			onCancel();
		}
	};

	const handleCancel = () => {
		if (settledRef.current) return;
		settledRef.current = true;
		onCancel();
	};

	const IconComponent = icon === "folder" ? Folder : File;

	return (
		<li
			className="flex items-center gap-1 px-1 py-0.5"
			style={{ paddingLeft: `${depth * 16 + 4}px` }}
		>
			<span className="inline-block w-3.5 shrink-0" />
			<IconComponent size={14} className="shrink-0 text-text-secondary" />
			<input
				ref={inputRef}
				type="text"
				aria-label={defaultValue ? "Rename" : `New ${icon} name`}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						handleConfirm();
					} else if (e.key === "Escape") {
						e.preventDefault();
						handleCancel();
					}
				}}
				onBlur={handleConfirm}
				className="min-w-0 flex-1 rounded border border-border bg-bg-primary px-1 text-sm text-text-primary outline-none focus:border-blue-500"
			/>
		</li>
	);
}
