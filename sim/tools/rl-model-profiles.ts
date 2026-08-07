/**********************************************************************
 * RL model profiles
 * Preserve simulator/model contract variants so historical models can
 * continue to be benchmarked against newer, richer pipelines.
 **********************************************************************/

export type RLModelProfile = 'move-only' | 'joint-policy' | 'joint-policy-value' | 'not-elman-policy' | 'custom';

export type RLModelProfileConfig = {
	profile: RLModelProfile;
	description: string;
	allowVoluntarySwitches: boolean;
	requiresStateHistory: boolean;
};

const PROFILE_CONFIGS: Record<Exclude<RLModelProfile, 'custom'>, RLModelProfileConfig> = {
	'move-only': {
		profile: 'move-only',
		description: 'Move-only action contract baseline for the legacy model_1 pipeline.',
		allowVoluntarySwitches: false,
		requiresStateHistory: false,
	},
	'joint-policy': {
		profile: 'joint-policy',
		description: 'Full move-or-switch action space for newer joint-policy models.',
		allowVoluntarySwitches: true,
		requiresStateHistory: false,
	},
	'joint-policy-value': {
		profile: 'joint-policy-value',
		description: 'Joint policy with auxiliary turn-outcome and value heads for the newer model_4 pipeline.',
		allowVoluntarySwitches: true,
		requiresStateHistory: false,
	},
	'not-elman-policy': {
		profile: 'not-elman-policy',
		description: 'Model1 Network of Theseus recurrent target with explicit public-state history.',
		allowVoluntarySwitches: false,
		requiresStateHistory: true,
	},
};

export function parseBooleanOption(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
	return undefined;
}

export function normalizeRLModelProfile(value: string | undefined): RLModelProfile | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
	case 'move-only':
	case 'moveonly':
	case 'move_only':
	case 'model1':
	case 'model1-legacy':
	case 'legacy':
	case 'legacy-model1':
		return 'move-only';
	case 'joint':
	case 'joint-policy':
	case 'model2':
	case 'joint-model2':
		return 'joint-policy';
	case 'joint-policy-value':
	case 'jointpolicyvalue':
	case 'joint_policy_value':
	case 'joint-value':
	case 'value-head':
	case 'value-policy':
		return 'joint-policy-value';
	case 'not-elman-policy':
	case 'not-elman':
	case 'model1-not-elman3':
	case 'model1_not_elman3':
		return 'not-elman-policy';
	case 'custom':
		return 'custom';
	default:
		return undefined;
	}
}

export function resolveRLModelProfileConfig(
	profileInput?: string,
	allowVoluntarySwitchesOverride?: boolean,
): RLModelProfileConfig {
	const profile = normalizeRLModelProfile(profileInput) || 'joint-policy';
	if (profile === 'custom') {
		return {
			profile: 'custom',
			description: 'Custom action-contract override.',
			allowVoluntarySwitches: allowVoluntarySwitchesOverride ?? true,
			requiresStateHistory: false,
		};
	}

	const baseConfig = PROFILE_CONFIGS[profile];
	return {
		...baseConfig,
		allowVoluntarySwitches: allowVoluntarySwitchesOverride ?? baseConfig.allowVoluntarySwitches,
	};
}
