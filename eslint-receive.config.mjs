// @ts-check

import baseConfig from './eslint.config.mjs';

function disableReceiveStyleRules(config) {
	if (Array.isArray(config)) {
		return config.map(disableReceiveStyleRules);
	}
	if (!config || typeof config !== 'object') return config;
	if (!config.rules) return config;

	const rules = Object.fromEntries(
		Object.entries(config.rules).map(([name, value]) => {
			if (name.startsWith('@stylistic/')) return [name, 'off'];
			return [name, value];
		})
	);

	return {
		...config,
		rules,
	};
}

export default disableReceiveStyleRules(baseConfig);
