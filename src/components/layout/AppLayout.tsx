import { useEffect, useState } from "react";
import { readFile, writeFile } from "../../lib/commands";
import { TabBar } from "../editor/TabBar";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";

const TEST_FILE_PATH = "/Users/nakiym/development/tools/mark-draft/test-files/test.md";

export function AppLayout() {
	const [content, setContent] = useState("");
	const [status, setStatus] = useState("");

	useEffect(() => {
		readFile(TEST_FILE_PATH)
			.then(setContent)
			.catch(() => setContent(""));
	}, []);

	const handleSave = () => {
		writeFile(TEST_FILE_PATH, content)
			.then(() => setStatus("Saved"))
			.catch((err) => setStatus(`Error: ${err}`));
	};

	return (
		<div className="flex h-screen flex-col bg-bg-primary text-text-primary">
			<TabBar />
			<div className="flex flex-1 overflow-hidden">
				<Sidebar />
				<main className="flex flex-1 flex-col p-4">
					<div className="mb-2 flex items-center gap-2">
						<span className="text-text-secondary text-sm">{TEST_FILE_PATH}</span>
						<button
							type="button"
							onClick={handleSave}
							className="rounded bg-accent-primary px-3 py-1 text-sm text-white"
						>
							Save
						</button>
						{status && <span className="text-text-secondary text-sm">{status}</span>}
					</div>
					<textarea
						value={content}
						onChange={(e) => setContent(e.target.value)}
						className="flex-1 resize-none rounded border border-border-primary bg-bg-secondary p-3 font-mono text-sm text-text-primary focus:border-accent-primary focus:outline-none"
					/>
				</main>
			</div>
			<StatusBar />
		</div>
	);
}
