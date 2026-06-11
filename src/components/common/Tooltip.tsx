import {
	cloneElement,
	type FocusEvent,
	type HTMLAttributes,
	type MouseEvent,
	type PointerEvent,
	type ReactElement,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./Kbd";

interface TooltipProps {
	/** 機能名（例: "サイドバー"） */
	label: string;
	/** ショートカットのキー表示列（platform 反映済み。例: ["⌘", "/"]）。省略時は label のみ表示 */
	keys?: string[];
	/** tooltip を出す側。既定 "top"（StatusBar 用）。画面上部のボタンは "bottom" */
	side?: "top" | "bottom";
	/** トリガー要素（button 1 個） */
	children: ReactElement<HTMLAttributes<HTMLElement>>;
}

interface AnchorRect {
	left: number;
	width: number;
	top: number;
	bottom: number;
}

const VIEWPORT_MARGIN = 4;
const GAP = 6;

/**
 * アイコンボタンのホバー / フォーカス時に機能名 + ショートカットを表示するカスタム tooltip。
 *
 * cloneElement で children に props を合成注入し、wrapper 要素は作らない（flex レイアウト内の
 * ボタンに DOM を足すとレイアウトが崩れるため）。tooltip 本体は createPortal で document.body に
 * `position: fixed` で描画する。
 */
export function Tooltip({ label, keys, side = "top", children }: TooltipProps) {
	const id = useId();
	const [anchor, setAnchor] = useState<AnchorRect | null>(null);
	const triggerRef = useRef<HTMLElement | null>(null);
	const tooltipRef = useRef<HTMLDivElement | null>(null);
	// pointer 由来の focus 直後に tooltip を再表示しないためのフラグ。
	const pointerDownRef = useRef(false);
	// clamp 後の left（描画後に useLayoutEffect で補正する）。
	const [left, setLeft] = useState(0);

	const show = useCallback(() => {
		const trigger = triggerRef.current;
		if (!trigger) return;
		const rect = trigger.getBoundingClientRect();
		setAnchor({
			left: rect.left,
			width: rect.width,
			top: rect.top,
			bottom: rect.bottom,
		});
	}, []);

	const hide = useCallback(() => {
		setAnchor(null);
	}, []);

	// 表示中のみ Escape で非表示。stopPropagation はしない（検索バーの Esc 閉じ等を妨げない）。
	useEffect(() => {
		if (!anchor) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") hide();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [anchor, hide]);

	// 中央 X 基準の初期 left を anchor から算出。
	const centerX = anchor ? anchor.left + anchor.width / 2 : 0;

	// 描画後に実測幅で横方向 viewport clamp。useLayoutEffect は paint 前に走るのでチラつかない。
	useLayoutEffect(() => {
		if (!anchor) return;
		const el = tooltipRef.current;
		if (!el) {
			setLeft(centerX);
			return;
		}
		const width = el.offsetWidth;
		const halfWidth = width / 2;
		let next = centerX;
		const min = VIEWPORT_MARGIN + halfWidth;
		const max = window.innerWidth - VIEWPORT_MARGIN - halfWidth;
		if (next < min) next = min;
		if (next > max) next = max;
		setLeft(next);
	}, [anchor, centerX]);

	const mergeHandlers = <E,>(
		injected: (e: E) => void,
		existing?: (e: E) => void,
	): ((e: E) => void) => {
		return (e: E) => {
			injected(e);
			existing?.(e);
		};
	};

	const childProps = children.props;

	const injectedProps: HTMLAttributes<HTMLElement> & { ref: (node: HTMLElement | null) => void } = {
		// children 側が ref を持つ場合は上書きしてしまう（現状の適用先は ref 非使用）。
		ref: (node: HTMLElement | null) => {
			triggerRef.current = node;
		},
		onMouseEnter: mergeHandlers<MouseEvent<HTMLElement>>(show, childProps.onMouseEnter),
		onMouseLeave: mergeHandlers<MouseEvent<HTMLElement>>(hide, childProps.onMouseLeave),
		onPointerDown: (e: PointerEvent<HTMLElement>) => {
			pointerDownRef.current = true;
			hide();
			childProps.onPointerDown?.(e);
		},
		onFocus: (e: FocusEvent<HTMLElement>) => {
			// pointer 由来の focus では表示しない（キーボードフォーカスのみ表示）。
			if (pointerDownRef.current) {
				pointerDownRef.current = false;
			} else {
				show();
			}
			childProps.onFocus?.(e);
		},
		onBlur: mergeHandlers<FocusEvent<HTMLElement>>(hide, childProps.onBlur),
	};

	// tooltip 表示中のみ aria-describedby を注入（非表示中に付けると空参照で invalid）。
	if (anchor) {
		injectedProps["aria-describedby"] = id;
	}

	const trigger = cloneElement(children, injectedProps);

	return (
		<>
			{trigger}
			{anchor
				? createPortal(
						<div
							ref={tooltipRef}
							role="tooltip"
							id={id}
							className="pointer-events-none fixed z-[60] flex animate-tooltip-in items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary shadow-md"
							style={
								side === "top"
									? {
											left,
											top: anchor.top - GAP,
											transform: "translate(-50%, -100%)",
										}
									: {
											left,
											top: anchor.bottom + GAP,
											transform: "translate(-50%, 0)",
										}
							}
						>
							<span>{label}</span>
							{keys?.length ? (
								<span className="inline-flex items-center gap-0.5">
									{keys.map((k) => (
										<Kbd key={k}>{k}</Kbd>
									))}
								</span>
							) : null}
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
