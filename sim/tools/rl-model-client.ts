import {spawn, type ChildProcessWithoutNullStreams} from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

const DEFAULT_MAX_RETRY_ATTEMPTS = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_IPC_ENDPOINT = "ipc://word-policy";
const DEFAULT_IPC_READY_TIMEOUT_MS = 10_000;
const DEFAULT_IPC_WORKER_COUNT = Math.max(1, Number(process.env.RL_MODEL_IPC_WORKERS || 4));
const DEFAULT_LOCAL_ENDPOINT = "local://default";

type RLModelTransport = "http" | "ipc" | "local";
type LocalModelHandler = (modelData: AnyObject) => Promise<AnyObject> | AnyObject;
type ModelTransportProvider = {
	query(modelData: AnyObject): Promise<AnyObject>;
};

type PendingIPCRequest = {
	resolve: (value: AnyObject) => void;
	reject: (error: Error) => void;
};

const localModelHandlers = new Map<string, LocalModelHandler>();
const sharedIPCTransports = new Map<string, IPCModelTransport>();

function defaultIPCWorkerPython(): string {
	if (process.env.RL_MODEL_IPC_PYTHON) return process.env.RL_MODEL_IPC_PYTHON;
	const projectRoot = path.resolve(__dirname, "../../../");
	const venvPython = process.platform === "win32"
		? path.join(projectRoot, "../Pokemon-Showdown-Sim/.venv/Scripts/python.exe")
		: path.join(projectRoot, "../Pokemon-Showdown-Sim/.venv/bin/python");
	if (fs.existsSync(venvPython)) return venvPython;
	return process.platform === "win32" ? "python" : "python3";
}

function defaultIPCWorkerScriptPath(): string {
	return path.resolve(__dirname, "../../../../word_prediction_model/ipc_policy_worker.py");
}

class IPCModelTransport implements ModelTransportProvider {
	private readonly pythonExecutable: string;
	private readonly workerScriptPath: string;
	private readonly readyTimeoutMs: number;
	private child: ChildProcessWithoutNullStreams | null = null;
	private stdoutReader: readline.Interface | null = null;
	private pending = new Map<string, PendingIPCRequest>();
	private nextRequestID = 0;
	private readyPromise: Promise<void> | null = null;
	private readyResolve: (() => void) | null = null;
	private readyReject: ((error: Error) => void) | null = null;

	constructor(options?: {pythonExecutable?: string; workerScriptPath?: string; readyTimeoutMs?: number}) {
		this.pythonExecutable = options?.pythonExecutable || defaultIPCWorkerPython();
		this.workerScriptPath = options?.workerScriptPath || defaultIPCWorkerScriptPath();
		this.readyTimeoutMs = options?.readyTimeoutMs ?? DEFAULT_IPC_READY_TIMEOUT_MS;
	}

	async query(modelData: AnyObject): Promise<AnyObject> {
		await this.ensureReady();
		return this.sendRequest("predict", modelData);
	}

