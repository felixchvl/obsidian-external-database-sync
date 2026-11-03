import type { PropertyColumn, PropertyType } from "./properties.ts";
import { compareText } from "./properties.ts";

/**
 * The SQL the mirror runs, for one schema. Names the mirror does not choose (the schema, the
 * properties) are always quoted; values are bound as parameters, except in the view and the
 * functions, whose definitions cannot hold parameters, where names are escaped literals.
 *
 * The tables are those of Graphite's PostgreSQL Mirror, with version 2's `changes` beside them.
 */
export class MirrorStatements {
	/** The schema version these statements create: 1 is the copy, 2 brings edits made in the database back. */
	static readonly schemaVersion = 2;
	/** Marks a transaction as the plugin's own, so the triggers tell its writes from edits made in the database. */
	static readonly vaultWriterMark = "SET LOCAL obsidian.writer = 'vault'";
	/** The channel the triggers notify when the database is edited; the payload names the schema and the vault. */
	static readonly changeChannel = "obsidian_changes";
	/** PostgreSQL truncates longer identifiers, which could make two columns one. */
	static readonly maximumIdentifierBytes = 63;
	/** A view holds at most 1,664 columns; the most used properties get one, the rest stay in `properties`. */
	static readonly maximumPropertyColumns = 1000;
	/** The columns `notes_with_properties` has before its property columns. */
	static readonly fixedViewColumns = [
		"vault", "path", "name", "folder", "created", "modified", "size_bytes", "tags", "aliases",
		"latitude", "longitude", "geometry", "properties",
	];
	/** QGIS listens on the `qgis` channel: a layer set to "Refresh layer on notification" draws again after a copy. */
	static readonly notification = "NOTIFY qgis, 'obsidian'";

	readonly schemaName: string;
	/** The quoted schema name. */
	readonly schema: string;

	constructor(schemaName: string) {
		this.schemaName = schemaName;
		this.schema = quotedIdentifier(schemaName);
	}

	/** The schema, its tables and indexes, one statement each. Every statement can run again harmlessly. */
	get schemaCreation(): string[] {
		const schema = this.schema;
		return [
			`CREATE SCHEMA IF NOT EXISTS ${schema}`,
			`CREATE TABLE IF NOT EXISTS ${schema}.mirror_schema (version integer NOT NULL)`,
			`CREATE TABLE IF NOT EXISTS ${schema}.vaults (
  vault text PRIMARY KEY,
  copy_number bigint NOT NULL DEFAULT 0,
  copied_at timestamptz NOT NULL DEFAULT now()
)`,
			`CREATE TABLE IF NOT EXISTS ${schema}.notes (
  vault text NOT NULL REFERENCES ${schema}.vaults (vault) ON DELETE CASCADE,
  path text NOT NULL,
  name text NOT NULL,
  folder text NOT NULL,
  created timestamptz,
  modified timestamptz NOT NULL,
  size_bytes bigint NOT NULL,
  tags text[] NOT NULL,
  aliases text[] NOT NULL,
  properties jsonb NOT NULL,
  latitude double precision,
  longitude double precision,
  content_digest text NOT NULL,
  links_digest text NOT NULL,
  PRIMARY KEY (vault, path)
)`,
			`CREATE INDEX IF NOT EXISTS notes_properties ON ${schema}.notes USING gin (properties)`,
			`CREATE INDEX IF NOT EXISTS notes_tags ON ${schema}.notes USING gin (tags)`,
			`CREATE TABLE IF NOT EXISTS ${schema}.links (
  vault text NOT NULL,
  source_path text NOT NULL,
  link_number integer NOT NULL,
  target text NOT NULL,
  target_path text,
  is_embed boolean NOT NULL,
  is_in_properties boolean NOT NULL,
  PRIMARY KEY (vault, source_path, link_number),
  FOREIGN KEY (vault, source_path) REFERENCES ${schema}.notes (vault, path) ON DELETE CASCADE
)`,
			`CREATE INDEX IF NOT EXISTS links_target_path ON ${schema}.links (vault, target_path)`,
			`CREATE TABLE IF NOT EXISTS ${schema}.property_columns (
  vault text NOT NULL REFERENCES ${schema}.vaults (vault) ON DELETE CASCADE,
  property_name text NOT NULL,
  property_type text NOT NULL,
  note_count integer NOT NULL,
  PRIMARY KEY (vault, property_name)
)`,
			// Version 1's tables; `changesCreation` brings them to the current version.
			`INSERT INTO ${schema}.mirror_schema (version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${schema}.mirror_schema)`,
		];
	}

