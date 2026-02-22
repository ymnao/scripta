// Synchronously apply dark class before first paint to prevent FOUC.
// This file is loaded as a blocking <script> in index.html.
(() => {
	try {
		const t = localStorage.getItem("mark-draft-theme");
		if (t === "dark") document.documentElement.classList.add("dark");
		else if (t === "light") document.documentElement.classList.remove("dark");
	} catch {
		// localStorage may be unavailable in some environments
	}
})();
