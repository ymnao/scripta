import { useEffect, useRef } from "react";

export type Shortcut = {
	/** デバッグ / トレース用の一意な識別子。実行順序には影響しない。 */
	id: string;
	/** この KeyboardEvent がショートカットに該当するかを判定する。 */
	match: (e: KeyboardEvent) => boolean;
	/** マッチした時に実行される処理。preventDefault は match/run 前に自動で呼ばれる (下記 preventDefault 参照)。 */
	run: (e: KeyboardEvent) => void;
	/**
	 * true (default) の場合、match が真になった時点で e.preventDefault() を自動で呼ぶ。
	 * false を明示するのは preventDefault を条件付きで抑制したいエントリのみ (今のところ無し)。
	 */
	preventDefault?: boolean;
};

/**
 * document 全体の keydown を購読し、登録されたショートカットを
 * 配列順に評価して最初にマッチしたエントリのみを実行する。
 *
 * shortcuts 配列は毎レンダー再生成されて構わない (ref 経由で常に最新を参照する)
 * ため、caller は useCallback / useMemo の deps 管理から解放される。
 * listener 自体は mount 時に一度だけ登録される。
 */
export function useShortcuts(shortcuts: Shortcut[]): void {
	const ref = useRef<Shortcut[]>(shortcuts);
	ref.current = shortcuts;
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			for (const s of ref.current) {
				if (s.match(e)) {
					if (s.preventDefault !== false) e.preventDefault();
					s.run(e);
					return;
				}
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, []);
}
