import { useEffect, useState } from "react";
import { useAutoSave } from "../../hooks/useAutoSave";
import { readFile } from "../../lib/commands";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { TabBar } from "../editor/TabBar";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";

const TEST_FILE_PATH = "../test-files/test.md";

export function AppLayout() {
	const [content, setContent] = useState("");
	const { saveStatus, saveNow, markSaved } = useAutoSave(TEST_FILE_PATH, content);

	useEffect(() => {
		let ignore = false;
		readFile(TEST_FILE_PATH)
			.then((loaded) => {
				if (ignore) return;
				setContent(loaded);
				markSaved(loaded);
			})
			.catch((err) => {
				if (ignore) return;
				console.error("Failed to read file:", err);
				setContent("");
			});
		return () => {
			ignore = true;
		};
	}, [markSaved]);

	return (
		<div className="flex h-screen flex-col bg-bg-primary text-text-primary">
			<TabBar />
			<div className="flex flex-1 overflow-hidden">
				<Sidebar />
				<main className="flex-1 overflow-hidden">
					<MarkdownEditor value={content} onChange={setContent} onSave={saveNow} />
				</main>
			</div>
			<StatusBar saveStatus={saveStatus} />
		</div>
	);
}
