import type {RLModelProfile} from "../../sim/tools/rl-model-profiles";
import type {ReplayCaptureMode} from "../../sim/tools/replay-export";
import type {PRNGSeed} from "../../sim/prng";

export type ModelLeagueDaemonStatus = "idle" | "running" | "paused";
export type ModelLeagueTaskType = "live" | "historical" | "benchmark";
export type ModelLeagueControlRequestType =
	"pause" | "resume" | "force-benchmark" | "force-snapshot" | "enqueue-training";
export type ModelLeagueJobStatus = "pending" | "completed" | "registered" | "failed";
export type ModelLeagueBattleResultType = "win" | "loss" | "tie" | "timeout" | "error";
export type ModelLeagueSchedulerBucket = "live" | "historical" | "exploration";

export interface ModelLeagueConfig {
	version: 1;
	format: string;
	stateRoot: string;
	logRoot: string;
	models: ModelLeagueModelConfig[];
	teams: ModelLeagueTeamConfig[];
	benchmarks: ModelLeagueBenchmarkConfig[];
	scheduler: ModelLeagueSchedulerConfig;
	ratings: ModelLeagueRatingsConfig;
	replay: ModelLeagueReplayConfig;
	training: ModelLeagueTrainingConfig;
	webhooks: ModelLeagueWebhookConfig;
}

export interface ModelLeagueModelConfig {
	id: string;
	name: string;
	modelID: string;
	endpoint: string;
	modelProfile: RLModelProfile;
	allowVoluntarySwitches?: boolean;
	active?: boolean;
	archived?: boolean;
	parentCheckpointId?: string | null;
	lineageId?: string;
	sampleWeight?: number;
	allowedTeamIds?: string[];
	metadata?: AnyObject;
}

export interface ModelLeagueTeamConfig {
	id: string;
	name: string;
	packedTeam: string;
	active?: boolean;
	archived?: boolean;
	sampleWeight?: number;
	metadata?: AnyObject;
}

export interface ModelLeagueBenchmarkConfig {
	id: string;
	name: string;
	level: number;
	opponentModelId: string;
	opponentTeamId: string;
	requiredWinRate?: number;
	rollouts?: number;
	description?: string;
}

export interface ModelLeagueSchedulerConfig {
	loopIntervalMs: number;
	benchmarkIntervalMs: number;
	maxConcurrentTasks: number;
	liveMatchmakingWeight: number;
	archivedMatchmakingWeight: number;
	explorationWeight: number;
	liveRollouts: number;
	historicalRollouts: number;
	benchmarkRolloutsDefault: number;
	sideSwap: boolean;
	matchmakingWindow: number;
	recentMatchLimit: number;
}

export interface ModelLeagueRatingsConfig {
	initialElo: number;
	minElo: number;
}

export interface ModelLeagueReplayConfig {
	captureMode: ReplayCaptureMode;
	captureCount: number;
	outputDir: string;
	grid: boolean;
	gridRefreshSeconds: number;
}

export interface ModelLeagueTrainingConfig {
	enabled: boolean;
	minMatches: number;
	minExamples: number;
	cooldownMs: number;
	examplesDir: string;
	bundleDir: string;
	pendingJobDir: string;
	completedJobDir: string;
}

export interface ModelLeagueWebhookConfig {
	outboundTrainingRequested: ModelLeagueWebhookTarget | null;
	inboundTrainingCompleted: ModelLeagueInboundWebhookConfig | null;
}

export interface ModelLeagueWebhookTarget {
	url: string;
	headers?: Record<string, string>;
	secret?: string;
	timeoutMs?: number;
}

export interface ModelLeagueInboundWebhookConfig {
	host: string;
	port: number;
	path: string;
	secret?: string;
}