	/** The notes' point, computed by PostgreSQL from their latitude and longitude, once PostGIS is installed. */
	geometryColumnCreation(postGISSchema: string): string[] {
		const postGIS = quotedIdentifier(postGISSchema);
		return [
			`ALTER TABLE ${this.schema}.notes ADD COLUMN IF NOT EXISTS geometry ${postGIS}.geometry(Point, 4326)
  GENERATED ALWAYS AS (CASE WHEN latitude IS NULL OR longitude IS NULL THEN NULL
    ELSE ${postGIS}.st_setsrid(${postGIS}.st_makepoint(longitude, latitude), 4326) END) STORED`,
			`CREATE INDEX IF NOT EXISTS notes_geometry ON ${this.schema}.notes USING gist (geometry)`,
		];
	}

	get schemaVersionSelection(): string {
		return `SELECT coalesce(max(version), 0) AS version FROM ${this.schema}.mirror_schema`;
	}

	schemaVersionUpdate(version: number): string {
		return `UPDATE ${this.schema}.mirror_schema SET version = ${Math.trunc(version)}`;
	}

	/**
	 * Version 2: every edit made in the database (by SQL, QGIS or any other client) is kept in
	 * `changes` until the vault takes it. The plugin's own writes carry `vaultWriterMark` and
	 * are not kept. An edited row is marked so the next copy writes it again from the vault,
	 * whether or not the vault took the edit, and the vault's copy number moves so the plugin
	 * reads the database again.
	 */
	get changesCreation(): string[] {
		const schema = this.schema;
		const edited = quotedLiteral("edited in the database");
		return [
			`CREATE TABLE IF NOT EXISTS ${schema}.changes (
  change_id bigserial PRIMARY KEY,
  vault text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create', 'update', 'delete')),
  path text NOT NULL,
  new_path text,
  set_properties jsonb NOT NULL DEFAULT '{}',
  removed_properties text[] NOT NULL DEFAULT '{}',
  place_changed boolean NOT NULL DEFAULT false,
  latitude double precision,
  longitude double precision,
  made_at timestamptz NOT NULL DEFAULT now(),
  made_by text NOT NULL DEFAULT current_user,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed', 'discarded')),
  settled_at timestamptz,
  message text
)`,
			`CREATE INDEX IF NOT EXISTS changes_pending ON ${schema}.changes (vault, change_id) WHERE status = 'pending'`,
			// A note moved in the database takes its links along.
			`ALTER TABLE ${schema}.links DROP CONSTRAINT IF EXISTS links_vault_source_path_fkey`,
			`ALTER TABLE ${schema}.links ADD CONSTRAINT links_vault_source_path_fkey FOREIGN KEY (vault, source_path)
  REFERENCES ${schema}.notes (vault, path) ON DELETE CASCADE ON UPDATE CASCADE`,
			`CREATE OR REPLACE FUNCTION ${schema}.record_change() RETURNS trigger LANGUAGE plpgsql AS $record_change$
DECLARE
  edited_vault text;
  set_properties jsonb := '{}';
  removed_properties text[] := '{}';
  property text;
  moves boolean;
  places boolean;
BEGIN
  -- The plugin's own writes are the vault's: there is nothing to bring back.
  IF current_setting('obsidian.writer', true) = 'vault' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Rows deleted with their vault's row are not notes to delete.
    IF NOT EXISTS (SELECT 1 FROM ${schema}.vaults WHERE vault = OLD.vault) THEN RETURN OLD; END IF;
    INSERT INTO ${schema}.changes (vault, kind, path) VALUES (OLD.vault, 'delete', OLD.path);
    edited_vault := OLD.vault;
  ELSE
    -- The path is where the note is; name and folder follow it, or move the note when edited alone.
    IF NEW.path IS NULL OR (TG_OP = 'UPDATE' AND NEW.path = OLD.path
        AND (NEW.name IS DISTINCT FROM OLD.name OR NEW.folder IS DISTINCT FROM OLD.folder)) THEN
      NEW.path := CASE WHEN coalesce(NEW.folder, '') = '' THEN '' ELSE NEW.folder || '/' END || NEW.name;
    END IF;
    NEW.path := ltrim(NEW.path, '/');
    IF NEW.path !~* '\\.md$' THEN NEW.path := NEW.path || '.md'; END IF;
    NEW.name := regexp_replace(regexp_replace(NEW.path, '^.*/', ''), '\\.md$', '', 'i');
    NEW.folder := coalesce(substring(NEW.path FROM '^(.*)/[^/]*$'), '');
    NEW.properties := coalesce(NEW.properties, '{}');
    NEW.aliases := coalesce(NEW.aliases, '{}');
    NEW.tags := coalesce(NEW.tags, '{}');
    NEW.modified := coalesce(NEW.modified, now());
    NEW.size_bytes := coalesce(NEW.size_bytes, 0);
    NEW.content_digest := ${edited};
    NEW.links_digest := coalesce(NEW.links_digest, ${edited});
    IF TG_OP = 'INSERT' THEN
      set_properties := NEW.properties;
      IF cardinality(NEW.aliases) > 0 AND NOT set_properties ? 'aliases' THEN
        set_properties := set_properties || jsonb_build_object('aliases', to_jsonb(NEW.aliases));
      END IF;
      INSERT INTO ${schema}.changes (vault, kind, path, set_properties, place_changed, latitude, longitude)
      VALUES (NEW.vault, 'create', NEW.path, set_properties, NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL,
              NEW.latitude, NEW.longitude);
      edited_vault := NEW.vault;
    ELSE
      FOR property IN SELECT jsonb_object_keys(NEW.properties) LOOP
        IF NEW.properties -> property IS DISTINCT FROM OLD.properties -> property THEN
          set_properties := set_properties || jsonb_build_object(property, NEW.properties -> property);
        END IF;
      END LOOP;
      SELECT coalesce(array_agg(key), '{}') INTO removed_properties
      FROM jsonb_object_keys(OLD.properties) AS key WHERE NOT NEW.properties ? key;
      -- Aliases are a property of the note: an edit to the column is one to the property.
      IF NEW.aliases IS DISTINCT FROM OLD.aliases AND NOT set_properties ? 'aliases' THEN
        set_properties := set_properties || jsonb_build_object('aliases', to_jsonb(NEW.aliases));
      END IF;
      moves := NEW.path <> OLD.path;
      places := NEW.latitude IS DISTINCT FROM OLD.latitude OR NEW.longitude IS DISTINCT FROM OLD.longitude;
      -- Other columns (tags written in the text, sizes, dates) are the vault's: the next copy writes them again.
      IF moves OR places OR set_properties <> '{}' OR cardinality(removed_properties) > 0 THEN
        INSERT INTO ${schema}.changes (vault, kind, path, new_path, set_properties, removed_properties, place_changed, latitude, longitude)
        VALUES (OLD.vault, 'update', OLD.path, CASE WHEN moves THEN NEW.path END, set_properties, removed_properties, places,
                NEW.latitude, NEW.longitude);
      END IF;
      edited_vault := OLD.vault;
    END IF;
  END IF;
  UPDATE ${schema}.vaults SET copy_number = copy_number + 1 WHERE vault = edited_vault;
  PERFORM pg_notify(${quotedLiteral(MirrorStatements.changeChannel)}, json_build_object('schema', TG_TABLE_SCHEMA, 'vault', edited_vault)::text);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$record_change$`,
			`DROP TRIGGER IF EXISTS record_change ON ${schema}.notes`,
			`CREATE TRIGGER record_change BEFORE INSERT OR UPDATE OR DELETE ON ${schema}.notes
  FOR EACH ROW EXECUTE FUNCTION ${schema}.record_change()`,
		];
	}

