import { useEffect, useState } from "react";
import { useThemeStore } from "../../stores/theme";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { SAMPLE_MARKDOWN } from "./sample-markdown";

const noop = (): void => {};

// Stage 0b 検証用ビュー。?demo=1 URL クエリで表示され、Live Preview の
// 全デコレーションが Chromium 上で破綻なく描画されることを目視確認する。
// Stage 1（fs を本物にした時）で削除する一時コード。
export function DemoView() {
	const [content, setContent] = useState(SAMPLE_MARKDOWN);
	const hydratePreference = useThemeStore((s) => s.hydratePreference);

	useEffect(() => {
		hydratePreference("system");
	}, [hydratePreference]);

	return (
		<div className="flex h-screen flex-col bg-bg-primary text-text-primary">
			<main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
				<MarkdownEditor value={content} onChange={setContent} onSave={noop} />
			</main>
		</div>
	);
}