	private async ensureReady(): Promise<void> {
		if (this.child && this.readyPromise) {
			await this.readyPromise;
			return;
		}

		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
		});

		const child = spawn(this.pythonExecutable, [this.workerScriptPath], {
			stdio: ["pipe", "pipe", "pipe"],
			env: {...process.env, PYTHONUNBUFFERED: "1"},
		});
		this.child = child;

		this.stdoutReader = readline.createInterface({input: child.stdout});
		this.stdoutReader.on("line", line => this.handleStdoutLine(line));

		child.stderr.on("data", chunk => {
			const text = String(chunk).trim();
			if (text) console.error(`[rl-model-ipc] ${text}`);
		});

		child.on("error", error => {
			this.failStartup(error instanceof Error ? error : new Error(String(error)));
			this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
			this.resetChild();
		});

		child.on("exit", (code, signal) => {
			const reason = new Error(
				`IPC worker exited${code !== null ? ` with code ${code}` : ""}${signal ? ` signal ${signal}` : ""}.`
			);
			this.failStartup(reason);
			this.rejectAllPending(reason);
			this.resetChild();
		});

		const startupTimeout = setTimeout(() => {
			this.failStartup(new Error(`IPC worker did not become ready within ${this.readyTimeoutMs} ms.`));
			if (this.child) this.child.kill();
		}, this.readyTimeoutMs);

		try {
			await this.sendRequest("health", {});
			clearTimeout(startupTimeout);
			this.readyResolve?.();
			this.readyResolve = null;
			this.readyReject = null;
		} catch (error) {
			clearTimeout(startupTimeout);
			this.failStartup(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}

		await this.readyPromise;
	}

	private sendRequest(type: string, payload: AnyObject): Promise<AnyObject> {
		if (!this.child) {
			return Promise.reject(new Error("IPC worker is not running."));
		}
		const requestID = `${process.pid}-${++this.nextRequestID}`;
		const envelope = JSON.stringify({id: requestID, type, payload});
		return new Promise<AnyObject>((resolve, reject) => {
			this.pending.set(requestID, {resolve, reject});
			try {
				this.child!.stdin.write(`${envelope}\n`);
			} catch (error) {
				this.pending.delete(requestID);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private handleStdoutLine(line: string) {
		let message: AnyObject;
		try {
			message = JSON.parse(line);
		} catch {
			console.error(`[rl-model-ipc] Invalid JSON from worker: ${line}`);
			return;
		}

		const requestID = String(message.id || "");
		const pending = this.pending.get(requestID);
		if (!pending) return;
		this.pending.delete(requestID);

		if (message.ok) {
			pending.resolve(message.result || null);
			return;
		}
		pending.reject(new Error(String(message.error || "IPC worker request failed.")));
	}

	private failStartup(error: Error) {
		if (this.readyReject) {
			this.readyReject(error);
			this.readyReject = null;
			this.readyResolve = null;
		}
		this.readyPromise = null;
	}

	private rejectAllPending(error: Error) {
		for (const [requestID, pending] of this.pending.entries()) {
			this.pending.delete(requestID);
			pending.reject(error);
		}
	}

	private resetChild() {
		this.stdoutReader?.close();
		this.stdoutReader = null;
		this.child = null;
	}
}

class LocalModelTransport implements ModelTransportProvider {
	private readonly endpoint: string;

	constructor(endpoint: string) {
		this.endpoint = endpoint;
	}

	async query(modelData: AnyObject): Promise<AnyObject> {
		const handler = localModelHandlers.get(this.endpoint);
		if (!handler) {
			throw new Error(`No local model handler registered for ${this.endpoint}.`);
		}
		return await handler(modelData);
	}
}

function getSharedIPCTransport(options?: {
	pythonExecutable?: string;
	workerScriptPath?: string;
	readyTimeoutMs?: number;
	workerCount?: number;
}): IPCModelTransport {
	const pythonExecutable = options?.pythonExecutable || defaultIPCWorkerPython();
	const workerScriptPath = options?.workerScriptPath || defaultIPCWorkerScriptPath();
	const readyTimeoutMs = options?.readyTimeoutMs ?? DEFAULT_IPC_READY_TIMEOUT_MS;
	const workerCount = Math.max(1, options?.workerCount ?? DEFAULT_IPC_WORKER_COUNT);
	const key = JSON.stringify({pythonExecutable, workerScriptPath, readyTimeoutMs, workerCount});
	let transport = sharedIPCTransports.get(key);
	if (!transport) {
		if (workerCount === 1) {
			transport = new IPCModelTransport({pythonExecutable, workerScriptPath, readyTimeoutMs});
		} else {
			const workers = Array.from({length: workerCount}, () =>
				new IPCModelTransport({pythonExecutable, workerScriptPath, readyTimeoutMs})
			);
			let nextWorkerIndex = 0;
			transport = {
				query(modelData: AnyObject) {
					const worker = workers[nextWorkerIndex];
					nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
					return worker.query(modelData);
				},
			} as IPCModelTransport;
		}
		sharedIPCTransports.set(key, transport);
	}
	return transport;
}

export class RLModelClient {
	private readonly endpoint: string;
	private readonly modelID: string | undefined;
	private readonly modelProfile: string;
	private readonly maxRetryAttempts: number;
	private readonly retryDelayMs: number;
	private readonly transport: RLModelTransport;
	private readonly transportProvider: ModelTransportProvider | null;

	lastRequest: AnyObject | null = null;
	lastResponse: AnyObject | null = null;

	constructor(options: {
		endpoint?: string;
		modelID?: string;
		modelProfile: string;
		maxRetryAttempts?: number;
		retryDelayMs?: number;
		transport?: RLModelTransport;
		ipcPythonExecutable?: string;
		ipcWorkerScriptPath?: string;
		ipcReadyTimeoutMs?: number;
		ipcWorkerCount?: number;
	}) {
		this.transport = options.transport ?? (
			options.endpoint?.startsWith("ipc://") ? "ipc" :
			options.endpoint?.startsWith("local://") ? "local" :
			"http"
		);
		this.endpoint = options.endpoint || (
			this.transport === "ipc" ? DEFAULT_IPC_ENDPOINT :
			this.transport === "local" ? DEFAULT_LOCAL_ENDPOINT :
			"http://127.0.0.1:5000/predict"
		);
		this.modelID = options.modelID;
		this.modelProfile = options.modelProfile;
		this.maxRetryAttempts = options.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
		this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
		this.transportProvider = this.transport === "ipc"
			? getSharedIPCTransport({
				pythonExecutable: options.ipcPythonExecutable,
				workerScriptPath: options.ipcWorkerScriptPath,
				readyTimeoutMs: options.ipcReadyTimeoutMs,
				workerCount: options.ipcWorkerCount,
			})
			: this.transport === "local"
				? new LocalModelTransport(this.endpoint)
				: null;
	}

	static registerLocalHandler(endpoint: string, handler: LocalModelHandler): void {
		localModelHandlers.set(endpoint, handler);
	}

	static unregisterLocalHandler(endpoint: string): void {
		localModelHandlers.delete(endpoint);
	}

	async query(modelData: AnyObject, describeSide: (modelData: AnyObject | null) => string): Promise<AnyObject> {
		let responseStatus: number | undefined;
		let responseStatusText: string | undefined;
		let responseBody: string | undefined;
		let attempt = 0;

		while (true) {
			responseStatus = undefined;
			responseStatusText = undefined;
			responseBody = undefined;

			try {
				let parsedResponse: AnyObject;
				if (this.transport === "http") {
					const httpResult = await this.queryHTTP(modelData);
					responseStatus = httpResult.responseStatus;
					responseStatusText = httpResult.responseStatusText;
					responseBody = httpResult.responseBody;
					const httpParsedResponse = httpResult.parsedResponse;
					if (this.shouldRetry(responseStatus, httpParsedResponse, attempt)) {
						attempt++;
						this.logRetry(responseStatus, attempt);
						await this.sleep(this.retryDelayMs);
						continue;
					}
					if (responseStatus >= 400) {
						throw new Error(`Model request failed: ${responseStatus}`);
					}
					if (httpParsedResponse == null) {
						throw new Error("Model response body was empty.");
					}
					parsedResponse = httpParsedResponse;
				} else {
					parsedResponse = await this.transportProvider!.query(modelData);
				}

				this.lastRequest = modelData;
				this.lastResponse = parsedResponse;
				return parsedResponse;
			} catch (error) {
				this.logFailure(modelData, describeSide, responseStatus, responseStatusText, responseBody);
				throw error;
			}
		}
	}

	private async queryHTTP(modelData: AnyObject): Promise<{
		parsedResponse: AnyObject | null;
		responseStatus: number;
		responseStatusText: string;
		responseBody: string;
	}> {
		const response = await fetch(this.endpoint, {
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify(modelData),
		});

		const responseBody = await response.text();
		return {
			parsedResponse: this.parseResponseBody(responseBody, response.ok),
			responseStatus: response.status,
			responseStatusText: response.statusText,
			responseBody,
		};
	}

	private parseResponseBody(responseBody: string | undefined, requireJson: boolean): AnyObject | null {
		if (!responseBody) {
			if (requireJson) {
				throw new Error("Model response body was empty.");
			}
			return null;
		}
		try {
			return JSON.parse(responseBody);
		} catch {
			if (requireJson) {
				throw new Error("Model response was not valid JSON.");
			}
			return null;
		}
	}

	private parseRequiredResponseBody(responseBody: string | undefined): AnyObject {
		const phaseResponse = this.parseResponseBody(responseBody, true);
		if (!phaseResponse) {
			throw new Error("Model response body was empty.");
		}
		return phaseResponse;
	}

	private shouldRetry(responseStatus: number, parsedResponse: AnyObject | null, attempt: number): boolean {
		return (
			attempt < this.maxRetryAttempts &&
			responseStatus === 503 &&
			Boolean(parsedResponse && parsedResponse.retryable === true)
		);
	}

	private async sleep(delayMs: number): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, delayMs));
	}

	private logRetry(responseStatus: number, attempt: number) {
		console.warn(
			`Retrying model request after retryable ${responseStatus} response ` +
			`(attempt ${attempt}/${this.maxRetryAttempts}) for model profile ${this.modelProfile}.`
		);
	}

	private logFailure(
		modelData: AnyObject,
		describeSide: (modelData: AnyObject | null) => string,
		responseStatus?: number,
		responseStatusText?: string,
		responseBody?: string,
	) {
		console.error("Model exchange failed.");
		if (this.modelID) console.error(`Model ID: ${this.modelID}`);
		console.error(`Model profile: ${this.modelProfile}`);
		console.error(`Transport: ${this.transport}`);
		console.error(`Endpoint: ${this.endpoint}`);
		console.error("Request payload:");
		console.error(this.stringifyForLog(modelData));
		if (responseStatus !== undefined) {
			console.error(`Response status: ${responseStatus} ${responseStatusText || ""}`.trim());
		} else {
			console.error("Response status: unavailable");
		}
		console.error("Response body:");
		console.error(responseBody && responseBody.length ? responseBody : "<empty>");
		console.error(`Error side: ${describeSide(modelData)}`);
	}

	private stringifyForLog(value: AnyObject): string {
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}
}
