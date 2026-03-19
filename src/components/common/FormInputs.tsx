import { useEffect, useRef, useState } from "react";

interface ToggleProps {
	id: string;
	label: string;
	checked: boolean;
	onChange: (value: boolean) => void;
	size?: "sm" | "md";
}

export function Toggle({ id, label, checked, onChange, size = "md" }: ToggleProps) {
	const sm = size === "sm";
	return (
		<div className="flex items-center justify-between rounded-md bg-bg-secondary px-3 py-2">
			<label htmlFor={id} className="text-xs font-medium text-text-primary">
				{label}
			</label>
			<button
				id={id}
				type="button"
				role="switch"
				aria-checked={checked}
				className={`relative shrink-0 rounded-full transition-colors ${
					checked ? "bg-blue-600" : "bg-black/20 dark:bg-white/20"
				} ${sm ? "h-4 w-7" : "h-5 w-9"}`}
				onClick={() => onChange(!checked)}
			>
				<span
					className={`absolute top-0.5 left-0.5 rounded-full bg-white shadow transition-transform ${
						sm ? "h-3 w-3" : "h-4 w-4"
					} ${checked ? (sm ? "translate-x-3" : "translate-x-4") : "translate-x-0"}`}
				/>
			</button>
		</div>
	);
}

export function NumberInput({
	id,
	label,
	value,
	min,
	max,
	step,
	unit,
	onChange,
}: {
	id: string;
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	unit: string;
	onChange: (value: number) => void;
}) {
	const [draft, setDraft] = useState(String(value));

	useEffect(() => {
		setDraft(String(value));
	}, [value]);

	const commit = () => {
		const num = Number(draft);
		if (!Number.isNaN(num)) {
			const clamped = Math.min(max, Math.max(min, num));
			onChange(clamped);
			setDraft(String(clamped));
		} else {
			setDraft(String(value));
		}
	};

	return (
		<div className="flex items-center justify-between rounded-md bg-bg-secondary px-3 py-2">
			<label htmlFor={id} className="text-xs font-medium text-text-primary">
				{label}
			</label>
			<div className="flex items-center gap-1.5">
				<input
					id={id}
					type="number"
					min={min}
					max={max}
					step={step}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commit}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.currentTarget.blur();
						}
					}}
					className="w-16 rounded border border-border bg-bg-primary px-2 py-0.5 text-right text-xs text-text-primary outline-none focus:border-blue-500"
				/>
				<span className="text-[10px] text-text-secondary">{unit}</span>
			</div>
		</div>
	);
}

export function SelectInput<T extends string | number>({
	id,
	label,
	value,
	options,
	onChange,
}: {
	id: string;
	label: string;
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
}) {
	return (
		<div className="flex items-center justify-between rounded-md bg-bg-secondary px-3 py-2">
			<label htmlFor={id} className="text-xs font-medium text-text-primary">
				{label}
			</label>
			<select
				id={id}
				value={String(value)}
				onChange={(e) => {
					const raw = e.target.value;
					const match = options.find((o) => String(o.value) === raw);
					if (match) onChange(match.value);
				}}
				className="rounded border border-border bg-bg-primary px-2 py-0.5 text-xs text-text-primary outline-none focus:border-blue-500"
			>
				{options.map((opt) => (
					<option key={String(opt.value)} value={String(opt.value)}>
						{opt.label}
					</option>
				))}
			</select>
		</div>
	);
}

export function TextInput({
	id,
	label,
	value,
	onChange,
	disabled,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
}) {
	const [draft, setDraft] = useState(value);
	const draftRef = useRef(draft);
	const valueRef = useRef(value);

	useEffect(() => {
		setDraft(value);
		valueRef.current = value;
	}, [value]);

	useEffect(() => {
		draftRef.current = draft;
	}, [draft]);

	// Commit unsaved draft on unmount (e.g. dialog closed via Esc)
	useEffect(() => {
		return () => {
			if (draftRef.current !== valueRef.current) {
				onChange(draftRef.current);
			}
		};
	}, [onChange]);

	const commit = () => {
		if (draft !== value) {
			onChange(draft);
		}
	};

	return (
		<div className="flex items-center justify-between rounded-md bg-bg-secondary px-3 py-2">
			<label htmlFor={id} className="shrink-0 text-xs font-medium text-text-primary">
				{label}
			</label>
			<input
				id={id}
				type="text"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.currentTarget.blur();
					}
				}}
				disabled={disabled}
				className="ml-2 min-w-0 flex-1 rounded border border-border bg-bg-primary px-2 py-0.5 text-xs text-text-primary outline-none focus:border-blue-500 disabled:opacity-50"
			/>
		</div>
	);
}

export function RangeInput({
	id,
	label,
	value,
	min,
	max,
	step,
	unit,
	onChange,
}: {
	id: string;
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	unit: string;
	onChange: (value: number) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);

	const handleSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
		setDraft(null);
		onChange(Number(e.target.value));
	};

	const handleBlur = () => {
		if (draft !== null) {
			const raw = Number.parseInt(draft, 10);
			if (!Number.isNaN(raw)) {
				onChange(Math.min(max, Math.max(min, raw)));
			}
			setDraft(null);
		}
	};

	return (
		<div className="flex items-center justify-between gap-3 rounded-md bg-bg-secondary px-3 py-2">
			<label htmlFor={id} className="shrink-0 text-xs font-medium text-text-primary">
				{label}
			</label>
			<div className="flex items-center gap-2">
				<input
					id={id}
					type="range"
					min={min}
					max={max}
					step={step}
					value={value}
					onChange={handleSlider}
					className="h-1 w-20 cursor-pointer accent-blue-600"
				/>
				<div className="flex items-center gap-0.5">
					<input
						type="text"
						inputMode="numeric"
						value={draft ?? value}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={handleBlur}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
						aria-label={`${label}の値`}
						className="w-10 rounded border border-border bg-bg-primary px-1 py-0.5 text-right text-xs tabular-nums text-text-primary outline-none focus:border-blue-500"
					/>
					<span className="text-xs text-text-secondary">{unit}</span>
				</div>
			</div>
		</div>
	);
}
