import type { ElectronAPI } from "@electron-toolkit/preload";
import type { Api } from "../../electron/preload/api";

declare global {
	interface Window {
		electron: ElectronAPI;
		api: Api;
	}
}
