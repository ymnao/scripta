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

/** 初回 hover から表示までの遅延（ms）。VSCode / Radix UI 流の warm-up。 */
export const TOOLTIP_SHOW_DELAY_MS = 500;
/** 直前に tooltip が消えてからこの時間内（ms）の hover は連続閲覧とみなし即表示する（skip delay）。 */
export const TOOLTIP_SKIP_DELAY_WINDOW_MS = 300;

// 直前に tooltip が実際に消えた時刻（warm-up 共有状態）。skip delay の判定に使う。
let lastHiddenAt = Number.NEGATIVE_INFINITY;

/** テスト専用: warm-up 状態（直前に tooltip が消えた時刻）をリセットする。 */
export function resetTooltipWarmupForTest(): void {
	lastHiddenAt = Number.NEGATIVE_INFINITY;
}

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
	// 保留中の表示遅延タイマー id（warm-up）。
	const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 表示状態のミラー。lastHiddenAt の更新判定を setState updater の外で行うために持つ
	// （updater 内での外部書き込みは純粋性ルール違反で、StrictMode だと二重実行される）。
	const visibleRef = useRef(false);
	// clamp 後の left（描画後に useLayoutEffect で補正する）。
	const [left, setLeft] = useState(0);

	const clearShowTimer = useCallback(() => {
		if (showTimerRef.current !== null) {
			clearTimeout(showTimerRef.current);
			showTimerRef.current = null;
		}
	}, []);

	const show = useCallback(() => {
		clearShowTimer();
		const trigger = triggerRef.current;
		if (!trigger) return;
		const rect = trigger.getBoundingClientRect();
		visibleRef.current = true;
		setAnchor({
			left: rect.left,
			width: rect.width,
			top: rect.top,
			bottom: rect.bottom,
		});
	}, [clearShowTimer]);

	const hide = useCallback(() => {
		clearShowTimer();
		// 実際に表示中だった場合のみ warm-up の消滅時刻を更新する。
		if (visibleRef.current) {
			visibleRef.current = false;
			lastHiddenAt = Date.now();
		}
		setAnchor(null);
	}, [clearShowTimer]);

	// hover からの表示。直前に別 tooltip が出ていた（skip delay 窓内）なら即表示、
	// そうでなければ TOOLTIP_SHOW_DELAY_MS 待ってから表示する。
	const showFromHover = useCallback(() => {
		clearShowTimer();
		if (Date.now() - lastHiddenAt <= TOOLTIP_SKIP_DELAY_WINDOW_MS) {
			show();
			return;
		}
		showTimerRef.current = setTimeout(() => {
			showTimerRef.current = null;
			show();
		}, TOOLTIP_SHOW_DELAY_MS);
	}, [clearShowTimer, show]);

	// unmount 時に保留タイマーを破棄する。
	useEffect(() => clearShowTimer, [clearShowTimer]);

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
		onMouseEnter: mergeHandlers<MouseEvent<HTMLElement>>(showFromHover, childProps.onMouseEnter),
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
							className="pointer-events-none fixed z-[60] flex max-w-[min(40rem,calc(100vw-8px))] animate-tooltip-in items-center gap-1.5 rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary shadow-md"
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
							<span className="break-all">{label}</span>
							{keys?.length ? (
								<span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap">
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
