import { useEffect, useState } from "react";
import { useAutoSave } from "../../hooks/useAutoSave";
import { readFile } from "../../lib/commands";
import { useWorkspaceStore } from "../../stores/workspace";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { TabBar } from "../editor/TabBar";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";

export function AppLayout() {
	const openFilePath = useWorkspaceStore((s) => s.openFilePath);
	const [content, setContent] = useState("");
	const { saveStatus, saveNow, markSaved } = useAutoSave(openFilePath ?? "", content);

	useEffect(() => {
		if (!openFilePath) {
			setContent("");
			markSaved("");
			return;
		}

		let ignore = false;
		readFile(openFilePath)
			.then((loaded) => {
				if (ignore) return;
				setContent(loaded);
				markSaved(loaded);
			})
			.catch((err) => {
				if (ignore) return;
				console.error("Failed to read file:", err);
				setContent("");
				markSaved("");
			});
		return () => {
			ignore = true;
		};
	}, [openFilePath, markSaved]);

	return (
		<div className="flex h-screen flex-col bg-bg-primary text-text-primary">
			<TabBar />
			<div className="flex flex-1 overflow-hidden">
				<Sidebar />
				<main className="flex-1 overflow-hidden">
					{openFilePath ? (
						<MarkdownEditor value={content} onChange={setContent} onSave={saveNow} />
					) : (
						<div className="flex h-full items-center justify-center text-text-secondary">
							<p className="text-sm">Select a file to start editing</p>
						</div>
					)}
				</main>
			</div>
			<StatusBar saveStatus={openFilePath ? saveStatus : undefined} />
		</div>
	);
}