	get changesExistence(): string {
		return `SELECT to_regclass(${quotedLiteral(this.schema + ".changes")}) IS NOT NULL AS answer`;
	}

	get pendingChangeCount(): string {
		return `SELECT count(*)::integer AS count FROM ${this.schema}.changes WHERE vault = $1 AND status = 'pending'`;
	}

	/** The oldest pending edits, locked so that another computer syncing the same vault skips them. */
	get pendingChangeSelection(): string {
		return `SELECT change_id, kind, path, new_path, set_properties, removed_properties, place_changed, latitude, longitude
FROM ${this.schema}.changes WHERE vault = $1 AND status = 'pending'
ORDER BY change_id LIMIT $2 FOR UPDATE SKIP LOCKED`;
	}

	/** Records how each edit in `$1`, a JSON array of `{change_id, status, message}`, went. */
	get changeSettlement(): string {
		return `UPDATE ${this.schema}.changes AS change SET status = settled.status, message = settled.message, settled_at = now()
FROM jsonb_to_recordset($1::jsonb) AS settled(change_id bigint, status text, message text)
WHERE change.change_id = settled.change_id`;
	}

	get pendingChangeDiscarding(): string {
		return `UPDATE ${this.schema}.changes SET status = 'discarded', message = $2, settled_at = now()
WHERE vault = $1 AND status = 'pending'`;
	}

