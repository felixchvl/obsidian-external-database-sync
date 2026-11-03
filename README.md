# PostgreSQL Bridge

An Obsidian plugin that syncs your vault with PostgreSQL, both ways.

- **From the vault to the database:** notes, properties typed as the Properties view types them, tags, aliases, links resolved to files, and places, with a PostGIS point when the database has PostGIS.
- **From the database to the vault:** edit a property, move or rename a note, create one or delete one in SQL, in QGIS or in any other client, and the change reaches your notes within seconds.

The text of your notes stays in the vault: the database holds what is around it. Use the plugin to query the vault in SQL, join it with other data, draw it and edit it in QGIS, or let tools and agents read and update your notes' properties.

## What you get

The plugin creates a schema (`obsidian` by default) with:

| Table or view | What it holds |
| --- | --- |
| `notes` | One row per note: `path`, `name`, `folder`, `created`, `modified`, `size_bytes`, `tags`, `aliases`, `properties` (JSONB), `latitude`, `longitude`, and `geometry` with PostGIS |
| `notes_with_properties` | The notes with one typed column per property: numbers are `double precision`, checkboxes `boolean`, dates `date` (PostgreSQL 16 and later), lists `text[]`. You can edit it like a table |
| `links` | One row per link, in the order you wrote them: `target` as written, `target_path` it reaches (null when broken), `is_embed`, `is_in_properties` |
| `links_on_map` | With PostGIS, the links between two placed notes as lines |
| `property_columns` | The vault's properties, their type and how many notes use them |
| `changes` | Every edit made in the database, and whether it reached the vault |
| `vaults` | The vaults synced into the schema, so several vaults can share one |

Types come from `.obsidian/types.json`, then from the property's name (`tags`, `aliases`), then from its first value. Every capitalization of a property is one property, named as most notes spell it.

A note is placed by the first of its location properties that holds `[lat, lng]` or `"lat, lng"`. By default these are the property the Map View and Geocoding Properties plugins use, then `coordinates` and `location`; you can name your own in the settings.

Some queries:

```sql
-- Books rated 4 or more, with their tags
SELECT name, rating, tags FROM obsidian.notes_with_properties
WHERE 'Book' = ANY(type) AND rating >= 4 ORDER BY rating DESC;

-- Broken links
SELECT source_path, target FROM obsidian.links WHERE target_path IS NULL;

-- The notes most linked to
SELECT target_path, count(*) FROM obsidian.links
WHERE target_path IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

-- Places within 2 km of the Louvre (PostGIS)
SELECT name FROM obsidian.notes
WHERE ST_DWithin(geometry::geography, ST_MakePoint(2.336, 48.861)::geography, 2000);
```

## Editing from the database

```sql
-- A property, through its typed column: rating: 5 in Louvre.md
UPDATE obsidian.notes_with_properties SET rating = 5 WHERE name = 'Louvre';

-- Properties through the JSON: add one, remove another
UPDATE obsidian.notes SET properties = (properties - 'draft') || '{"status": "visited"}'
WHERE path = 'Places/Louvre.md';

-- Rename or move a note: change its path, or its name or folder
UPDATE obsidian.notes SET folder = 'Archive' WHERE path = 'Places/Louvre.md';

-- Place a note: its location property gets the point, in the format it already uses
UPDATE obsidian.notes SET latitude = 48.8606, longitude = 2.3376 WHERE name = 'Louvre';

-- Create a note, with its properties (the path gets .md if it lacks it)
INSERT INTO obsidian.notes (vault, path, properties)
VALUES ('My vault', 'Inbox/Call Paul', '{"status": "todo"}');

-- Delete a note: it goes to the trash you chose in Obsidian
DELETE FROM obsidian.notes WHERE path = 'Inbox/Call Paul.md';
```

In QGIS, a layer on `notes_with_properties`, keyed by `vault` and `path`, edits notes on the map: moving a point moves the note's place. Set layers to **Refresh layer on notification** with the `qgis` channel to see the vault's changes as they come.

How edits come back:

- A trigger keeps each edit in `changes`, with who made it and when. The plugin hears of it at once (PostgreSQL's `LISTEN`), applies it through Obsidian, and records whether it was `applied` or why it `failed`.
- The vault stays the reference: once an edit is applied, the plugin copies the note again, so the database holds what the note now says. An edit the vault cannot take (a note that is gone, a column such as `size_bytes` that only the vault decides) is written over at the next sync.
- When the vault and the database change the same property, the last edit applied wins.
- A move updates the links to the note when Obsidian's **Automatically update internal links** is on; otherwise the note moves alone, and `changes` says so.

Safeguards:

- More than 50 edits at once wait for you: apply them or discard them from the settings, the command palette or the terminal. A mistaken `UPDATE` or `DELETE` without `WHERE` does not reach your notes.
- Deleted notes go to the trash, never further.
- The database writes Markdown notes only, inside the vault, out of hidden folders (`.obsidian`, `.trash`) and out of the folders you exclude.
- Deleting a vault's row from `vaults` deletes its rows, not its notes.
- Turn off **Bring database edits into the vault** to sync one way only: the vault then writes over what the database changes.

## Setting it up

1. Install the plugin, then open **Settings → PostgreSQL Bridge**.
2. Fill in the server, database and user. The password goes in Obsidian's secret storage, never in the plugin's settings file.
3. Select **Test** to check the connection.
4. Turn on **Sync automatically**. The plugin syncs now, then each change a few seconds after you make it, in the vault or in the database.

The user needs to create tables, functions and triggers in the schema, or in the database if the schema does not exist yet. For geometry, install PostGIS in the database (`CREATE EXTENSION postgis`) before or after the first sync.

The plugin runs on desktop only: it talks to PostgreSQL directly over the network.

## From the terminal

With the [Obsidian CLI](https://help.obsidian.md/cli) and Obsidian open:

```bash
obsidian postgresql-bridge                # where the vault syncs and how the last sync went
obsidian postgresql-bridge:test           # connect and show the server's version
obsidian postgresql-bridge:sync           # sync now
obsidian postgresql-bridge:sync apply     # sync, applying however many edits the database holds
obsidian postgresql-bridge:sync rebuild   # delete the vault's rows and copy every note again
obsidian postgresql-bridge:discard        # discard the edits the database holds, then sync
```

## How it copies

Each copy compares a digest of every note, and of its links, with those in the database, and writes only what changed, in one transaction. A lock per vault makes copies from two computers wait for each other rather than interleave, and two computers syncing one vault never apply the same database edit twice. Notes Obsidian has not read again are not read again, and links resolve again only for notes that name a file that came, went or was renamed.

On a vault of 20,000 notes, the first copy takes about five seconds; after that, a change is copied in a few dozen milliseconds.

## Privacy

The plugin sends your notes' metadata (paths, properties, tags, aliases, links and places) to the PostgreSQL server you set, and nowhere else, and writes back into your notes only what that database's users change. It does not copy the text of your notes. There is no telemetry.

## Development

```bash
npm install
npm run dev     # rebuild main.js on every change
npm run build   # type-check and build for release
npm test        # unit tests
npm run lint
```

The integration tests need a PostgreSQL server; they create schemas of their own and drop them:

```bash
MIRROR_TEST_DATABASE=postgres://user@localhost/database npm test
```

To try the plugin, copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/postgresql-bridge/`, then enable it in **Settings → Community plugins**.

The tables are those of [Graphite](https://github.com/Graphite-Note/Graphite)'s PostgreSQL Mirror, with `changes` beside them. Give each its own schema: to this plugin, Graphite's copies would be edits made in the database.

## License

[MIT](LICENSE)
