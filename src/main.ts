import type { TAbstractFile } from "obsidian";
import { Notice, Plugin, normalizePath } from "obsidian";
import type { BringBackReport, ConnectionSettings, CopyReport } from "./mirror.ts";
import { ChangeListener } from "./listener.ts";
import { MirrorError, PostgreSQLMirror, messageOf, missingSetting } from "./mirror.ts";
import { declaredTypes, defaultPlacePropertyNames, distinctNames } from "./properties.ts";
import type { SyncSettings } from "./settings.ts";
import { SyncSettingTab, defaultSettings } from "./settings.ts";
import { VaultReader } from "./vault-reader.ts";
import { VaultWriter } from "./vault-writer.ts";

/** A change is synced once the vault has been still this long… */
const quietDelayMs = 2_000;
/** …or this long after the first change, while you keep typing. */
const longestDelayMs = 30_000;
/** More edits from the database than this wait for you to apply them. */
const largestAutomaticBatch = 50;
/** How long a sync waits for Obsidian to read the notes it just edited before copying them. */
const metadataWaitMs = 3_000;
/** A plugin's settings file larger than this is not read: it is not the plugin's to trust. */
const largestSettingsFileBytes = 1_048_576;

interface SyncReport {
	copy: CopyReport;
	/** Undefined when bringing edits back is turned off. */
	brought: BringBackReport | undefined;
}

type SyncStatus =
	| { kind: "idle" }
	| { kind: "syncing" }
	| { kind: "synced"; report: SyncReport; at: Date }
	| { kind: "failed"; message: string; at: Date };

interface SyncOptions {
	/** Deletes the vault's rows first, so every note is written again. */
	rebuilds: boolean;
	/** Reads what the database holds again rather than trusting the last copy. */
	rechecksDatabase: boolean;
	/** Applies the database's edits however many there are. */
	appliesHeldEdits: boolean;
}

export default class PostgreSQLSyncPlugin extends Plugin {
	settings: SyncSettings = { ...defaultSettings };
	private reader!: VaultReader;
	private writer!: VaultWriter;
	private mirror: PostgreSQLMirror | undefined;
	private mirrorKey = "";
	private listener: ChangeListener | undefined;
	private listenerKey = "";
	private statusBar!: HTMLElement;
	private status: SyncStatus = { kind: "idle" };
	/** The edits the database holds for you to apply, as the last sync found them. */
	heldEditCount = 0;
	private isLayoutReady = false;
	private timer: number | undefined;
	private firstChangeAt: number | undefined;
	/** The sync running now, which the next one waits for: one sync at a time. */
	private running: Promise<unknown> = Promise.resolve();
	/** A scheduled sync waiting for the running one; later changes join it. */
	private waiting: Promise<SyncReport> | undefined;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.reader = new VaultReader(this.app);
		this.writer = new VaultWriter(this.app);
		this.statusBar = this.addStatusBarItem();
		this.addSettingTab(new SyncSettingTab(this.app, this));

