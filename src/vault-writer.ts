import type { App, TFile } from "obsidian";
import { normalizePath } from "obsidian";
import type { DatabaseChange } from "./changes.ts";
import { editFrontmatter, unwritablePathReason } from "./changes.ts";

export interface WritingOptions {
	placePropertyNames: string[];
	excludedFolders: string[];
}

/**
 * Brings an edit made in the database into the vault, through Obsidian: properties through
 * `processFrontMatter`, moves through `renameFile` (which updates the links to the note when
 * Obsidian is set to), deletions to the trash you chose. The note's text is never touched.
 * Returns a remark for the `changes` table, or undefined.
 */
export class VaultWriter {
	private readonly app: App;

	constructor(app: App) {
		this.app = app;
	}

	async apply(change: DatabaseChange, options: WritingOptions): Promise<string | undefined> {
		switch (change.kind) {
			case "create":
				await this.create(change, options);
				return undefined;
			case "update":
				return this.update(change, options);
			case "delete":
				await this.app.fileManager.trashFile(this.existingNote(change.path));
				return undefined;
		}
	}

	private async create(change: DatabaseChange, options: WritingOptions): Promise<void> {
		const path = this.writablePath(change.path, options);
		if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`${path} already exists in the vault`);
		await this.ensureFolder(path);
		const file = await this.app.vault.create(path, "");
		await this.writeProperties(file, change, options);
	}

	private async update(change: DatabaseChange, options: WritingOptions): Promise<string | undefined> {
		const file = this.existingNote(change.path);
		const changesProperties = change.placeChanged
			|| change.removedProperties.length > 0
			|| Object.keys(change.setProperties).length > 0;
		if (changesProperties) await this.writeProperties(file, change, options);
		if (change.newPath !== null && change.newPath !== file.path) {
			const newPath = this.writablePath(change.newPath, options);
			if (this.app.vault.getAbstractFileByPath(newPath)) throw new Error(`${newPath} already exists in the vault`);
			await this.ensureFolder(newPath);
			// Obsidian asks before updating links unless it is set to update them; nobody is there to
			// answer for the database, so the note moves without its links then.
			if (this.updatesLinks()) {
				await this.app.fileManager.renameFile(file, newPath);
			} else {
				await this.app.vault.rename(file, newPath);
				return "Links to the note were left as they were: Obsidian is set to ask before updating them.";
			}
		}
		return undefined;
	}

	/** Whether Obsidian's "Automatically update internal links" is on. */
	private updatesLinks(): boolean {
		// Not in the public API; read with care, and taken as off when missing.
		const vault = this.app.vault as unknown as { getConfig?: (key: string) => unknown };
		return typeof vault.getConfig === "function" && vault.getConfig("alwaysUpdateLinks") === true;
	}

	private async writeProperties(file: TFile, change: DatabaseChange, options: WritingOptions): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			editFrontmatter(frontmatter, change, options.placePropertyNames);
		});
	}

	private existingNote(path: string): TFile {
		const file = this.app.vault.getFileByPath(normalizePath(path));
		if (!file) throw new Error(`${path} is no longer in the vault`);
		return file;
	}

	private writablePath(path: string, options: WritingOptions): string {
		const normalized = normalizePath(path);
		const reason = unwritablePathReason(normalized, options.excludedFolders);
		if (reason) throw new Error(reason);
		return normalized;
	}

	private async ensureFolder(path: string): Promise<void> {
		const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (folder !== "" && !this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
	}
}
