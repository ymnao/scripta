import { useEffect, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspace";

/**
 * fileTreeVersion / contentVersion のどちらかが進んだら 2000ms 後に 1 回だけ rescan を
 * 呼ぶ debounce hook。autosave の自己書込が watcher 経由で fileTreeVersion を bump する
 * ケースと、保存確定の contentVersion bump を 1 本の debounce に統合し、backlink /
 * unresolved パネルの二重・過剰スキャンを防ぐ (#298)。
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
	useEffect(() => {
		if (!rescan) return;
		if (prevVersionRef.current === version) return;
		prevVersionRef.current = version;
		let fired = false;
		const timer = setTimeout(() => {
			fired = true;
			rescan();
		}, 2000);
		return () => {
			clearTimeout(timer);
			if (fired) cancel().catch(() => {});
		};
	}, [version, rescan, cancel]);
}
