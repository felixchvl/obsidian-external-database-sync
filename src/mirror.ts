import pg from "pg";
import type { ClientConfig, QueryResultRow } from "pg";
import type { ChangeOutcome, DatabaseChange } from "./changes.ts";
import { databaseChange } from "./changes.ts";
import type { PropertyColumn, PropertyType } from "./properties.ts";
import type { LinkRow, NoteDigests, NoteRow } from "./rows.ts";
import { chunks, mirrorPlan } from "./rows.ts";
import { MirrorStatements } from "./statements.ts";

/** Whether the connection is encrypted, in the terms of PostgreSQL's own `sslmode`. */
export type TransportSecurity =
	/** Encrypted when the server offers it, without checking its certificate (`prefer`). */
	| "preferred"
	/** Always encrypted, and only to a server whose certificate is valid for its name (`verify-full`). */
	| "verified"
	/** Never encrypted, for a server on this computer or a network you trust (`disable`). */
	| "off";

export interface ConnectionSettings {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	/** The schema the mirror's tables and views live in, created if missing. */
	schema: string;
	security: TransportSecurity;
}

/** What must still be filled in before a copy can start, in words; undefined when nothing is missing. */
export function missingSetting(settings: ConnectionSettings): string | undefined {
	if (settings.host.trim() === "") return "the server's address";
	if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) return "a port between 1 and 65535";
	if (settings.database.trim() === "") return "the database's name";
	if (settings.user.trim() === "") return "the user's name";
	if (settings.schema.trim() === "") return "the schema's name";
	return undefined;
}

/** The server a connection reached. */
export interface ServerDescription {
	version: string;
	/** The PostGIS version installed in the database; null without PostGIS. */
	postGISVersion: string | null;
}

/** What one copy did. */
export interface CopyReport {
	/** The vault's notes in the database once the copy committed. */
	copiedNoteCount: number;
	writtenNoteCount: number;
	deletedNoteCount: number;
	/** Notes whose links were written again. */
	rewrittenLinkSourceCount: number;
	/** Whether the notes have a PostGIS point (`geometry`) beside their latitude and longitude. */
	hasGeometry: boolean;
	elapsedMs: number;
}

/** What one copy is made from: every note of the vault as its digests, and the rows of those to write. */
export interface VaultState {
	/** The name that keys the vault's rows. */
	vault: string;
	digests: Map<string, NoteDigests>;
	columns: PropertyColumn[];
	/** The rows of `paths` as the vault holds them now; a note gone since has none. */
	rows(paths: string[]): { note: NoteRow; links: LinkRow[] }[];
}

/** What bringing the database's edits into the vault did. */
export interface BringBackReport {
	appliedCount: number;
	failedCount: number;
	/** Edits waiting for you to apply or discard them: more than a sync applies on its own. */
	heldCount: number;
	/** The first failures, in words. */
	failures: string[];
}

export class MirrorError extends Error {}

interface ServerState extends ServerDescription {
	/** PostgreSQL 16 and later can test a value before a cast (`pg_input_is_valid`). */
	validatesInput: boolean;
	postGISSchema: string | null;
}

interface CopiedVaultState {
	copyNumber: string;
	notes: Map<string, NoteDigests>;
}

/**
 * Keeps a vault and a PostgreSQL schema in step. Copies the vault's notes into the database:
 * notes, typed properties, tags, aliases, links resolved to files, and places, in tables and
 * views other apps read (QGIS among them). Edits made in the database wait in `changes`, where
 * `bringBack` hands them to the vault; the vault stays the reference, and the next copy writes
 * every edited row again from it.
 *
 * Each copy writes only what changed, in one transaction, under a lock per vault, so a copy
 * from another device waits rather than interleaving. Between copies the mirror remembers
 * what the database holds, and does not read it again while its copy number is the one this
 * mirror set; an edit made in the database moves that number.
 */
export class PostgreSQLMirror {
	/** Notes written per statement. */
	static readonly noteChunkSize = 500;
	/** Deleted notes per statement. */
	static readonly pathChunkSize = 2000;