	get tablesExistence(): string {
		return `SELECT to_regclass(${quotedLiteral(this.schema + ".property_columns")}) IS NOT NULL AS answer`;
	}

	get vaultRegistration(): string {
		return `INSERT INTO ${this.schema}.vaults (vault) VALUES ($1) ON CONFLICT (vault) DO NOTHING`;
	}

	/** Serializes copies of one vault, from this device and any other, until the transaction ends. */
	get vaultLock(): string {
		return `SELECT pg_advisory_xact_lock(hashtext(${quotedLiteral(this.schema + ".")} || $1))`;
	}

	get copyNumberSelection(): string {
		return `SELECT copy_number FROM ${this.schema}.vaults WHERE vault = $1 FOR UPDATE`;
	}

	get copyNumberIncrement(): string {
		return `UPDATE ${this.schema}.vaults SET copy_number = copy_number + 1, copied_at = now() WHERE vault = $1 RETURNING copy_number`;
	}

	get copiedNoteSelection(): string {
		return `SELECT path, content_digest, links_digest FROM ${this.schema}.notes WHERE vault = $1`;
	}

	get noteDeletion(): string {
		return `DELETE FROM ${this.schema}.notes WHERE vault = $1 AND path = ANY($2)`;
	}

	get vaultDeletion(): string {
		return `DELETE FROM ${this.schema}.vaults WHERE vault = $1`;
	}

	/** Writes the notes in `$2`, a JSON array of note rows, replacing those already there. */
	get noteUpsert(): string {
		return `INSERT INTO ${this.schema}.notes (vault, path, name, folder, created, modified, size_bytes, tags, aliases, properties,
                             latitude, longitude, content_digest, links_digest)
SELECT $1, copied.path, copied.name, copied.folder, copied.created, copied.modified, copied.size_bytes,
       copied.tags, copied.aliases, copied.properties, copied.latitude, copied.longitude,
       copied.content_digest, copied.links_digest
FROM jsonb_to_recordset($2::jsonb) AS copied(path text, name text, folder text, created timestamptz,
     modified timestamptz, size_bytes bigint, tags text[], aliases text[], properties jsonb,
     latitude double precision, longitude double precision, content_digest text, links_digest text)
ON CONFLICT (vault, path) DO UPDATE SET name = EXCLUDED.name, folder = EXCLUDED.folder, created = EXCLUDED.created,
  modified = EXCLUDED.modified, size_bytes = EXCLUDED.size_bytes, tags = EXCLUDED.tags, aliases = EXCLUDED.aliases,
  properties = EXCLUDED.properties, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
  content_digest = EXCLUDED.content_digest, links_digest = EXCLUDED.links_digest`;
	}

