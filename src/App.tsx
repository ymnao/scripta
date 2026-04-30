import { ConflictWindow } from "./components/conflict/ConflictWindow";
import { DemoView } from "./components/demo/DemoView";
import { AppLayout } from "./components/layout/AppLayout";

function App() {
	const params = new URLSearchParams(window.location.search);
	if (params.has("conflict")) return <ConflictWindow />;
	if (params.has("demo")) return <DemoView />;
	return <AppLayout />;
}

export default App;