	private readonly settings: ConnectionSettings;
	private readonly statements: MirrorStatements;
	private hasPreparedSchema = false;
	private readonly copiedStates = new Map<string, CopiedVaultState>();

	constructor(settings: ConnectionSettings) {
		this.settings = {
			...settings,
			host: settings.host.trim(),
			database: settings.database.trim(),
			user: settings.user.trim(),
			schema: settings.schema.trim(),
		};
		this.statements = new MirrorStatements(this.settings.schema);
	}

	/** Connects, reads what the server is, and disconnects: the settings' test. */
	async describeServer(): Promise<ServerDescription> {
		return this.withConnection(async (client) => {
			const { version, postGISVersion } = await serverState(client);
			return { version, postGISVersion };
		});
	}

	/**
	 * Copies the vault. Call it once the vault's metadata is read in full: a note missing from
	 * `state` is deleted from the database. `rechecksDatabase` reads what the database holds
	 * again rather than trusting what this mirror last wrote.
	 */
	async copy(state: VaultState, options: { rechecksDatabase?: boolean } = {}): Promise<CopyReport> {
		const start = Date.now();
		try {
			return await this.withConnection((client) => this.write(state, client, start, options.rechecksDatabase ?? false));
		} catch (error) {
			// What the database holds is unknown after a failure; the next copy reads it again.
			this.copiedStates.delete(state.vault);
			this.hasPreparedSchema = false;
			throw error;
		}
	}

	/** Deletes the vault's rows, so the next copy writes every note again; the vault keeps its notes. */
	async forget(vault: string): Promise<void> {
		this.copiedStates.delete(vault);
		await this.withConnection(async (client) => {
			if (!(await exists(client, this.statements.tablesExistence))) return;
			await client.query("BEGIN");
			await client.query(MirrorStatements.vaultWriterMark);
			await client.query(this.statements.vaultDeletion, [vault]);
			await client.query("COMMIT");
		});
	}

	/** How many edits made in the database wait for the vault. */
	async pendingChangeCount(vault: string): Promise<number> {
		return this.withConnection(async (client) => {
			if (!(await exists(client, this.statements.changesExistence))) return 0;
			const counted = await client.query<{ count: number }>(this.statements.pendingChangeCount, [vault]);
			return counted.rows[0]?.count ?? 0;
		});
	}

	/**
	 * Hands the edits made in the database to `apply`, oldest first, and records how each went.
	 * More than `largestBatch` edits wait for `confirmed`, so that a mistaken `UPDATE` or
	 * `DELETE` over the whole table does not reach every note.
	 */
	async bringBack(
		vault: string,
		apply: (change: DatabaseChange) => Promise<string | undefined | void>,
		options: { largestBatch: number; confirmed: boolean },
	): Promise<BringBackReport> {
		const report: BringBackReport = { appliedCount: 0, failedCount: 0, heldCount: 0, failures: [] };
		return this.withConnection(async (client) => {
			if (!(await exists(client, this.statements.changesExistence))) return report;
			const counted = await client.query<{ count: number }>(this.statements.pendingChangeCount, [vault]);
			const pending = counted.rows[0]?.count ?? 0;
			if (pending === 0) return report;
			if (pending > options.largestBatch && !options.confirmed) return { ...report, heldCount: pending };
			await client.query("BEGIN");
			try {
				const selected = await client.query<Parameters<typeof databaseChange>[0]>(
					this.statements.pendingChangeSelection,
					[vault, options.confirmed ? pending : options.largestBatch],
				);
				const outcomes: ChangeOutcome[] = [];
				for (const row of selected.rows) {
					const change = databaseChange(row);
					try {
						const remark = await apply(change);
						outcomes.push({ changeId: change.changeId, status: "applied", message: remark || null });
						report.appliedCount += 1;
					} catch (error) {
						const message = messageOf(error);
						outcomes.push({ changeId: change.changeId, status: "failed", message });
						report.failedCount += 1;
						if (report.failures.length < 5) report.failures.push(message);
					}
				}
				if (outcomes.length > 0) {
					const settled = outcomes.map((outcome) => ({ change_id: outcome.changeId, status: outcome.status, message: outcome.message }));
					await client.query(this.statements.changeSettlement, [JSON.stringify(settled)]);
				}
				await client.query("COMMIT");
				return report;
			} catch (error) {
				await client.query("ROLLBACK").catch(() => undefined);
				throw error;
			}
		});
	}

