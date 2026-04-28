import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge } from "electron";
import type { Api } from "./api";

const api: Api = {
	getVersion: () => process.versions.electron,
};

contextBridge.exposeInMainWorld("electron", electronAPI);
contextBridge.exposeInMainWorld("api", api);
