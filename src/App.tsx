function App() {
	return (
		<div className="flex h-screen items-center justify-center bg-white text-gray-900 dark:bg-neutral-900 dark:text-neutral-100">
			<div className="text-center">
				<h1 className="text-4xl font-bold">scripta-next</h1>
				<p className="mt-2 text-sm text-gray-500 dark:text-neutral-400">
					Electron {window.api.getVersion()} / Stage 0a bootstrap
				</p>
			</div>
		</div>
	);
}

export default App;