export interface ModelLeagueState {
	version: 1;
	updatedAt: string | null;
	configPath: string;
	daemon: ModelLeagueDaemonState;
	checkpoints: ModelLeagueCheckpointState[];
	teams: ModelLeagueTeamState[];
	modelRatings: ModelLeagueRatingEntry[];
	teamRatings: ModelLeagueRatingEntry[];
	recentMatches: ModelLeagueMatchSummary[];
	recentBenchmarkRuns: ModelLeagueBenchmarkRunSummary[];
	benchmarkProgress: ModelLeagueBenchmarkProgress[];
	trainingJobs: ModelLeagueTrainingJob[];
	processedControlRequestIds: string[];
	processedCompletedJobIds: string[];
	stats: ModelLeagueStats;
}

export interface ModelLeagueDaemonState {
	status: ModelLeagueDaemonStatus;
	pid: number | null;
	startedAt: string | null;
	heartbeatAt: string | null;
	lastLoopAt: string | null;
	loopCount: number;
	activeTask: ModelLeagueDaemonTask | null;
	lastError: string | null;
	webhook: ModelLeagueWebhookState;
}

export interface ModelLeagueWebhookState {
	enabled: boolean;
	listening: boolean;
	host: string | null;
	port: number | null;
	path: string | null;
	lastReceivedAt: string | null;
	lastError: string | null;
}

export interface ModelLeagueDaemonTask {
	type: ModelLeagueTaskType;
	startedAt: string;
	description: string;
}

export interface ModelLeagueTrainingBuffer {
	matchCount: number;
	exampleCount: number;
	exampleFiles: string[];
	matchIds: string[];
	lastBundleCreatedAt: string | null;
}

export interface ModelLeagueCheckpointState {
	id: string;
	name: string;
	modelID: string;
	endpoint: string;
	modelProfile: RLModelProfile;
	allowVoluntarySwitches: boolean;
	active: boolean;
	archived: boolean;
	lineageId: string;
	parentCheckpointId: string | null;
	sampleWeight: number;
	allowedTeamIds: string[] | null;
	createdAt: string;
	lastTrainingJobAt: string | null;
	matchCount: number;
	liveMatchCount: number;
	historicalMatchCount: number;
	benchmarkMatchCount: number;
	exampleCount: number;
	trainingBuffer: ModelLeagueTrainingBuffer;
	metadata: AnyObject | null;
}

export interface ModelLeagueTeamState {
	id: string;
	name: string;
	packedTeam: string;
	active: boolean;
	archived: boolean;
	sampleWeight: number;
	createdAt: string;
	matchCount: number;
	liveMatchCount: number;
	historicalMatchCount: number;
	benchmarkMatchCount: number;
	metadata: AnyObject | null;
}

export interface ModelLeagueRatingEntry {
	id: string;
	name: string;
	elo: number;
	wins: number;
	losses: number;
	ties: number;
	totalMatches: number;
	lastUpdatedAt: string | null;
	lastOpponentId: string | null;
}

export interface ModelLeagueStats {
	liveMatches: number;
	historicalMatches: number;
	benchmarkRuns: number;
	trainingBundles: number;
	decisionExamplesCaptured: number;
}

export interface ModelLeagueMatchSummary {
	id: string;
	type: ModelLeagueTaskType;
	schedulerBucket: ModelLeagueSchedulerBucket | null;
	recordedAt: string;
	format: string;
	rollouts: number;
	sideSwap: boolean;
	modelAId: string;
	modelBId: string;
	teamAId: string;
	teamBId: string;
	modelAWins: number;
	modelBWins: number;
	ties: number;
	winRateA: number;
	confidenceLow: number;
	confidenceHigh: number;
	modelAEloBefore: number;
	modelAEloAfter: number;
	modelBEloBefore: number;
	modelBEloAfter: number;
	teamAEloBefore: number;
	teamAEloAfter: number;
	teamBEloBefore: number;
	teamBEloAfter: number;
	replayPaths: string[];
	exampleFiles: Record<string, string | undefined>;
}

export interface ModelLeagueBenchmarkProgress {
	id: string;
	name: string;
	level: number;
	requiredWinRate: number;
	lastRunAt: string | null;
	lastChallengerModelId: string | null;
	lastChallengerTeamId: string | null;
	lastWinRate: number | null;
	lastConfidenceLow: number | null;
	lastConfidenceHigh: number | null;
	cleared: boolean;
	clearedAt: string | null;
}

