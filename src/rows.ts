import { createHash } from "node:crypto";
import type { JsonValue, PropertyColumn } from "./properties.ts";
import { mirroredValue, placeOf, propertyType } from "./properties.ts";

/** A note as the vault gives it, before the mirror types it: what the metadata cache holds. */
export interface NoteSource {
	path: string;
	/** The file name without its extension. */
	name: string;
	/** The parent folder's path, empty at the vault's root. */
	folder: string;
	createdMs: number;
	modifiedMs: number;
	sizeBytes: number;
	frontmatter: Record<string, unknown> | undefined;
	/** The note's tags, from its properties and its text, without `#`. */
	tags: string[];
	aliases: string[];
}

/** A link as the note writes it, with the file it reaches. */
export interface NoteLink {
	/** As written: a wikilink's target, or a Markdown link's path, with any `#heading`. */
	target: string;
	/** The file the link reaches; null when it reaches none. */
	targetPath: string | null;
	isEmbed: boolean;
	/** Written in a property value rather than in the note's text. */
	isInProperties: boolean;
}

/** What a note's row holds, apart from its digests. */
export interface NoteContent {
	path: string;
	name: string;
	folder: string;
	created: string | null;
	modified: string;
	size_bytes: number;
	tags: string[];
	aliases: string[];
	properties: { [key: string]: JsonValue };
	latitude: number | null;
	longitude: number | null;
}

export interface NoteDigests {
	contentDigest: string;
	linksDigest: string;
}

/** One row of `notes`, as the upsert reads it from JSON. */
export interface NoteRow extends NoteContent {
	content_digest: string;
	links_digest: string;
}

/** One row of `links`, as the insertion reads it from JSON. */
export interface LinkRow {
	source_path: string;
	/** The link's place among the note's links, from 1. */
	link_number: number;
	target: string;
	target_path: string | null;
	is_embed: boolean;
	is_in_properties: boolean;
}

function isoDate(milliseconds: number): string | null {
	return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}

/**
 * The note as the mirror copies it. Each property is named as the vault names it across notes
 * (`columnsByKey`, by lowercased name), so `Cours` and `cours` are one key, and typed as the
 * vault types it; `placePropertyNames` give the note's latitude and longitude.
 */
export function noteContent(source: NoteSource, columnsByKey: Map<string, PropertyColumn>, placePropertyNames: string[]): NoteContent {
	const properties: { [key: string]: JsonValue } = {};
	for (const [key, value] of Object.entries(source.frontmatter ?? {})) {
		const column = columnsByKey.get(key.toLowerCase());
		const propertyName = column?.propertyName ?? key;
		// Two capitalizations of one property in a note: the first written is kept, as Obsidian reads it.
		if (Object.prototype.hasOwnProperty.call(properties, propertyName)) continue;
		properties[propertyName] = mirroredValue(value, column?.propertyType ?? propertyType(key, [value], new Map()));
	}
	const place = placeOf(source.frontmatter, placePropertyNames);
	return {
		path: source.path,
		name: source.name,
		folder: source.folder,
		created: isoDate(source.createdMs),
		modified: isoDate(source.modifiedMs) ?? new Date(0).toISOString(),
		size_bytes: source.sizeBytes,
		tags: source.tags,
		aliases: source.aliases,
		properties,
		latitude: place?.latitude ?? null,
		longitude: place?.longitude ?? null,
	};
}

export function linkRows(links: NoteLink[], sourcePath: string): LinkRow[] {
	return links.map((link, offset) => ({
		source_path: sourcePath,
		link_number: offset + 1,
		target: link.target,
		target_path: link.targetPath,
		is_embed: link.isEmbed,
		is_in_properties: link.isInProperties,
	}));
}

/** JSON with keys sorted at every level, so equal rows give equal digests. */
export function sortedJson(value: unknown): string {
	return JSON.stringify(value, (_key, member: unknown) => {
		if (member === null || typeof member !== "object" || Array.isArray(member)) return member;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(member).sort()) sorted[key] = (member as Record<string, unknown>)[key];
		return sorted;
	});
}

function shortDigest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

/** The first 128 bits of the SHA-256 of the content's sorted JSON, in hexadecimal. */
export function contentDigest(content: NoteContent): string {
	return shortDigest(sortedJson(content));
}

/** The first 128 bits of the SHA-256 of a note's links, each written as its target, its destination and its flags. */
export function linksDigest(links: NoteLink[]): string {
	let text = "";
	for (const link of links) {
		text += `${link.target}\u0000${link.targetPath ?? ""}\u0000${link.targetPath === null ? 0 : 1}${link.isEmbed ? 1 : 0}${link.isInProperties ? 1 : 0}\u001e`;
	}
	return shortDigest(text);
}

/**
 * What one copy changes in the database, from the notes the vault holds now and those the
 * database holds. A note whose row and links are unchanged is not written again.
 */
export interface MirrorPlan {
	/** Notes whose row is new or different; a note whose links digest differs has its links written again too. */
	notePathsToWrite: string[];
	/** Notes the database holds that the vault no longer has (deleted, or moved elsewhere). */
	notePathsToDelete: string[];
}

export function mirrorPlan(vaultNotes: Map<string, NoteDigests>, copiedNotes: Map<string, NoteDigests>): MirrorPlan {
	const notePathsToWrite: string[] = [];
	for (const [path, digests] of vaultNotes) {
		const copied = copiedNotes.get(path);
		if (!copied || copied.contentDigest !== digests.contentDigest || copied.linksDigest !== digests.linksDigest) notePathsToWrite.push(path);
	}
	const notePathsToDelete = [...copiedNotes.keys()].filter((path) => !vaultNotes.has(path));
	return { notePathsToWrite: notePathsToWrite.sort(), notePathsToDelete: notePathsToDelete.sort() };
}

export function chunks<Item>(items: Item[], size: number): Item[][] {
	const result: Item[][] = [];
	for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
	return result;
}
