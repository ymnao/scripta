import type { Api } from "../../electron/preload/api";

declare global {
	interface Window {
		api: Api;
	}
}
