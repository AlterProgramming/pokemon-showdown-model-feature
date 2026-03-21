/**********************************************************************
 * RL model profiles
 * Preserve simulator/model contract variants so historical models can
 * continue to be benchmarked against newer, richer pipelines.
 **********************************************************************/

export type RLModelProfile = 'move-only' | 'joint-policy' | 'custom';

export type RLModelProfileConfig = {
	profile: RLModelProfile;
	description: string;
	allowVoluntarySwitches: boolean;
};

const PROFILE_CONFIGS: Record<Exclude<RLModelProfile, 'custom'>, RLModelProfileConfig> = {
	'move-only': {
		profile: 'move-only',
		description: 'Move-only action contract baseline for the legacy model_1 pipeline.',
		allowVoluntarySwitches: false,
	},
	'joint-policy': {
		profile: 'joint-policy',
		description: 'Full move-or-switch action space for newer joint-policy models.',
		allowVoluntarySwitches: true,
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
		};
	}

	const baseConfig = PROFILE_CONFIGS[profile];
	return {
		...baseConfig,
		allowVoluntarySwitches: allowVoluntarySwitchesOverride ?? baseConfig.allowVoluntarySwitches,
	};
}
