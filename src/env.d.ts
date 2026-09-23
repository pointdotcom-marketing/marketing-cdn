// Secrets are set with `wrangler secret put` and are not in wrangler.toml, so
// `wrangler types` cannot see them. Declared optional because the worker checks
// for missing values at runtime.
interface Env {
	UPLOAD_PASSWORD?: string;
	CODE_PASSWORD?: string;
	CF_API_TOKEN?: string;
}