	get linkDeletion(): string {
		return `DELETE FROM ${this.schema}.links WHERE vault = $1 AND source_path = ANY($2)`;
	}

	/** Writes the links in `$2`, a JSON array of link rows. */
	get linkInsertion(): string {
		return `INSERT INTO ${this.schema}.links (vault, source_path, link_number, target, target_path, is_embed, is_in_properties)
SELECT $1, copied.source_path, copied.link_number, copied.target, copied.target_path, copied.is_embed, copied.is_in_properties
FROM jsonb_to_recordset($2::jsonb) AS copied(source_path text, link_number integer, target text, target_path text,
     is_embed boolean, is_in_properties boolean)`;
	}

	get vaultPropertyColumnSelection(): string {
		return `SELECT property_name, property_type FROM ${this.schema}.property_columns WHERE vault = $1`;
	}

	get vaultPropertyColumnDeletion(): string {
		return `DELETE FROM ${this.schema}.property_columns WHERE vault = $1`;
	}

	get vaultPropertyColumnInsertion(): string {
		return `INSERT INTO ${this.schema}.property_columns (vault, property_name, property_type, note_count)
SELECT $1, copied.property_name, copied.property_type, copied.note_count
FROM jsonb_to_recordset($2::jsonb) AS copied(property_name text, property_type text, note_count integer)`;
	}

	/** Every vault's properties, for the columns of `notes_with_properties`. */
	get allPropertyColumnSelection(): string {
		return `SELECT property_name, property_type, note_count FROM ${this.schema}.property_columns`;
	}

	get notesWithPropertiesExistence(): string {
		return `SELECT to_regclass(${quotedLiteral(this.schema + ".notes_with_properties")}) IS NOT NULL AS answer`;
	}

	get notesWithPropertiesDeletion(): string {
		return `DROP VIEW IF EXISTS ${this.schema}.notes_with_properties`;
	}

	/** The links between two placed notes as lines, for a database with PostGIS. */
	linksOnMapView(postGISSchema: string): string {
		const postGIS = quotedIdentifier(postGISSchema);
		const schema = this.schema;
		return `CREATE OR REPLACE VIEW ${schema}.links_on_map AS
SELECT link.vault, link.source_path, link.link_number, link.target_path,
       ${postGIS}.st_makeline(source.geometry, destination.geometry)::${postGIS}.geometry(LineString, 4326) AS geometry
FROM ${schema}.links link
JOIN ${schema}.notes source ON source.vault = link.vault AND source.path = link.source_path
JOIN ${schema}.notes destination ON destination.vault = link.vault AND destination.path = link.target_path
WHERE source.geometry IS NOT NULL AND destination.geometry IS NOT NULL AND source.path <> destination.path`;
	}

	/**
	 * The notes with one typed column per property, merged across vaults by name whatever its
	 * capitals; a property typed differently in two vaults is text. With `validatesInput`
	 * (PostgreSQL 16 and later, `pg_input_is_valid`) dates are dates; before, they stay text,
	 * since casting a malformed date would fail the whole query.
	 */
	notesWithPropertiesView(columns: PropertyColumn[], hasGeometry: boolean, validatesInput: boolean): string {
		const selections = [
			"vault.vault", "note.path", "note.name", "note.folder", "note.created", "note.modified", "note.size_bytes",
			"note.tags", "note.aliases", "note.latitude", "note.longitude",
		];
		if (hasGeometry) selections.push("note.geometry");
		selections.push("note.properties");
		for (const column of viewColumns(columns)) {
			selections.push(`${typedExpression(column.spellings, column.type, validatesInput)} AS ${quotedIdentifier(column.columnName)}`);
		}
		return `CREATE VIEW ${this.schema}.notes_with_properties AS SELECT ${selections.join(",\n  ")}
FROM ${this.schema}.notes note JOIN ${this.schema}.vaults vault ON vault.vault = note.vault`;
	}