export interface ModelLeagueBenchmarkRunSummary {
	id: string;
	benchmarkId: string;
	recordedAt: string;
	challengerModelId: string;
	challengerTeamId: string;
	opponentModelId: string;
	opponentTeamId: string;
	rollouts: number;
	winRate: number;
	confidenceLow: number;
	confidenceHigh: number;
	cleared: boolean;
	replayPaths: string[];
}

export interface ModelLeagueTrainingJob {
	jobId: string;
	modelCheckpointId: string;
	parentCheckpointId: string | null;
	lineageId: string;
	createdAt: string;
	requestedBy: string;
	status: ModelLeagueJobStatus;
	bundleDir: string;
	manifestPath: string;
	matchCount: number;
	exampleCount: number;
	exampleFiles: string[];
	matchIds: string[];
	outboundWebhookDeliveredAt: string | null;
	outboundWebhookError: string | null;
	completionPayload: ModelLeagueTrainingCompletionPayload | null;
	error: string | null;
}

export interface ModelLeagueTrainingCompletionPayload {
	jobId: string;
	parentCheckpointId?: string | null;
	newModelId: string;
	name?: string;
	endpoint: string;
	modelProfile: RLModelProfile;
	allowVoluntarySwitches?: boolean;
	lineageId?: string;
	parentModelId?: string;
	metadata?: AnyObject;
	activate?: boolean;
}

export interface ModelLeagueControlRequest {
	id: string;
	type: ModelLeagueControlRequestType;
	createdAt: string;
	requestedBy: string;
	modelCheckpointId?: string;
}

export interface ModelLeagueCompetitor {
	modelId: string;
	teamId: string;
	name: string;
	modelName: string;
	teamName: string;
	modelID: string;
	endpoint: string;
	modelProfile: RLModelProfile;
	allowVoluntarySwitches: boolean;
	packedTeam: string;
	active: boolean;
	archived: boolean;
	sampleWeight: number;
}

export interface ModelLeagueSingleBattleResult {
	battleId: string;
	seed: PRNGSeed;
	winner: "p1" | "p2" | "tie" | "unknown";
	turns: number;
	switches: {p1: number; p2: number};
	forcedDrags: number;
	replayLog: string;
	p1: ModelLeagueCompetitor;
	p2: ModelLeagueCompetitor;
	trainingExamples: ModelLeagueTrainingExampleRecord[];
}

export interface ModelLeagueRolloutBatchResult {
	batchId: string;
	recordedAt: string;
	format: string;
	rollouts: number;
	sideSwap: boolean;
	p1: ModelLeagueCompetitor;
	p2: ModelLeagueCompetitor;
	modelAWins: number;
	modelBWins: number;
	ties: number;
	winRateA: number;
	confidenceLow: number;
	confidenceHigh: number;
	replayPaths: string[];
	battles: ModelLeagueSingleBattleResult[];
}

export interface ModelLeagueTrainingExampleRecord {
	modelCheckpointId: string;
	battleId: string;
	recordedAt: string;
	perspectivePlayer: "p1" | "p2";
	requestKind: "move" | "forceSwitch" | "teamPreview";
	modelRequest: AnyObject | null;
	modelResponse: AnyObject | null;
	chosenAction: string;
	usedFallback: boolean;
	format: string;
	seed: PRNGSeed;
	teamId: string;
	opponentModelId: string;
	opponentTeamId: string;
	result: ModelLeagueBattleResultType;
}

export interface ModelLeagueRunOptions {
	format: string;
	p1: ModelLeagueCompetitor;
	p2: ModelLeagueCompetitor;
	rollouts: number;
	sideSwap: boolean;
	baseSeed?: PRNGSeed | null;
	captureReplays?: boolean;
	replayOutputDir?: string;
	replayCaptureMode?: ReplayCaptureMode;
	replayCaptureCount?: number;
	replayFilePrefix?: string;
	captureTrainingExamples?: boolean;
}
