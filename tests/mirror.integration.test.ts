import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import type { DatabaseChange } from "../src/changes.ts";
import { ChangeListener } from "../src/listener.ts";
import type { ConnectionSettings, VaultState } from "../src/mirror.ts";
import { PostgreSQLMirror } from "../src/mirror.ts";
import { columnsByKey, propertyColumns } from "../src/properties.ts";
import type { NoteLink, NoteSource } from "../src/rows.ts";
import { contentDigest, linkRows, linksDigest, noteContent } from "../src/rows.ts";

// Runs against a real server only when asked: MIRROR_TEST_DATABASE=postgres://user@localhost/database npm test
const databaseUrl = process.env.MIRROR_TEST_DATABASE;
const schema = `mirror_test_${process.pid}`;

interface MemoryNote {
	source: NoteSource;
	links: NoteLink[];
}

function note(path: string, frontmatter: Record<string, unknown>, links: NoteLink[] = []): MemoryNote {
	const name = path.replace(/^.*\//, "").replace(/\.md$/, "");
	const folder = path.includes("/") ? path.replace(/\/[^/]*$/, "") : "";
	return {
		source: { path, name, folder, createdMs: Date.UTC(2026, 0, 1), modifiedMs: Date.UTC(2026, 10, 3), sizeBytes: 100, frontmatter, tags: [], aliases: [] },
		links,
	};
}

/** A vault held in memory, read as the plugin reads Obsidian's metadata cache. */
function vaultState(notes: MemoryNote[]): VaultState {
	const columns = propertyColumns(notes.map((each) => each.source.frontmatter), new Map([["rating", "number"]]));
	const byKey = columnsByKey(columns);
	const rows = new Map(notes.map((each) => {
		const content = noteContent(each.source, byKey, ["coordinates"]);
		return [each.source.path, {
			note: { ...content, content_digest: contentDigest(content), links_digest: linksDigest(each.links) },
			links: linkRows(each.links, each.source.path),
		}];
	}));
	return {
		vault: "Test vault",
		digests: new Map([...rows].map(([path, row]) => [path, { contentDigest: row.note.content_digest, linksDigest: row.note.links_digest }])),
		columns,
		rows: (paths) => paths.flatMap((path) => rows.get(path) ?? []),
	};
}

const toParis = { target: "Paris", targetPath: "Paris.md", isEmbed: false, isInProperties: true };
const toNowhere = { target: "Nowhere#Heading", targetPath: null, isEmbed: false, isInProperties: false };

function connectionSettings(schemaName: string): ConnectionSettings {
	const url = new URL(databaseUrl ?? "postgres://localhost/postgres");
	return {
		host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1),
		user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), schema: schemaName, security: "preferred",
	};
}

