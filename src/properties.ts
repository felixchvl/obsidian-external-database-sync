/** The types the Properties view gives a property, as `.obsidian/types.json` spells them. */
export type PropertyType = "text" | "multitext" | "number" | "checkbox" | "date" | "datetime" | "tags" | "aliases";

const propertyTypes = new Set<string>(["text", "multitext", "number", "checkbox", "date", "datetime", "tags", "aliases"]);

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A property the vault uses, with the type it has across the vault and how many notes have it. */
export interface PropertyColumn {
	/** The spelling most notes use; every capitalization of the name is this one property. */
	propertyName: string;
	propertyType: PropertyType;
	noteCount: number;
}

/** The types `types.json` assigns, by property name; an unreadable file assigns none. */
export function declaredTypes(typesJson: string | null): Map<string, PropertyType> {
	const types = new Map<string, PropertyType>();
	if (!typesJson) return types;
	let parsed: unknown;
	try {
		parsed = JSON.parse(typesJson);
	} catch {
		return types;
	}
	const assigned = (parsed as { types?: unknown } | null)?.types;
	if (!assigned || typeof assigned !== "object") return types;
	for (const [name, type] of Object.entries(assigned)) {
		if (typeof type === "string" && propertyTypes.has(type)) types.set(name, type as PropertyType);
	}
	return types;
}

/** The type Obsidian gives a property by its name alone, such as `tags`. */
export function defaultType(key: string): PropertyType | undefined {
	switch (key) {
		case "tags":
		case "tag":
			return "tags";
		case "aliases":
		case "alias":
			return "aliases";
		case "cssclasses":
			return "multitext";
		default:
			return undefined;
	}
}

const datePattern = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;
const numberPattern = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;

/** The type one value suggests, or undefined when it suggests none (empty, or a mapping). */
function suggestedType(value: unknown): PropertyType | undefined {
	if (Array.isArray(value)) return "multitext";
	if (value instanceof Date) return "datetime";
	switch (typeof value) {
		case "boolean":
			return "checkbox";
		case "number":
			return "number";
		case "string":
			if (value === "") return undefined;
			if (datePattern.test(value)) return value.length > 10 ? "datetime" : "date";
			return "text";
		default:
			return undefined;
	}
}

/**
 * The type Obsidian gives a property across the vault: the one assigned in `types.json`,
 * else the one its name implies (`tags`), else the one its first non-empty value suggests,
 * else text.
 */
export function propertyType(key: string, sampleValues: unknown[], declared: Map<string, PropertyType>): PropertyType {
	const exact = declared.get(key);
	if (exact) return exact;
	const lowercasedKey = key.toLowerCase();
	for (const [name, type] of declared) {
		if (name.toLowerCase() === lowercasedKey) return type;
	}
	const byName = defaultType(lowercasedKey);
	if (byName) return byName;
	for (const value of sampleValues) {
		const suggested = suggestedType(value);
		if (suggested) return suggested;
	}
	return "text";
}

/** The vault's properties, one per name whatever its capitals, typed as the Properties view types them. */
export function propertyColumns(
	frontmatters: Iterable<Record<string, unknown> | undefined>,
	declared: Map<string, PropertyType>,
): PropertyColumn[] {
	interface Usage {
		noteCountBySpelling: Map<string, number>;
		samples: unknown[];
		noteCount: number;
	}
	const usages = new Map<string, Usage>();
	for (const frontmatter of frontmatters) {
		if (!frontmatter) continue;
		const keysInNote = new Set<string>();
		for (const [name, value] of Object.entries(frontmatter)) {
			const key = name.toLowerCase();
			let usage = usages.get(key);
			if (!usage) {
				usage = { noteCountBySpelling: new Map(), samples: [], noteCount: 0 };
				usages.set(key, usage);
			}
			usage.noteCountBySpelling.set(name, (usage.noteCountBySpelling.get(name) ?? 0) + 1);
			if (usage.samples.length < 8 && suggestedType(value)) usage.samples.push(value);
			if (!keysInNote.has(key)) {
				keysInNote.add(key);
				usage.noteCount += 1;
			}
		}
	}
	const columns: PropertyColumn[] = [];
	for (const usage of usages.values()) {
		const propertyName = mostUsedSpelling(usage.noteCountBySpelling);
		columns.push({ propertyName, propertyType: propertyType(propertyName, usage.samples, declared), noteCount: usage.noteCount });
	}
	return columns.sort((left, right) => compareText(left.propertyName, right.propertyName));
}

function mostUsedSpelling(noteCountBySpelling: Map<string, number>): string {
	let best = "";
	let bestCount = -1;
	for (const [spelling, count] of noteCountBySpelling) {
		if (count > bestCount || (count === bestCount && compareText(spelling, best) < 0)) {
			best = spelling;
			bestCount = count;
		}
	}
	return best;
}