		const notify = (work: Promise<unknown>) => void work.catch((error: unknown) => new Notice(messageOf(error)));
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => notify(this.syncNow()) });
		this.addCommand({ id: "copy-every-note-again", name: "Copy every note again", callback: () => notify(this.syncNow({ rebuilds: true })) });
		this.addCommand({
			id: "apply-held-edits",
			name: "Apply the edits held in the database",
			callback: () => notify(this.syncNow({ appliesHeldEdits: true })),
		});
		this.addCommand({
			id: "discard-held-edits",
			name: "Discard the edits held in the database",
			callback: () => notify(this.discardHeldEdits().then((count) => new Notice(`${count} edits discarded.`))),
		});
		this.addCommand({
			id: "test-connection",
			name: "Test the connection",
			callback: () => notify(this.describeServer().then((description) => new Notice(description))),
		});
		this.registerCommandLine();

		this.app.workspace.onLayoutReady(() => {
			this.isLayoutReady = true;
			// Registered once the vault is loaded: Obsidian reports every file as created while it loads.
			this.registerEvent(this.app.vault.on("create", (file) => this.fileChanged(file)));
			this.registerEvent(this.app.vault.on("delete", (file) => this.fileChanged(file)));
			this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.fileChanged(file, oldPath)));
			this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleSync()));
			this.registerEvent(this.app.metadataCache.on("deleted", () => this.scheduleSync()));
			// Obsidian has read every note: the copy can no longer miss one.
			this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleSync()));
			this.scheduleSync(0);
			this.updateListener();
		});
		this.showStatus();
	}

	onunload(): void {
		window.clearTimeout(this.timer);
		this.listener?.stop();
	}

	async loadSettings(): Promise<void> {
		this.settings = { ...defaultSettings, ...((await this.loadData()) as Partial<SyncSettings> | null) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.showStatus();
		this.updateListener();
	}

	private fileChanged(file: TAbstractFile, oldPath?: string): void {
		this.reader.fileChanged(file, oldPath);
		this.scheduleSync();
	}

	/** Listens for the database's edits while syncing automatically and bringing them back, so they arrive within seconds. */
	private updateListener(): void {
		const connection = this.connectionSettings();
		const listens = this.isLayoutReady && this.settings.copiesAutomatically && this.settings.bringsBackEdits
			&& missingSetting(connection) === undefined;
		const key = listens ? JSON.stringify([connection, this.vaultName()]) : "";
		if (key === this.listenerKey) return;
		this.listener?.stop();
		this.listener = undefined;
		this.listenerKey = key;
		if (!listens) return;
		this.listener = new ChangeListener(connection, this.vaultName(), () => this.scheduleSync(500), {
			setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
			clearTimeout: (timer) => window.clearTimeout(timer),
		});
		this.listener.start();
	}

	/** Syncs soon, once the vault has been still for a moment, when syncing automatically. */
	scheduleSync(delayMs = quietDelayMs): void {
		if (!this.settings.copiesAutomatically || !this.isLayoutReady) return;
		const now = Date.now();
		this.firstChangeAt ??= now;
		const delay = Math.max(0, Math.min(delayMs, this.firstChangeAt + longestDelayMs - now));
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.firstChangeAt = undefined;
			void this.scheduledSync();
		}, delay);
	}

	private async scheduledSync(): Promise<void> {
		const wasFailing = this.status.kind === "failed";
		const heldBefore = this.heldEditCount;
		try {
			const report = await this.enqueueSync({ rebuilds: false, rechecksDatabase: false, appliesHeldEdits: false });
			const brought = report.brought;
			if (brought && brought.heldCount > 0 && brought.heldCount !== heldBefore) {
				new Notice(`PostgreSQL Sync: the database holds ${brought.heldCount} edits, more than ${largestAutomaticBatch} at once. `
					+ "Run “Apply the edits held in the database” to bring them into your notes, or “Discard” them.", 15_000);
			}
			if (brought && brought.failedCount > 0) {
				new Notice(`PostgreSQL Sync: ${brought.failedCount} edits from the database could not be applied: ${brought.failures.join("; ")}`, 15_000);
			}
		} catch (error) {
			// Obsidian is still reading the vault: the `resolved` event schedules the sync again.
			if (error instanceof VaultNotReadError) return;
			// Said once, not at every change while the server stays unreachable.
			if (!wasFailing) new Notice(`PostgreSQL Sync: ${messageOf(error)}`);
		}
	}

	/** Syncs now, whether or not syncing is automatic. */
	async syncNow(options: { rebuilds?: boolean; appliesHeldEdits?: boolean } = {}): Promise<SyncReport> {
		return this.enqueueSync({
			rebuilds: options.rebuilds ?? false,
			rechecksDatabase: true,
			appliesHeldEdits: options.appliesHeldEdits ?? false,
		});
	}

	/** Gives up the edits the database holds; the next copy writes their rows again from the vault. */
	async discardHeldEdits(): Promise<number> {
		const connection = this.connectionSettings();
		const missing = missingSetting(connection);
		if (missing) throw new MirrorError(`Fill in ${missing} in the settings.`);
		const count = await this.mirrorFor(connection).discardChanges(this.vaultName(), "Discarded from Obsidian.");
		this.heldEditCount = 0;
		await this.syncNow();
		return count;
	}

	private enqueueSync(options: SyncOptions): Promise<SyncReport> {
		const joinsWaitingSync = !options.rebuilds && !options.rechecksDatabase && !options.appliesHeldEdits;
		if (joinsWaitingSync && this.waiting) return this.waiting;
		const sync: Promise<SyncReport> = this.running
			.catch(() => undefined)
			.then(() => {
				if (this.waiting === sync) this.waiting = undefined;
				return this.syncOnce(options);
			});
		if (joinsWaitingSync) this.waiting = sync;
		this.running = sync;
		return sync;
	}

	/** Brings the database's edits into the vault, then copies the vault into the database. */
	private async syncOnce(options: SyncOptions): Promise<SyncReport> {
		const connection = this.connectionSettings();
		const missing = missingSetting(connection);
		if (missing) throw this.failed(new MirrorError(`Fill in ${missing} in the settings.`));
		const mirror = this.mirrorFor(connection);
		const vault = this.vaultName();
		const excludedFolders = this.settings.excludedFolders.split("\n");
		this.status = { kind: "syncing" };
		this.showStatus();
		try {
			const placePropertyNames = await this.placePropertyNames();
			let brought: BringBackReport | undefined;
			if (this.settings.bringsBackEdits) {
				brought = await mirror.bringBack(
					vault,
					(change) => this.writer.apply(change, { placePropertyNames, excludedFolders }),
					{ largestBatch: largestAutomaticBatch, confirmed: options.appliesHeldEdits },
				);
				this.heldEditCount = brought.heldCount;
				// The copy reads what Obsidian makes of the notes just edited.
				if (brought.appliedCount > 0) await this.metadataSettled();
			} else {
				await mirror.discardChanges(vault, "Bringing database edits into the vault is turned off.");
				this.heldEditCount = 0;
			}
			const typesJson = await this.readConfigFile("types.json");
			const state = this.reader.state({ vault, declaredTypes: declaredTypes(typesJson), placePropertyNames, excludedFolders });
			if (!state) throw new VaultNotReadError("Obsidian is still reading the vault; try again in a moment.");
			if (options.rebuilds) await mirror.forget(vault);
			const copy = await mirror.copy(state, { rechecksDatabase: options.rechecksDatabase || (brought?.appliedCount ?? 0) > 0 });
			const report = { copy, brought };
			this.status = { kind: "synced", report, at: new Date() };
			return report;
		} catch (error) {
			if (error instanceof VaultNotReadError) {
				this.status = { kind: "idle" };
				throw error;
			}
			throw this.failed(error);
		} finally {
			this.showStatus();
		}
	}

	/** Waits until Obsidian has read the vault's latest changes, or a few seconds at most. */
	private metadataSettled(): Promise<void> {
		return new Promise((resolve) => {
			const settled = () => {
				this.app.metadataCache.offref(reference);
				window.clearTimeout(timeout);
				resolve();
			};
			const reference = this.app.metadataCache.on("resolved", settled);
			const timeout = window.setTimeout(settled, metadataWaitMs);
		});
	}

	private failed(error: unknown): unknown {
		this.status = { kind: "failed", message: messageOf(error), at: new Date() };
		this.showStatus();
		return error;
	}

	/** The server's version and PostGIS's, in words. */
	async describeServer(): Promise<string> {
		const connection = this.connectionSettings();
		const missing = missingSetting(connection);
		if (missing) throw new MirrorError(`Fill in ${missing} in the settings.`);
		const server = await new PostgreSQLMirror(connection).describeServer();
		const postGIS = server.postGISVersion ? `PostGIS ${server.postGISVersion}` : "no PostGIS (notes keep their latitude and longitude)";
		return `Connected: PostgreSQL ${server.version}, ${postGIS}.`;
	}

	private connectionSettings(): ConnectionSettings {
		const settings = this.settings;
		const secret = settings.passwordSecret ? this.app.secretStorage.getSecret(settings.passwordSecret) : null;
		return {
			host: settings.host,
			port: settings.port,
			database: settings.database,
			user: settings.user,
			password: secret ?? "",
			schema: settings.schema,
			security: settings.security,
		};
	}

	/** One mirror per server and schema, so it remembers what the database holds between syncs. */
	private mirrorFor(connection: ConnectionSettings): PostgreSQLMirror {
		const key = JSON.stringify(connection);
		if (!this.mirror || key !== this.mirrorKey) {
			this.mirror = new PostgreSQLMirror(connection);
			this.mirrorKey = key;
		}
		return this.mirror;
	}

	private vaultName(): string {
		return this.settings.vaultName.trim() || this.app.vault.getName();
	}

	/** The properties that place a note: those set in the settings, else those the map plugins use. */
	async placePropertyNames(): Promise<string[]> {
		const written = distinctNames(this.settings.placeProperties.split(","));
		return written.length > 0 ? written : this.automaticPlacePropertyNames();
	}

	/**
	 * The properties the vault's map plugins place notes with: the one the Geocoding Properties
	 * plugin writes coordinates into, the one the Map View plugin reads, then `coordinates`
	 * and `location`.
	 */
	async automaticPlacePropertyNames(): Promise<string[]> {
		const geocoding = await this.readPluginSettings("geocoding-properties");
		const mapView = await this.readPluginSettings("obsidian-map-view");
		const location = (geocoding?.properties as Record<string, unknown> | undefined)?.location as Record<string, unknown> | undefined;
		return distinctNames([
			location && location.enabled !== false && typeof location.frontmatterKey === "string" ? location.frontmatterKey : undefined,
			typeof mapView?.frontMatterKey === "string" ? mapView.frontMatterKey : undefined,
			...defaultPlacePropertyNames,
		]);
	}

	private async readPluginSettings(pluginId: string): Promise<Record<string, unknown> | undefined> {
		const text = await this.readConfigFile(`plugins/${pluginId}/data.json`);
		if (!text) return undefined;
		try {
			const parsed: unknown = JSON.parse(text);
			return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	}

	/** A file of the vault's configuration folder, or null when it is missing or too large. */
	private async readConfigFile(relativePath: string): Promise<string | null> {
		const path = normalizePath(`${this.app.vault.configDir}/${relativePath}`);
		try {
			const stat = await this.app.vault.adapter.stat(path);
			if (!stat || stat.type !== "file" || stat.size > largestSettingsFileBytes) return null;
			return await this.app.vault.adapter.read(path);
		} catch {
			return null;
		}
	}

	/** The last sync, in words, for the settings, the status bar's tooltip and the command line. */
	statusText(): string {
		const status = this.status;
		switch (status.kind) {
			case "idle":
				return this.settings.copiesAutomatically ? "Waiting for Obsidian to read the vault." : "Not synced yet: turn on Sync automatically, or sync now.";
			case "syncing":
				return "Syncing…";
			case "synced": {
				const { copy, brought } = status.report;
				const copied = copy.writtenNoteCount + copy.deletedNoteCount === 0
					? "nothing to copy"
					: `${copy.writtenNoteCount} notes written, ${copy.deletedNoteCount} deleted`;
				const geometry = copy.hasGeometry ? ", with PostGIS points" : "";
				const edits = [
					brought && brought.appliedCount > 0 ? `${brought.appliedCount} edits from the database applied` : "",
					brought && brought.failedCount > 0 ? `${brought.failedCount} could not be (${brought.failures.join("; ")})` : "",
					brought && brought.heldCount > 0 ? `${brought.heldCount} held for you to apply or discard` : "",
				].filter((part) => part !== "");
				return `${copy.copiedNoteCount} notes in PostgreSQL${geometry} at ${status.at.toLocaleTimeString()}: `
					+ [copied, ...edits].join(", ") + ` (${copy.elapsedMs} ms).`;
			}
			case "failed":
				return `Failed at ${status.at.toLocaleTimeString()}: ${status.message}`;
		}
	}

	private showStatus(): void {
		const status = this.status;
		const label = status.kind === "syncing" ? "PostgreSQL: syncing…"
			: status.kind === "failed" ? "PostgreSQL: sync failed"
			: status.kind === "synced" ? `PostgreSQL: ${status.report.copy.copiedNoteCount} notes`
				+ (this.heldEditCount > 0 ? `, ${this.heldEditCount} edits held` : "")
			: "";
		this.statusBar.setText(this.settings.copiesAutomatically || status.kind !== "idle" ? label : "");
		this.statusBar.setAttribute("aria-label", this.statusText());
	}

	/** `obsidian postgresql-sync`, `…:sync`, `…:discard` and `…:test`, for the terminal, scripts and agents. */
	private registerCommandLine(): void {
		const answer = async (work: () => Promise<string>) => {
			try {
				return await work();
			} catch (error) {
				return `Error: ${messageOf(error)}`;
			}
		};
		this.registerCliHandler("postgresql-sync", "Show where the vault syncs and how the last sync went", null, () => {
			const settings = this.settings;
			return [
				`Server: ${settings.user || "?"}@${settings.host}:${settings.port}/${settings.database || "?"}, schema ${settings.schema}`,
				`Vault: ${this.vaultName()}`,
				`Syncs automatically: ${settings.copiesAutomatically ? "yes" : "no"}`,
				`Brings database edits into the vault: ${settings.bringsBackEdits ? "yes" : "no"}`,
				`Last sync: ${this.statusText()}`,
			].join("\n");
		});
		this.registerCliHandler(
			"postgresql-sync:sync",
			"Sync now: bring the database's edits into the vault, then copy the vault into the database",
			{
				rebuild: { description: "Delete the vault's rows first, and copy every note again" },
				apply: { description: `Apply the database's edits even when there are more than ${largestAutomaticBatch}` },
			},
			(params) => answer(async () => {
				await this.syncNow({ rebuilds: params.rebuild === "true", appliesHeldEdits: params.apply === "true" });
				return this.statusText();
			}),
		);
		this.registerCliHandler("postgresql-sync:discard", "Discard the edits held in the database, then sync", null, () =>
			answer(async () => `${await this.discardHeldEdits()} edits discarded. ${this.statusText()}`));
		this.registerCliHandler("postgresql-sync:test", "Connect to PostgreSQL and show its version", null, () =>
			answer(() => this.describeServer()));
	}
}

class VaultNotReadError extends MirrorError {}