test("the mirror copies notes, typed properties, links and places, then only what changed", { skip: !databaseUrl }, async (t) => {
	const settings = connectionSettings(schema);
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	t.after(async () => {
		await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		await client.end();
	});
	const hasPostGIS = (await client.query("SELECT 1 FROM pg_extension WHERE extname = 'postgis'")).rowCount === 1;
	const mirror = new PostgreSQLMirror(settings);
	const server = await mirror.describeServer();
	assert.match(server.version, /^\d+/);

	const louvre = note("Places/Louvre.md", { Type: "Museum", rating: "5", visited: "2025-01-26", coordinates: [48.861, 2.336], city: "[[Paris]]" }, [toParis, toNowhere]);
	const paris = note("Paris.md", { type: "City", coordinates: "48.8566, 2.3522", rating: 4 });
	const first = await mirror.copy(vaultState([louvre, paris]));
	assert.deepEqual({ ...first, elapsedMs: 0 }, {
		copiedNoteCount: 2, writtenNoteCount: 2, deletedNoteCount: 0, rewrittenLinkSourceCount: 2, hasGeometry: hasPostGIS, elapsedMs: 0,
	});

	const typed = await client.query(`SELECT path, folder, "Type", rating, visited, latitude FROM "${schema}".notes_with_properties ORDER BY path`);
	assert.deepEqual(typed.rows, [
		{ path: "Paris.md", folder: "", Type: "City", rating: 4, visited: null, latitude: 48.8566 },
		{ path: "Places/Louvre.md", folder: "Places", Type: "Museum", rating: 5, visited: new Date(2025, 0, 26), latitude: 48.861 },
	]);
	const links = await client.query(`SELECT link_number, target, target_path, is_in_properties FROM "${schema}".links ORDER BY link_number`);
	assert.deepEqual(links.rows, [
		{ link_number: 1, target: "Paris", target_path: "Paris.md", is_in_properties: true },
		{ link_number: 2, target: "Nowhere#Heading", target_path: null, is_in_properties: false },
	]);
	if (hasPostGIS) {
		const lines = await client.query(`SELECT source_path, round(ST_Length(geometry::geography)) AS metres FROM "${schema}".links_on_map`);
		assert.deepEqual(lines.rows, [{ source_path: "Places/Louvre.md", metres: 1285 }]);
	}

	const unchanged = await mirror.copy(vaultState([louvre, paris]));
	assert.equal(unchanged.writtenNoteCount + unchanged.deletedNoteCount, 0);

	// Paris deleted: its row goes, and the Louvre's link to it no longer reaches a file.
	const alone = note("Places/Louvre.md", louvre.source.frontmatter ?? {}, [{ ...toParis, targetPath: null }, toNowhere]);
	const third = await mirror.copy(vaultState([alone]));
	assert.deepEqual([third.copiedNoteCount, third.writtenNoteCount, third.deletedNoteCount, third.rewrittenLinkSourceCount], [1, 1, 1, 1]);
	const reached = await client.query(`SELECT count(*)::int AS reached FROM "${schema}".links WHERE target_path IS NOT NULL`);
	assert.equal(reached.rows[0].reached, 0);

	// Another device (or a person) changed the database: a recheck sees it and writes the note again.
	await client.query(`UPDATE "${schema}".notes SET content_digest = 'stale'`);
	const rechecked = await new PostgreSQLMirror(settings).copy(vaultState([alone]), { rechecksDatabase: true });
	assert.equal(rechecked.writtenNoteCount, 1);

	await mirror.forget("Test vault");
	const emptied = await client.query(`SELECT count(*)::int AS notes FROM "${schema}".notes`);
	assert.equal(emptied.rows[0].notes, 0);
});

test("an unreachable server is reported as a connection failure", { skip: !databaseUrl }, async () => {
	const url = new URL(databaseUrl ?? "postgres://localhost/postgres");
	const mirror = new PostgreSQLMirror({
		host: url.hostname, port: 1, database: "postgres", user: "nobody", password: "", schema, security: "off",
	});
	await assert.rejects(mirror.describeServer(), /Could not connect to PostgreSQL at .*:1/);
});

