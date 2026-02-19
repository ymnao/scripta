import { useCallback, useEffect, useRef, useState } from "react";
import { readFile, writeFile } from "../../lib/commands";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { TabBar } from "../editor/TabBar";
import { Sidebar } from "./Sidebar";
import { type SaveStatus, StatusBar } from "./StatusBar";

const TEST_FILE_PATH = "../test-files/test.md";

export function AppLayout() {
	const [content, setContent] = useState("");
	const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
	const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

	useEffect(() => {
		readFile(TEST_FILE_PATH)
			.then(setContent)
			.catch((err) => {
				console.error("Failed to read file:", err);
				setContent("");
			});
	}, []);

	const handleSave = useCallback(() => {
		setSaveStatus("saving");
		if (savedTimerRef.current) {
			clearTimeout(savedTimerRef.current);
		}
		writeFile(TEST_FILE_PATH, content)
			.then(() => {
				setSaveStatus("saved");
				savedTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
			})
			.catch((err) => {
				console.error("Failed to save file:", err);
				setSaveStatus("error");
				savedTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
			});
	}, [content]);

	return (
		<div className="flex h-screen flex-col bg-bg-primary text-text-primary">
			<TabBar />
			<div className="flex flex-1 overflow-hidden">
				<Sidebar />
				<main className="flex-1 overflow-hidden">
					<MarkdownEditor value={content} onChange={setContent} onSave={handleSave} />
				</main>
			</div>
			<StatusBar saveStatus={saveStatus} />
		</div>
	);
}
