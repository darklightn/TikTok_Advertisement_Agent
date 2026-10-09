# Report ID resolution

The deployed export Skill's `config/report-set.json` is the single registry for user-facing report names, aliases, categories, profiles, and enabled reports. Require `schema_version=report_set_v1`, resolve the user's wording through that registry, and pass only enabled canonical `report_id` values to the locator.

If the export registry is unavailable and the user did not supply a canonical `report_id`, stop and request one minimal clarification. Do not reconstruct the registry from filenames, display labels, this cleaning model, or a copied list.

After location, the exact successful export Manifest or logical-job Manifest is authoritative for which reports the selected export actually contains. Recompute the qualified Artifact hashes, then filter the requested IDs against datasets marked `model_ready` in `config/first-model-v1.json`.

The registry proves request vocabulary, not export existence or cleaning support. The Manifest proves the selected export contents; the cleaning model proves whether those contents can be cleaned.