	/**
	 * Lets `notes_with_properties` be edited like a table: a typed column written is its property
	 * written, under the spelling the note already uses; a point moved in QGIS is the note's new
	 * place. The edits go to `notes`, whose trigger keeps them for the vault.
	 */
	notesWithPropertiesEditing(columns: PropertyColumn[], postGISSchema: string | null): string[] {
		const schema = this.schema;
		const updates: string[] = [];
		const insertions: string[] = [];
		for (const column of viewColumns(columns)) {
			// A name holding the function's quote would end its body early.
			if ([column.columnName, ...column.spellings].some((name) => name.includes("$edit_note$"))) continue;
			const name = quotedIdentifier(column.columnName);
			const spellings = column.spellings.map(quotedLiteral);
			const mostUsed = spellings[0] ?? "''";
			const spelling = spellings.length === 1
				? mostUsed
				: `CASE ${spellings.map((each) => `WHEN OLD.properties ? ${each} THEN ${each}`).join(" ")} ELSE ${mostUsed} END`;
			updates.push(`  IF NEW.${name} IS DISTINCT FROM OLD.${name} THEN
    edited := (edited - ARRAY[${spellings.join(", ")}]::text[]) || jsonb_build_object(${spelling}, to_jsonb(NEW.${name}));
  END IF;`);
			insertions.push(`    IF NEW.${name} IS NOT NULL THEN edited := edited || jsonb_build_object(${mostUsed}, to_jsonb(NEW.${name})); END IF;`);
		}
		const postGIS = postGISSchema === null ? null : quotedIdentifier(postGISSchema);
		const placing = postGIS === null ? "" : `  IF NEW.geometry IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.geometry IS DISTINCT FROM OLD.geometry) THEN
    NEW.latitude := ${postGIS}.st_y(NEW.geometry);
    NEW.longitude := ${postGIS}.st_x(NEW.geometry);
  END IF;
`;
		return [
			`CREATE OR REPLACE FUNCTION ${schema}.edit_note() RETURNS trigger LANGUAGE plpgsql AS $edit_note$
DECLARE
  edited jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM ${schema}.notes WHERE vault = OLD.vault AND path = OLD.path;
    RETURN OLD;
  END IF;
${placing}  edited := coalesce(NEW.properties, '{}');
  IF TG_OP = 'INSERT' THEN
${insertions.join("\n")}
    INSERT INTO ${schema}.notes (vault, path, name, folder, properties, aliases, latitude, longitude)
    VALUES (NEW.vault, NEW.path, NEW.name, NEW.folder, edited, NEW.aliases, NEW.latitude, NEW.longitude);
    RETURN NEW;
  END IF;
${updates.join("\n")}
  UPDATE ${schema}.notes SET path = NEW.path, name = NEW.name, folder = NEW.folder, properties = edited, aliases = NEW.aliases,
    latitude = NEW.latitude, longitude = NEW.longitude
  WHERE vault = OLD.vault AND path = OLD.path;
  RETURN NEW;
END
$edit_note$`,
			`CREATE TRIGGER edit_note INSTEAD OF INSERT OR UPDATE OR DELETE ON ${schema}.notes_with_properties
  FOR EACH ROW EXECUTE FUNCTION ${schema}.edit_note()`,
		];
	}
}

export function quotedIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A string literal that means the same text whatever `standard_conforming_strings` says: in
 * the `E'…'` form backslashes are always escapes, so they are doubled.
 */
