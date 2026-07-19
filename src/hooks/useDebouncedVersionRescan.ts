import { useEffect, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspace";

const DEBOUNCE_MS = 2000;
// 連続 bump 中でも最初の bump から MAX_WAIT_MS 経過したら強制発火する上限。
// paste 連発や autosave/watcher の連鎖で debounce が無期限延期される事態を防ぐ。
const MAX_WAIT_MS = 10000;

/**
 * fileTreeVersion / contentVersion のどちらかが進んだら DEBOUNCE_MS 後に 1 回だけ
 * rescan を呼ぶ debounce hook。autosave の自己書込が watcher 経由で fileTreeVersion を
 * bump するケースと、保存確定の contentVersion bump を 1 本の debounce に統合し、
 * backlink / unresolved パネルの二重・過剰スキャンを防ぐ (#298)。
 *
 * 連続 bump が続く場合、ストリーク開始から MAX_WAIT_MS を超えた時点で強制発火する。
 *
 * rescan が null の間は何もしない (Backlink の対象外タブなど)。
 * cancel は timer が発火して scan が実際に走った後の cleanup でのみ送る
 * (未発火なら in-flight scan は存在せず、IPC が無駄になるため)。
 */
export function useDebouncedVersionRescan(
	rescan: (() => void) | null,
	cancel: () => Promise<void>,
): void {
	const fileTreeVersion = useWorkspaceStore((s) => s.fileTreeVersion);
	const contentVersion = useWorkspaceStore((s) => s.contentVersion);
	// 両カウンタとも +1 の単調増加なので、和も「どちらかが進めば必ず進む」単調増加の版になる。
	const version = fileTreeVersion + contentVersion;
	const prevVersionRef = useRef(version);
	const streakStartAtRef = useRef<number | null>(null);
	useEffect(() => {
		if (!rescan) {
			// hook が無効化された (対象外タブ等)。進行中の streak を落として、
			// 再有効化時に古い streakStart で即発火するのを防ぐ。
			streakStartAtRef.current = null;
			return;
		}
		if (prevVersionRef.current === version) {
			// version 変化なしで effect が再実行された (rescan/cancel の identity 変化)。
			// 進行中の streak は timer と一緒に破棄されるため、streakStart もリセットして
			// 次の bump が古い streakStart で即発火するのを防ぐ。
			streakStartAtRef.current = null;
			return;
		}
		prevVersionRef.current = version;
		const now = Date.now();
		if (streakStartAtRef.current === null) {
			streakStartAtRef.current = now;
		}
		const elapsed = now - streakStartAtRef.current;
		const delay = Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - elapsed));
		let fired = false;
		const timer = setTimeout(() => {
			fired = true;
			streakStartAtRef.current = null;
			rescan();
		}, delay);
		return () => {
			clearTimeout(timer);
			if (fired) cancel().catch(() => {});
		};
	}, [version, rescan, cancel]);
}