	/** Gives up the edits waiting for the vault; the next copy writes their rows again from the vault. */
	async discardChanges(vault: string, reason: string): Promise<number> {
		return this.withConnection(async (client) => {
			if (!(await exists(client, this.statements.changesExistence))) return 0;
			const discarded = await client.query(this.statements.pendingChangeDiscarding, [vault, reason]);
			return discarded.rowCount ?? 0;
		});
	}

	private async withConnection<Answer>(work: (client: pg.Client) => Promise<Answer>): Promise<Answer> {
		const client = await openClient(this.settings);
		try {
			return await work(client);
		} catch (error) {
			if (error instanceof MirrorError) throw error;
			throw new MirrorError(`PostgreSQL returned an error: ${messageOf(error)}`, { cause: error });
		} finally {
			// The answer, or the work's own failure, is the one to report.
			await client.end().catch(() => undefined);
		}
	}

	private async write(state: VaultState, client: pg.Client, start: number, rechecksDatabase: boolean): Promise<CopyReport> {
		const statements = this.statements;
		const server = await serverState(client);
		const changesViews = await this.prepareSchema(client, server.postGISSchema);
		const vault = state.vault;
		await client.query("BEGIN");
		try {
			await client.query(MirrorStatements.vaultWriterMark);
			await client.query(statements.vaultRegistration, [vault]);
			await client.query(statements.vaultLock, [vault]);
			const copyNumberRows = await client.query<{ copy_number: string }>(statements.copyNumberSelection, [vault]);
			let copyNumber = copyNumberRows.rows[0]?.copy_number ?? "0";
			const known = this.copiedStates.get(vault);
			let copiedNotes: Map<string, NoteDigests>;
			if (!rechecksDatabase && known && known.copyNumber === copyNumber) {
				copiedNotes = new Map(known.notes);
			} else {
				copiedNotes = new Map();
				const copied = await client.query<{ path: string; content_digest: string; links_digest: string }>(statements.copiedNoteSelection, [vault]);
				for (const row of copied.rows) copiedNotes.set(row.path, { contentDigest: row.content_digest, linksDigest: row.links_digest });
			}
			const plan = mirrorPlan(state.digests, copiedNotes);

			for (const chunk of chunks(plan.notePathsToDelete, PostgreSQLMirror.pathChunkSize)) {
				await client.query(statements.noteDeletion, [vault, chunk]);
				for (const path of chunk) copiedNotes.delete(path);
			}
			let writtenNoteCount = 0;
			let rewrittenLinkSourceCount = 0;
			for (const chunk of chunks(plan.notePathsToWrite, PostgreSQLMirror.noteChunkSize)) {
				// Read now rather than kept from the digests' pass, so memory follows one chunk.
				// A note that changed since is written as it is now.
				const rows = state.rows(chunk);
				if (rows.length === 0) continue;
				const linkSourcePaths: string[] = [];
				const linkRows: LinkRow[] = [];
				for (const { note, links } of rows) {
					if (copiedNotes.get(note.path)?.linksDigest !== note.links_digest) {
						linkSourcePaths.push(note.path);
						linkRows.push(...links);
					}
				}
				await client.query(statements.noteUpsert, [vault, JSON.stringify(rows.map((row) => row.note))]);
				if (linkSourcePaths.length > 0) {
					await client.query(statements.linkDeletion, [vault, linkSourcePaths]);
					if (linkRows.length > 0) await client.query(statements.linkInsertion, [vault, JSON.stringify(linkRows)]);
				}
				for (const { note } of rows) copiedNotes.set(note.path, { contentDigest: note.content_digest, linksDigest: note.links_digest });
				writtenNoteCount += rows.length;
				rewrittenLinkSourceCount += linkSourcePaths.length;
			}

			const changesColumns = await this.replacePropertyColumns(client, vault, state.columns);
			const viewExists = await exists(client, statements.notesWithPropertiesExistence);
			if (changesColumns || changesViews || !viewExists) await this.replaceViews(client, server);
			const changedSomething = plan.notePathsToWrite.length > 0 || plan.notePathsToDelete.length > 0;
			if (changedSomething || changesColumns || changesViews || !viewExists) {
				const incremented = await client.query<{ copy_number: string }>(statements.copyNumberIncrement, [vault]);
				copyNumber = incremented.rows[0]?.copy_number ?? copyNumber;
				await client.query(MirrorStatements.notification);
			}
			await client.query("COMMIT");
			this.copiedStates.set(vault, { copyNumber, notes: copiedNotes });
			return {
				copiedNoteCount: copiedNotes.size,
				writtenNoteCount,
				deletedNoteCount: plan.notePathsToDelete.length,
				rewrittenLinkSourceCount,
				hasGeometry: server.postGISSchema !== null,
				elapsedMs: Date.now() - start,
			};
		} catch (error) {
			// The server rolls the transaction back itself when the connection ends.
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		}
	}

