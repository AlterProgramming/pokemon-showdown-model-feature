/**
 * Battle Stream Example
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Example of how to create AIs battling against each other.
 * Run this using `node build && node .sim-dist/examples/battle-stream-example`.
 *
 * @license MIT
 * @author Guangcong Luo <guangcongluo@gmail.com>
 */

import { BattleStream, getPlayerStreams, Teams } from '..';
import { RandomPlayerAI } from '../tools/random-player-ai';
import { RLAgentAI } from '../tools/rl-agent';
import {parseBooleanOption, resolveRLModelProfileConfig} from '../tools/rl-model-profiles';

/*********************************************************************
 * Run AI
 *********************************************************************/

const rlProfile = resolveRLModelProfileConfig(
	process.env.RL_MODEL_PROFILE,
	parseBooleanOption(process.env.RL_ALLOW_VOLUNTARY_SWITCHES),
);

const streams = getPlayerStreams(new BattleStream());

const spec = {
	formatid: "gen7customgame",
};
const p1spec = {
	name: "Bot 1",
	team: Teams.pack(Teams.generate('gen9randombattle')),
};
const p2spec = {
	name: "Bot 2",
	team: Teams.pack(Teams.generate('gen9randombattle')),
};

const p1 = new RandomPlayerAI(streams.p1);
const p2 = new RLAgentAI(streams.p2, {
	modelProfile: rlProfile.profile,
	allowVoluntarySwitches: rlProfile.allowVoluntarySwitches,
});

console.log("p1 is " + p1.constructor.name);
console.log("p2 is " + p2.constructor.name);
console.log("rl profile is " + rlProfile.profile);

void p1.start();
void p2.start();

void (async () => {
	for await (const chunk of streams.omniscient) {
		console.log(chunk);
	}
})();

void streams.omniscient.write(`>start ${JSON.stringify(spec)}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);
