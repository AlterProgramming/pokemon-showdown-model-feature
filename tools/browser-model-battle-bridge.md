# Pokemon Showdown browser bridge

This userscript bridges an official Pokemon Showdown battle tab to a local bridge endpoint.

## What it does

- Watches the active battle room in the browser.
- Copies the current `request` object and any available battle-log deltas into a local JSON payload.
- Sends that payload to the bridge on `http://127.0.0.1:5051/predict`.
- The bridge normalizes the payload with the local simulator and then forwards it to the real model endpoint.
- Mirrors the simulator's team-preview behavior by submitting `default` locally instead of querying the model for preview order.
- Replays the returned choice back into the official Pokemon Showdown tab with `/choose ...|rqid`.

## Installation

- Load `tools/browser-model-battle-bridge.user.js` into Tampermonkey, Violentmonkey, or a similar userscript manager.
- Start the bridge with `pokemon-showdown browser-model-bridge`.
- Point the bridge at your real model endpoint with `--model-endpoint` if it is not the default `http://127.0.0.1:5000/predict`.
- Use `--debug-log` to change where one-shot debug snapshots are written. The default is `logs/browser-model-bridge-debug.log`.
- Make sure the script has permission to connect to `127.0.0.1` or `localhost`.
- Use the overlay button labeled `Print next state` when you want the next outbound battle payload to be logged to the browser console once and appended to the bridge debug log.
- The overlay shows the userscript version and the current room/request lookup path so stale userscript copies are easier to spot.

## Notes

- The script is intentionally lightweight and only reads the live battle room object.
- It assumes a 1v1 battle flow, but it still forwards the full request object and log deltas so the bridge can normalize them.
- If the request shape changes, adjust `server/browser-model-bridge.ts` instead of the userscript.
