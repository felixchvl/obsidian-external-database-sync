import type { App, CachedMetadata, TFile } from "obsidian";
import { getAllTags, getLinkpath, parseFrontMatterAliases } from "obsidian";
import type { VaultState } from "./mirror.ts";
import type { PropertyColumn, PropertyType } from "./properties.ts";
import { columnsByKey, compareText, distinctNames, propertyColumns } from "./properties.ts";
import type { NoteDigests, NoteLink, NoteSource } from "./rows.ts";
import { contentDigest, linkRows, linksDigest, noteContent, sortedJson } from "./rows.ts";

export interface ReadingOptions {
	vault: string;
	declaredTypes: Map<string, PropertyType>;
	placePropertyNames: string[];
	/** Folders whose notes are not copied, by path from the vault's root. */
	excludedFolders: string[];
}

interface ComputedNote {
	/** The metadata the digests were computed from: Obsidian gives a new object when it reads the note again. */
	cache: CachedMetadata;
	modifiedMs: number;
	sizeBytes: number;
	contentDigest: string;
	/** The `linksVersion` the links digest was computed at. */
	linksVersion: number;
	linksDigest: string;
}

/**
 * Reads the vault from Obsidian's metadata cache, as the mirror copies it. Between copies it
 * remembers each note's digests, computed again only when Obsidian read the note again; links
 * resolve again for every note only when a file came, went or was renamed.
 */
export class VaultReader {
	private readonly app: App;
	private readonly computed = new Map<string, ComputedNote>();
	private linksVersion = 0;
	private columnsSignature = "";

	constructor(app: App) {
		this.app = app;
	}

	/** A file came, went or was renamed: links may reach other files now. */
	filesChanged(): void {
		this.linksVersion += 1;
	}

	/** The vault as one copy sees it; undefined while Obsidian has not read every note yet. */
	state(options: ReadingOptions): VaultState | undefined {
		const excluded = options.excludedFolders.map((folder) => folder.replace(/^\/+|\/+$/g, "")).filter((folder) => folder !== "");
		const isCopied = (path: string) => !excluded.some((folder) => path.startsWith(folder + "/"));
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((file) => isCopied(file.path))
			.sort((left, right) => compareText(left.path, right.path));
		const caches = new Map<TFile, CachedMetadata>();
		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			// A note without metadata yet would be deleted from the database: wait for Obsidian.
			if (!cache) return undefined;
			caches.set(file, cache);
		}
		const columns = propertyColumns([...caches.values()].map((cache) => cache.frontmatter), options.declaredTypes);
		const byKey = columnsByKey(columns);
		// Notes read differently when a property's name or type changes, though their files did not.
		const signature = sortedJson({
			columns: columns.map((column) => [column.propertyName, column.propertyType]),
			placePropertyNames: options.placePropertyNames,
		});
		if (signature !== this.columnsSignature) {
			this.computed.clear();
			this.columnsSignature = signature;
		}

		const digests = new Map<string, NoteDigests>();
		for (const [file, cache] of caches) {
			let known = this.computed.get(file.path);
			if (!known || known.cache !== cache || known.modifiedMs !== file.stat.mtime || known.sizeBytes !== file.stat.size) {
				const content = noteContent(this.source(file, cache), byKey, options.placePropertyNames);
				known = {
					cache,
					modifiedMs: file.stat.mtime,
					sizeBytes: file.stat.size,
					contentDigest: contentDigest(content),
					linksVersion: -1,
					linksDigest: "",
				};
				this.computed.set(file.path, known);
			}
			if (known.linksVersion !== this.linksVersion) {
				known.linksDigest = linksDigest(this.links(file, cache));
				known.linksVersion = this.linksVersion;
			}
			digests.set(file.path, { contentDigest: known.contentDigest, linksDigest: known.linksDigest });
		}
		for (const path of [...this.computed.keys()]) if (!digests.has(path)) this.computed.delete(path);

		return {
			vault: options.vault,
			digests,
			columns,
			rows: (paths) => this.rows(paths, byKey, options.placePropertyNames, isCopied),
		};
	}

	private rows(paths: string[], byKey: Map<string, PropertyColumn>, placePropertyNames: string[], isCopied: (path: string) => boolean) {
		return paths.flatMap((path) => {
			const file = this.app.vault.getFileByPath(path);
			const cache = file && isCopied(path) ? this.app.metadataCache.getFileCache(file) : null;
			if (!file || !cache) return [];
			const content = noteContent(this.source(file, cache), byKey, placePropertyNames);
			const links = this.links(file, cache);
			return [{
				note: { ...content, content_digest: contentDigest(content), links_digest: linksDigest(links) },
				links: linkRows(links, path),
			}];
		});
	}

	private source(file: TFile, cache: CachedMetadata): NoteSource {
		const frontmatter: Record<string, unknown> | undefined = cache.frontmatter;
		return {
			path: file.path,
			name: file.basename,
			folder: file.parent && file.parent.path !== "/" ? file.parent.path : "",
			createdMs: file.stat.ctime,
			modifiedMs: file.stat.mtime,
			sizeBytes: file.stat.size,
			frontmatter,
			tags: distinctNames((getAllTags(cache) ?? []).map((tag) => tag.replace(/^#/, ""))),
			aliases: parseFrontMatterAliases(frontmatter) ?? [],
		};
	}

	/** The note's links in the order a reader meets them: those in properties, then those in the text. */
	private links(file: TFile, cache: CachedMetadata): NoteLink[] {
		const links: NoteLink[] = [];
		for (const link of cache.frontmatterLinks ?? []) links.push(this.resolved(link.link, file.path, false, true));
		const written = [
			...(cache.links ?? []).map((link) => ({ link, isEmbed: false })),
			...(cache.embeds ?? []).map((link) => ({ link, isEmbed: true })),
		].sort((left, right) => left.link.position.start.offset - right.link.position.start.offset);
		for (const { link, isEmbed } of written) links.push(this.resolved(link.link, file.path, isEmbed, false));
		return links;
	}

	private resolved(target: string, sourcePath: string, isEmbed: boolean, isInProperties: boolean): NoteLink {
		const destination = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(target), sourcePath);
		return { target, targetPath: destination?.path ?? null, isEmbed, isInProperties };
	}
}