export function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function columnsByKey(columns: PropertyColumn[]): Map<string, PropertyColumn> {
	const byKey = new Map<string, PropertyColumn>();
	for (const column of columns) {
		const key = column.propertyName.toLowerCase();
		if (!byKey.has(key)) byKey.set(key, column);
	}
	return byKey;
}

/**
 * A property value as the mirror stores it in a note's `properties` JSON, typed as the vault
 * types the property. A list's items keep YAML's own types (numbers stay numbers), except in
 * tags and aliases, whose items are names. A mapping is kept as an object, typed by YAML alone.
 */
export function mirroredValue(value: unknown, type: PropertyType | undefined): JsonValue {
	if (Array.isArray(value)) {
		const itemType = type === "tags" || type === "aliases" ? "text" : undefined;
		return value.map((item) => mirroredValue(item, itemType));
	}
	if (value instanceof Date) return scalarValue(value.toISOString(), type);
	if (value !== null && typeof value === "object") {
		const members: { [key: string]: JsonValue } = {};
		for (const [key, member] of Object.entries(value)) members[key] = mirroredValue(member, undefined);
		return members;
	}
	return scalarValue(value, type);
}

function scalarValue(value: unknown, type: PropertyType | undefined): JsonValue {
	if (value === null || value === undefined) {
		return type === "multitext" || type === "tags" || type === "aliases" ? [] : null;
	}
	const text = typeof value === "string" ? value : scalarText(value);
	switch (type) {
		case "text":
		case "date":
		case "datetime":
			// Dates stay as written (`2026-09-23`, `2026-09-23T14:30`), which PostgreSQL reads as dates.
			return text;
		case "tags":
			// Obsidian reads `tags: fiction, classic` as two tags.
			return text.split(/[\s,]+/).filter((tag) => tag !== "");
		case "multitext":
		case "aliases":
			return [text];
		case "number": {
			const number = typeof value === "number" ? value : numberPattern.test(text) ? Number(text) : NaN;
			// JSON has no infinity or NaN; such a value is kept as text.
			return Number.isFinite(number) ? number : text;
		}
		case "checkbox":
			return typeof value === "boolean" ? value : text.toLowerCase() === "true";
		case undefined:
			break;
	}
	if (typeof value === "number") return Number.isFinite(value) ? value : text;
	if (typeof value === "boolean") return value;
	return text;
}

function scalarText(value: unknown): string {
	switch (typeof value) {
		case "number":
		case "boolean":
		case "bigint":
			return String(value);
		default:
			return JSON.stringify(value) ?? "";
	}
}

export interface Coordinate {
	latitude: number;
	longitude: number;
}

function coordinateNumber(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return numberPattern.test(text) ? Number(text) : undefined;
}

function validCoordinate(latitude: number | undefined, longitude: number | undefined): Coordinate | undefined {
	if (latitude === undefined || longitude === undefined) return undefined;
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
	if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined;
	return { latitude, longitude };
}

/**
 * The place a value gives, in the Maps formats: `[lat, lng]` (numbers or numeric text) or
 * `"lat, lng"`. Text with any other number of parts, such as decimal commas (`"48,85, 2,35"`),
 * is not a coordinate: reading its first two parts would misplace the note.
 */
export function coordinate(value: unknown): Coordinate | undefined {
	if (Array.isArray(value)) {
		if (value.length < 2) return undefined;
		return validCoordinate(coordinateNumber(value[0]), coordinateNumber(value[1]));
	}
	if (typeof value !== "string") return undefined;
	const parts = value
		.replace(/^[[\] ]+|[[\] ]+$/g, "")
		.split(",")
		.filter((part) => part !== "");
	if (parts.length !== 2) return undefined;
	return validCoordinate(coordinateNumber(parts[0]), coordinateNumber(parts[1]));
}

/**
 * The place a note's properties give: the first of `propertyNames` (matched whatever its
 * capitals) that reads as a coordinate. An address or a city written as text places nothing.
 */
export function placeOf(frontmatter: Record<string, unknown> | undefined, propertyNames: string[]): Coordinate | undefined {
	if (!frontmatter) return undefined;
	for (const name of propertyNames) {
		const lowercasedName = name.toLowerCase();
		for (const [key, value] of Object.entries(frontmatter)) {
			if (key.toLowerCase() !== lowercasedName) continue;
			const place = coordinate(value);
			if (place) return place;
		}
	}
	return undefined;
}

/** The properties that place a note in any vault: Bases' map view reads `coordinates`, the Map View plugin `location`. */
export const defaultPlacePropertyNames = ["coordinates", "location"];

/** `names` in order, trimmed, without repeats whatever their capitals. */
export function distinctNames(names: Iterable<string | undefined>): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const trimmed = name?.trim();
		if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
		seen.add(trimmed.toLowerCase());
		result.push(trimmed);
	}
	return result;
}
