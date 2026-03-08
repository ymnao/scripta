import { listDirectory, readFile, writeFile } from "./commands";
import { joinPath } from "./path";

const SCRIPTA_DIR = ".scripta";
const ICONS_FILE = "icons.json";
const PROMPT_TEMPLATE_FILE = "prompt-template.md";

export function getScriptaDir(workspacePath: string): string {
	return joinPath(workspacePath, SCRIPTA_DIR);
}

export async function scriptaDirExists(workspacePath: string): Promise<boolean> {
	try {
		await listDirectory(getScriptaDir(workspacePath));
		return true;
	} catch {
		return false;
	}
}

export function getScriptaPromptTemplatePath(workspacePath: string): string {
	return joinPath(getScriptaDir(workspacePath), PROMPT_TEMPLATE_FILE);
}

export async function loadIcons(workspacePath: string): Promise<Record<string, string>> {
	try {
		const raw = await readFile(joinPath(getScriptaDir(workspacePath), ICONS_FILE));
		const parsed: unknown = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			const result: Record<string, string> = {};
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof value === "string") {
					result[key] = value;
				}
			}
			return result;
		}
		return {};
	} catch {
		return {};
	}
}

export async function saveIcons(
	workspacePath: string,
	icons: Record<string, string>,
): Promise<void> {
	const content = JSON.stringify(icons, null, "\t");
	await writeFile(joinPath(getScriptaDir(workspacePath), ICONS_FILE), content);
}

export async function loadPromptTemplate(workspacePath: string): Promise<string | null> {
	try {
		return await readFile(getScriptaPromptTemplatePath(workspacePath));
	} catch {
		return null;
	}
}

export async function savePromptTemplate(workspacePath: string, content: string): Promise<void> {
	await writeFile(getScriptaPromptTemplatePath(workspacePath), content);
}
