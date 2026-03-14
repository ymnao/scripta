import { ConflictWindow } from "./components/conflict/ConflictWindow";
import { AppLayout } from "./components/layout/AppLayout";

function App() {
	const params = new URLSearchParams(window.location.search);
	if (params.has("conflict")) return <ConflictWindow />;
	return <AppLayout />;
}

export default App;