test("edits made in the database wait in changes, reach the vault, and never echo the plugin's own writes", { skip: !databaseUrl }, async (t) => {
	const twoWay = `${schema}_two_way`;
	const settings = connectionSettings(twoWay);
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	let notified = 0;
	const listener = new ChangeListener(settings, "Test vault", () => notified++, {
		setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
		clearTimeout: (timer) => clearTimeout(timer),
	});
	t.after(async () => {
		listener.stop();
		await client.query(`DROP SCHEMA IF EXISTS "${twoWay}" CASCADE`);
		await client.end();
	});
	const query = (sql: string) => client.query(sql.replaceAll("$schema", `"${twoWay}"`));
	const changes = async () => (await query(`SELECT kind, path, new_path, set_properties, removed_properties, status
FROM $schema.changes ORDER BY change_id`)).rows;
	const waitFor = async (condition: () => boolean) => {
		for (let tries = 0; tries < 40 && !condition(); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
	};

	const mirror = new PostgreSQLMirror(settings);
	const louvre = note("Places/Louvre.md", { Type: "Museum", rating: 5, city: "[[Paris]]" }, [toParis]);
	const paris = note("Paris.md", { type: "City" });
	await mirror.copy(vaultState([louvre, paris]));
	assert.deepEqual(await changes(), [], "the plugin's own copy is not an edit");

	listener.start();
	await waitFor(() => notified > 0);
	const notifiedOnConnecting = notified;
	assert.equal(notifiedOnConnecting, 1, "the listener asks for a sync once connected");

	await query(`UPDATE $schema.notes_with_properties SET rating = 3, "Type" = 'Palace' WHERE name = 'Louvre'`);
	await query(`UPDATE $schema.notes SET properties = properties - 'city', name = 'Musée du Louvre' WHERE path = 'Places/Louvre.md'`);
	await query(`INSERT INTO $schema.notes (vault, path, properties) VALUES ('Test vault', 'Inbox/Idea', '{"status": "draft"}')`);
	await query(`DELETE FROM $schema.notes WHERE path = 'Paris.md'`);
	await waitFor(() => notified >= notifiedOnConnecting + 4);
	assert.equal(notified, notifiedOnConnecting + 4, "each edit is notified");
	assert.deepEqual(await changes(), [
		{ kind: "update", path: "Places/Louvre.md", new_path: null, set_properties: { Type: "Palace", rating: 3 }, removed_properties: [], status: "pending" },
		{ kind: "update", path: "Places/Louvre.md", new_path: "Places/Musée du Louvre.md", set_properties: {}, removed_properties: ["city"], status: "pending" },
		{ kind: "create", path: "Inbox/Idea.md", new_path: null, set_properties: { status: "draft" }, removed_properties: [], status: "pending" },
		{ kind: "delete", path: "Paris.md", new_path: null, set_properties: {}, removed_properties: [], status: "pending" },
	]);
	const created = await query(`SELECT name, folder, content_digest FROM $schema.notes WHERE path = 'Inbox/Idea.md'`);
	assert.deepEqual(created.rows, [{ name: "Idea", folder: "Inbox", content_digest: "edited in the database" }]);

	const applied: DatabaseChange[] = [];
	const report = await mirror.bringBack("Test vault", async (change) => {
		if (change.kind === "create") throw new Error("Inbox/Idea.md already exists in the vault");
		applied.push(change);
	}, { largestBatch: 50, confirmed: false });
	assert.deepEqual(report, { appliedCount: 3, failedCount: 1, heldCount: 0, failures: ["Inbox/Idea.md already exists in the vault"] });
	assert.deepEqual(applied.map((change) => change.kind), ["update", "update", "delete"]);
	assert.deepEqual((await changes()).map((change) => change.status), ["applied", "applied", "failed", "applied"]);

	// The vault took the edits; its next copy writes the database back to it, and records nothing.
	const renamed = note("Places/Musée du Louvre.md", { Type: "Palace", rating: 3 });
	const copied = await mirror.copy(vaultState([renamed]));
	assert.equal(copied.copiedNoteCount, 1);
	const rows = await query(`SELECT path, properties FROM $schema.notes ORDER BY path`);
	assert.deepEqual(rows.rows, [{ path: "Places/Musée du Louvre.md", properties: { Type: "Palace", rating: 3 } }]);
	const moved = await query(`SELECT source_path FROM $schema.links`);
	assert.deepEqual(moved.rows, [], "the renamed note's links went with it, then the copy wrote its own (none)");
	assert.equal((await changes()).length, 4);

	// A mistaken statement over many notes waits to be applied or discarded.
	await query(`INSERT INTO $schema.notes (vault, path) SELECT 'Test vault', 'Bulk/' || n FROM generate_series(1, 3) n`);
	const held = await mirror.bringBack("Test vault", async () => assert.fail("held edits are not applied"), { largestBatch: 2, confirmed: false });
	assert.equal(held.heldCount, 3);
	assert.equal(await mirror.discardChanges("Test vault", "test"), 3);
	assert.equal(await mirror.pendingChangeCount("Test vault"), 0);

	// Deleting the vault's row deletes its notes' rows, which are not notes to delete from the vault.
	await query(`DELETE FROM $schema.vaults WHERE vault = 'Test vault'`);
	assert.equal(await mirror.pendingChangeCount("Test vault"), 0);
});

test("a schema of version 1 gains the changes table and its triggers", { skip: !databaseUrl }, async (t) => {
	const older = `${schema}_older`;
	const settings = connectionSettings(older);
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	t.after(async () => {
		await client.query(`DROP SCHEMA IF EXISTS "${older}" CASCADE`);
		await client.end();
	});
	await new PostgreSQLMirror(settings).copy(vaultState([note("A.md", { rating: 1 })]));
	await client.query(`DROP TABLE "${older}".changes; DROP FUNCTION "${older}".record_change() CASCADE;
DROP FUNCTION "${older}".edit_note() CASCADE; UPDATE "${older}".mirror_schema SET version = 1`);

	await new PostgreSQLMirror(settings).copy(vaultState([note("A.md", { rating: 1 })]));
	const version = await client.query(`SELECT version FROM "${older}".mirror_schema`);
	assert.deepEqual(version.rows, [{ version: 2 }]);
	await client.query(`UPDATE "${older}".notes_with_properties SET rating = 2`);
	const recorded = await client.query(`SELECT set_properties FROM "${older}".changes`);
	assert.deepEqual(recorded.rows, [{ set_properties: { rating: 2 } }]);
});
