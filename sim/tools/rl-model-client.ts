const DEFAULT_MAX_RETRY_ATTEMPTS = 1;
const DEFAULT_RETRY_DELAY_MS = 250;

export class RLModelClient {
	private readonly endpoint: string;
	private readonly modelID: string | undefined;
	private readonly modelProfile: string;
	private readonly maxRetryAttempts: number;
	private readonly retryDelayMs: number;

	lastRequest: AnyObject | null = null;
	lastResponse: AnyObject | null = null;

	constructor(options: {
		endpoint: string;
		modelID?: string;
		modelProfile: string;
		maxRetryAttempts?: number;
		retryDelayMs?: number;
	}) {
		this.endpoint = options.endpoint;
		this.modelID = options.modelID;
		this.modelProfile = options.modelProfile;
		this.maxRetryAttempts = options.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
		this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
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
				const response = await fetch(this.endpoint, {
					method: 'POST',
					headers: {"Content-Type": "application/json"},
					body: JSON.stringify(modelData),
				});

				responseStatus = response.status;
				responseStatusText = response.statusText;
				responseBody = await response.text();

				if (!response.ok) {
					const parsedResponse = this.parseResponseBody(responseBody, false);
					if (this.shouldRetry(response.status, parsedResponse, attempt)) {
						attempt++;
						this.logRetry(response.status, attempt);
						await this.sleep(this.retryDelayMs);
						continue;
					}
					throw new Error(`Model request failed: ${response.status}`);
				}

				const parsedResponse = this.parseRequiredResponseBody(responseBody);
				this.lastRequest = modelData;
				this.lastResponse = parsedResponse;
				return parsedResponse;
			} catch (error) {
				this.logFailure(modelData, describeSide, responseStatus, responseStatusText, responseBody);
				throw error;
			}
		}
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