	/**
	 * Creates the schema the first time, brings an older one to the current version, and adds
	 * the geometry column once PostGIS is installed. Returns whether the views must be defined
	 * again: they show the geometry, and version 2 makes them editable.
	 */
	private async prepareSchema(client: pg.Client, postGISSchema: string | null): Promise<boolean> {
		let migrated = false;
		if (!this.hasPreparedSchema) {
			if (!(await exists(client, this.statements.tablesExistence))) {
				// Creating a schema needs a right on the database that using an existing one does not.
				const statementsToRun = this.statements.schemaCreation;
				if (await exists(client, "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS answer", [this.settings.schema])) {
					statementsToRun.shift();
				}
				for (const statement of statementsToRun) await client.query(statement);
			}
			const versions = await client.query<{ version: number }>(this.statements.schemaVersionSelection);
			if ((versions.rows[0]?.version ?? 0) < MirrorStatements.schemaVersion) {
				await client.query("BEGIN");
				try {
					for (const statement of this.statements.changesCreation) await client.query(statement);
					await client.query(this.statements.schemaVersionUpdate(MirrorStatements.schemaVersion));
					await client.query("COMMIT");
				} catch (error) {
					await client.query("ROLLBACK").catch(() => undefined);
					throw error;
				}
				migrated = true;
			}
			this.hasPreparedSchema = true;
		}
		if (postGISSchema === null) return migrated;
		const hasGeometry = await exists(
			client,
			`SELECT EXISTS (SELECT 1 FROM information_schema.columns
  WHERE table_schema = $1 AND table_name = 'notes' AND column_name = 'geometry') AS answer`,
			[this.settings.schema],
		);
		if (hasGeometry) return migrated;
		for (const statement of this.statements.geometryColumnCreation(postGISSchema)) await client.query(statement);
		return true;
	}

	/** Records the vault's properties for the view; returns whether their names or types changed. */
	private async replacePropertyColumns(client: pg.Client, vault: string, columns: PropertyColumn[]): Promise<boolean> {
		const stored = await client.query<{ property_name: string; property_type: string }>(this.statements.vaultPropertyColumnSelection, [vault]);
		const storedTypes = new Map(stored.rows.map((row) => [row.property_name, row.property_type]));
		const currentTypes = new Map<string, string>();
		for (const column of columns) if (!currentTypes.has(column.propertyName)) currentTypes.set(column.propertyName, column.propertyType);
		await client.query(this.statements.vaultPropertyColumnDeletion, [vault]);
		if (columns.length > 0) {
			const rows = columns.map((column) => ({
				property_name: column.propertyName,
				property_type: column.propertyType,
				note_count: column.noteCount,
			}));
			await client.query(this.statements.vaultPropertyColumnInsertion, [vault, JSON.stringify(rows)]);
		}
		if (storedTypes.size !== currentTypes.size) return true;
		for (const [name, type] of currentTypes) if (storedTypes.get(name) !== type) return true;
		return false;
	}

