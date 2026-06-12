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
	/** tooltip を出す側。既定は "top"。アンカーが画面上部にあるボタンでは "bottom" を指定する */
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

/** hover から表示までの遅延（ms）。マウス通過時の誤表示を防ぐ。 */
export const TOOLTIP_SHOW_DELAY_MS = 500;

/** 注入ハンドラと children 既存ハンドラを合成して両方呼ぶ。 */
function mergeHandlers<E>(injected: (e: E) => void, existing?: (e: E) => void): (e: E) => void {
	return (e: E) => {
		injected(e);
		existing?.(e);
	};
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
	// 保留中の表示遅延タイマー id。
	const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// clamp 後の left（描画後に useLayoutEffect で補正する）。
	const [left, setLeft] = useState(0);

	const clearShowTimer = useCallback(() => {
		if (showTimerRef.current !== null) {
			clearTimeout(showTimerRef.current);
			showTimerRef.current = null;
		}
	}, []);

	const show = useCallback(() => {
		// hover の表示遅延中に keyboard focus で即表示された場合、保留タイマーを破棄する
		// （残すと満了時に show が二重に走る）。
		clearShowTimer();
		const trigger = triggerRef.current;
		if (!trigger) return;
		const rect = trigger.getBoundingClientRect();
		setAnchor({
			left: rect.left,
			width: rect.width,
			top: rect.top,
			bottom: rect.bottom,
		});
	}, [clearShowTimer]);

	const hide = useCallback(() => {
		clearShowTimer();
		setAnchor(null);
	}, [clearShowTimer]);

	// hover からの表示。TOOLTIP_SHOW_DELAY_MS 待ってから表示する（マウス通過時の誤表示防止）。
	// 別 tooltip の表示中からカーソルを移してきた場合も例外にせず、毎回待つ。
	const showFromHover = useCallback(() => {
		clearShowTimer();
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
		onBlur: (e: FocusEvent<HTMLElement>) => {
			// focus 済みボタンを再クリックすると focus イベントが発生せず pointer 由来フラグが
			// 消費されないまま残るため、blur で清算して次の keyboard focus の表示を妨げない。
			pointerDownRef.current = false;
			hide();
			childProps.onBlur?.(e);
		},
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
						/* w-max が必須: fixed + left 指定の要素は「left〜viewport 右端」を利用可能幅として
						   shrink-to-fit するため（translate は幅計算に効かない）、右端付近のアンカーでは
						   幅が極小になり 1〜2 文字ずつ縦折れする。max-content 幅にして left に依存させない。 */
						<div
							ref={tooltipRef}
							role="tooltip"
							id={id}
							className="pointer-events-none fixed z-[60] flex w-max max-w-[min(40rem,calc(100vw-8px))] animate-tooltip-in items-center gap-1.5 rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary shadow-md"
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
