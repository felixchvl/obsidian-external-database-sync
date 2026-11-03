import type pg from "pg";
import type { ConnectionSettings } from "./mirror.ts";
import { openClient } from "./mirror.ts";
import { MirrorStatements } from "./statements.ts";

/** The window's timers in Obsidian, Node's in tests. */
export interface Timers {
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(timer: number): void;
}

/**
 * Listens on a connection kept open for the database's edits to one vault, and calls
 * `onEdited` when one is made; also once connected, for those made while it was not. A lost
 * connection is opened again a little later.
 */
export class ChangeListener {
	private static readonly retryDelayMs = 30_000;
	private readonly settings: ConnectionSettings;
	private readonly vault: string;
	private readonly onEdited: () => void;
	private readonly timers: Timers;
	private client: pg.Client | undefined;
	private retry: number | undefined;
	private isStopped = false;

	constructor(settings: ConnectionSettings, vault: string, onEdited: () => void, timers: Timers) {
		this.settings = settings;
		this.vault = vault;
		this.onEdited = onEdited;
		this.timers = timers;
	}

	start(): void {
		void this.listen();
	}

	stop(): void {
		this.isStopped = true;
		if (this.retry !== undefined) this.timers.clearTimeout(this.retry);
		void this.client?.end().catch(() => undefined);
		this.client = undefined;
	}

	private async listen(): Promise<void> {
		if (this.isStopped) return;
		try {
			const client = await openClient(this.settings, { keepAlive: true });
			if (this.isStopped) {
				await client.end().catch(() => undefined);
				return;
			}
			this.client = client;
			client.on("notification", (message) => {
				if (message.channel !== MirrorStatements.changeChannel || !message.payload) return;
				try {
					const payload = JSON.parse(message.payload) as { schema?: string; vault?: string };
					if (payload.schema === this.settings.schema.trim() && payload.vault === this.vault) this.onEdited();
				} catch {
					// A notification another program sent on the channel.
				}
			});
			client.on("end", () => this.listenLater(client));
			client.on("error", () => this.listenLater(client));
			await client.query(`LISTEN ${MirrorStatements.changeChannel}`);
			this.onEdited();
		} catch {
			this.listenLater(undefined);
		}
	}

	private listenLater(lost: pg.Client | undefined): void {
		if (this.isStopped || (lost !== undefined && lost !== this.client)) return;
		this.client = undefined;
		void lost?.end().catch(() => undefined);
		if (this.retry !== undefined) this.timers.clearTimeout(this.retry);
		this.retry = this.timers.setTimeout(() => void this.listen(), ChangeListener.retryDelayMs);
	}
}
