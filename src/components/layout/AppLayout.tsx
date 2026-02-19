import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";

export function AppLayout() {
	return (
		<div className="flex h-screen flex-col bg-bg-primary text-text-primary">
			<div data-tauri-drag-region className="h-8 shrink-0 bg-bg-primary" />
			<div className="flex flex-1 overflow-hidden">
				<Sidebar />
				<main className="flex flex-1 items-center justify-center text-text-secondary">
					No file open
				</main>
			</div>
			<StatusBar />
		</div>
	);
}
