import * as http from "http";
import type {
	ModelLeagueConfig,
	ModelLeagueTrainingCompletionPayload,
	ModelLeagueWebhookState,
	ModelLeagueWebhookTarget,
} from "./types";

export async function postModelLeagueWebhook(
	target: ModelLeagueWebhookTarget | null,
	payload: AnyObject
) {
	if (!target) return {delivered: false, error: null as string | null};
	const headers: Record<string, string> = {
		"content-type": "application/json",
		...target.headers,
	};
	if (target.secret) headers["x-model-league-secret"] = target.secret;
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), target.timeoutMs || 10_000);
		const response = await fetch(target.url, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!response.ok) {
			return {
				delivered: false,
				error: `Webhook returned ${response.status} ${response.statusText}`.trim(),
			};
		}
		return {delivered: true, error: null as string | null};
	} catch (error: any) {
		return {delivered: false, error: error.message || String(error)};
	}
}

function isCompletionPayload(payload: AnyObject): payload is ModelLeagueTrainingCompletionPayload {
	return !!(
		payload &&
		typeof payload.jobId === "string" &&
		typeof payload.newModelId === "string" &&
		typeof payload.endpoint === "string" &&
		typeof payload.modelProfile === "string"
	);
}

export class ModelLeagueCompletionWebhookServer {
	private server: http.Server | null = null;

	constructor(
		private readonly config: ModelLeagueConfig,
		private readonly onPayload: (payload: ModelLeagueTrainingCompletionPayload) => Promise<void>,
		private readonly onStatus: (patch: Partial<ModelLeagueWebhookState>) => void = () => {},
	) {}

	async start() {
		const webhook = this.config.webhooks.inboundTrainingCompleted;
		if (!webhook || this.server) return;

		this.server = http.createServer((request, response) => {
			void this.handleRequest(request, response);
		});
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(webhook.port, webhook.host, () => {
				this.server!.off("error", reject);
				resolve();
			});
		});
		this.onStatus({
			enabled: true,
			listening: true,
			host: webhook.host,
			port: webhook.port,
			path: webhook.path,
			lastError: null,
		});
	}

	async stop() {
		if (!this.server) return;
		const current = this.server;
		this.server = null;
		await new Promise<void>(resolve => current.close(() => resolve()));
		this.onStatus({listening: false});
	}

	private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
		const webhook = this.config.webhooks.inboundTrainingCompleted;
		if (!webhook) {
			response.statusCode = 404;
			response.end("disabled");
			return;
		}
		if (request.method !== "POST" || request.url !== webhook.path) {
			response.statusCode = 404;
			response.end("not found");
			return;
		}
		if (webhook.secret && request.headers["x-model-league-secret"] !== webhook.secret) {
			this.onStatus({lastError: "Rejected inbound webhook with invalid secret."});
			response.statusCode = 403;
			response.end("forbidden");
			return;
		}

		const chunks: Buffer[] = [];
		request.on("data", chunk => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		request.on("error", error => {
			this.onStatus({lastError: error.message});
			if (!response.headersSent) {
				response.statusCode = 500;
				response.end("error");
			}
		});
		request.on("end", () => {
			void this.finishRequest(chunks, response);
		});
	}

	private async finishRequest(chunks: Buffer[], response: http.ServerResponse) {
		try {
			const body = Buffer.concat(chunks).toString("utf8");
			const payload = JSON.parse(body || "{}");
			if (!isCompletionPayload(payload)) {
				response.statusCode = 400;
				response.end("invalid payload");
				return;
			}
			await this.onPayload(payload);
			this.onStatus({
				lastReceivedAt: new Date().toISOString(),
				lastError: null,
			});
			response.statusCode = 202;
			response.end("accepted");
		} catch (error: any) {
			this.onStatus({lastError: error.message || String(error)});
			response.statusCode = 500;
			response.end("error");
		}
	}
}