export function quotedLiteral(text: string): string {
	return `E'${text.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export interface ViewColumn {
	columnName: string;
	/** Every spelling vaults use for the property; a note's JSON holds one of them. */
	spellings: string[];
	/** Undefined when the vaults disagree on the type: the column is then text. */
	type: PropertyType | undefined;
}

const utf8 = new TextEncoder();

/**
 * The property columns: merged by lowercased name (the spelling used by most notes wins), the
 * most used first, renamed when a fixed column has the name, left out when the name is too
 * long for an identifier.
 */
export function viewColumns(columns: PropertyColumn[]): ViewColumn[] {
	interface Merged {
		spellings: { name: string; noteCount: number }[];
		types: Set<PropertyType>;
		noteCount: number;
	}
	const mergedByKey = new Map<string, Merged>();
	for (const column of columns) {
		const key = column.propertyName.toLowerCase();
		let merged = mergedByKey.get(key);
		if (!merged) {
			merged = { spellings: [], types: new Set(), noteCount: 0 };
			mergedByKey.set(key, merged);
		}
		const spelling = merged.spellings.find((candidate) => candidate.name === column.propertyName);
		if (spelling) spelling.noteCount += column.noteCount;
		else merged.spellings.push({ name: column.propertyName, noteCount: column.noteCount });
		merged.types.add(column.propertyType);
		merged.noteCount += column.noteCount;
	}
	const bySpellingUse = (left: { name: string; noteCount: number }, right: { name: string; noteCount: number }) =>
		left.noteCount !== right.noteCount ? right.noteCount - left.noteCount : compareText(left.name, right.name);
	const ordered = [...mergedByKey.values()]
		.map((merged) => ({ ...merged, spellings: [...merged.spellings].sort(bySpellingUse) }))
		.sort((left, right) => bySpellingUse(
			{ name: left.spellings[0]?.name ?? "", noteCount: left.noteCount },
			{ name: right.spellings[0]?.name ?? "", noteCount: right.noteCount },
		));
	const result: ViewColumn[] = [];
	const usedNames = new Set(MirrorStatements.fixedViewColumns);
	for (const merged of ordered) {
		const spellings = merged.spellings.map((spelling) => spelling.name);
		let columnName = spellings[0] ?? "";
		if (usedNames.has(columnName)) columnName += " (property)";
		if (columnName === "" || utf8.encode(columnName).length > MirrorStatements.maximumIdentifierBytes || usedNames.has(columnName)) continue;
		usedNames.add(columnName);
		result.push({ columnName, spellings, type: merged.types.size === 1 ? [...merged.types][0] : undefined });
		if (result.length === MirrorStatements.maximumPropertyColumns) break;
	}
	return result;
}

/** The SQL reading one property from `note.properties` as its type. */
export function typedExpression(spellings: string[], type: PropertyType | undefined, validatesInput: boolean): string {
	const accesses = spellings.map((spelling) => `note.properties -> ${quotedLiteral(spelling)}`);
	const value = accesses.length === 1 ? (accesses[0] ?? "") : `COALESCE(${accesses.join(", ")})`;
	const text = `(${value} #>> '{}')`;
	switch (type) {
		case "number":
			return `CASE WHEN jsonb_typeof(${value}) = 'number' THEN ${text}::double precision END`;
		case "checkbox":
			return `CASE WHEN jsonb_typeof(${value}) = 'boolean' THEN ${text}::boolean END`;
		case "date":
			if (!validatesInput) return text;
			return `CASE WHEN jsonb_typeof(${value}) = 'string' AND pg_input_is_valid(${text}, 'date') THEN ${text}::date END`;
		case "datetime":
			if (!validatesInput) return text;
			return `CASE WHEN jsonb_typeof(${value}) = 'string' AND pg_input_is_valid(${text}, 'timestamp') THEN ${text}::timestamp END`;
		case "multitext":
		case "tags":
		case "aliases":
			return `CASE jsonb_typeof(${value}) WHEN 'array' THEN ARRAY(SELECT jsonb_array_elements_text(${value})) WHEN 'string' THEN ARRAY[${text}] END`;
		case "text":
		case undefined:
			return text;
	}
}