	/** Defines `notes_with_properties` from every vault's properties, and `links_on_map` with PostGIS. */
	private async replaceViews(client: pg.Client, server: ServerState): Promise<void> {
		const stored = await client.query<{ property_name: string; property_type: string; note_count: number }>(
			this.statements.allPropertyColumnSelection,
		);
		const columns: PropertyColumn[] = stored.rows.map((row) => ({
			propertyName: row.property_name,
			propertyType: row.property_type as PropertyType,
			noteCount: row.note_count,
		}));
		// Dropped and created, not replaced: a replaced view cannot lose or retype a column.
		// A view of your own that reads this one makes the drop fail, and the copy says so.
		await client.query(this.statements.notesWithPropertiesDeletion);
		await client.query(this.statements.notesWithPropertiesView(columns, server.postGISSchema !== null, server.validatesInput));
		for (const statement of this.statements.notesWithPropertiesEditing(columns, server.postGISSchema)) await client.query(statement);
		if (server.postGISSchema !== null) await client.query(this.statements.linksOnMapView(server.postGISSchema));
	}
}

/** A connection to the server, encrypted as `settings.security` asks. */
export async function openClient(settings: ConnectionSettings, options: { keepAlive?: boolean } = {}): Promise<pg.Client> {
	const { port, password, security } = settings;
	// Pasted values often carry spaces.
	const [host, database, user] = [settings.host.trim(), settings.database.trim(), settings.user.trim()];
	const base: ClientConfig = {
		host, port, database, user, password,
		connectionTimeoutMillis: 10_000,
		application_name: "Obsidian PostgreSQL Sync",
		keepAlive: options.keepAlive ?? false,
	};
	const open = async (ssl: ClientConfig["ssl"]) => {
		const client = new pg.Client({ ...base, ssl });
		// A connection that drops between queries reports here; the query in flight fails on its own.
		client.on("error", () => undefined);
		await client.connect();
		return client;
	};
	try {
		switch (security) {
			case "off":
				return await open(false);
			case "verified":
				return await open({ rejectUnauthorized: true });
			case "preferred":
				try {
					return await open({ rejectUnauthorized: false });
				} catch (error) {
					if (!/does not support SSL/i.test(messageOf(error))) throw error;
					return await open(false);
				}
		}
	} catch (error) {
		throw new MirrorError(`Could not connect to PostgreSQL at ${host}:${port}: ${messageOf(error)}`, { cause: error });
	}
}

async function serverState(client: pg.Client): Promise<ServerState> {
	const versions = await client.query<{ version: string; number: string }>(
		"SELECT current_setting('server_version') AS version, current_setting('server_version_num') AS number",
	);
	const version = versions.rows[0]?.version ?? "";
	const versionNumber = Number(versions.rows[0]?.number ?? 0);
	const postGIS = await client.query<{ schema: string; version: string }>(
		`SELECT namespace.nspname AS schema, extension.extversion AS version FROM pg_extension extension
  JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace WHERE extension.extname = 'postgis'`,
	);
	return {
		version,
		postGISVersion: postGIS.rows[0]?.version ?? null,
		validatesInput: versionNumber >= 160000,
		postGISSchema: postGIS.rows[0]?.schema ?? null,
	};
}

async function exists(client: pg.Client, sql: string, values: unknown[] = []): Promise<boolean> {
	const result = await client.query<QueryResultRow & { answer: boolean }>(sql, values);
	return result.rows[0]?.answer === true;
}

export function messageOf(error: unknown): string {
	if (error instanceof Error) {
		const aggregate = error as Error & { errors?: unknown[] };
		// Node reports a refused connection to every address of a host as one AggregateError without a message.
		if (error.message === "" && Array.isArray(aggregate.errors) && aggregate.errors.length > 0) return messageOf(aggregate.errors[0]);
		return error.message;
	}
	return String(error);
}
