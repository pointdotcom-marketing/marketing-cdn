# AGENTS.md - Cloudflare Workers CDN Project

## Build/Deploy Commands
- `npm run dev` - Start development server (wrangler dev)
- `npm run deploy` - Deploy to Cloudflare Workers
- `wrangler dev` - Alternative dev command
- `npm test` - Run Vitest unit tests
- This Worker only serves files; `/upload`, `/browse`, and `/code` 302 to the marketing-tools hub, which owns all file management

## Code Style & Formatting
- **Indentation**: Tabs (configured in .editorconfig and .prettierrc)
- **Line width**: 140 characters max
- **Quotes**: Single quotes preferred
- **Semicolons**: Required
- **Line endings**: LF (Unix style)
- **Trailing whitespace**: Remove
- **Final newline**: Required

## TypeScript Configuration
- Target: ES2021
- Module: ESNext with Bundler resolution
- Strict mode enabled with noUncheckedIndexedAccess
- Cloudflare Workers types included
- JSX: react-jsx (though not used in current code)

## Naming Conventions
- Constants: SCREAMING_SNAKE_CASE (e.g., CONTENT_TYPES, PROTECTED_PREFIXES)
- Functions: camelCase (e.g., redirectTargetKey, publicCdnBase)
- Variables: camelCase
- File extensions in lowercase for content type mapping

## Error Handling
- Use try-catch blocks for async operations
- Log errors with console.error()
- Return appropriate HTTP status codes (302 for missing files and redirects, 403, 416, 500)
- Graceful fallbacks (e.g., range request errors fall back to full file)
## Contract with marketing-tools (CDN Files)
- Both Workers share the `marketing-cdn` R2 bucket; file management lives in the marketing-tools hub
- `_trash/` (`TRASH_PREFIX`): deleted uploads; never served (reads as missing) and protected from replace
- `cdn-redirect-to` (`REDIRECT_METADATA_KEY`): custom metadata on an empty placeholder left at a renamed file's old key; serving answers 302 (`no-store`) to the new key, reusing the object it already fetched. Ignored in `PROTECTED_PREFIXES` and for unsafe targets
- Serving changes must keep the "asset serving contract" tests passing unchanged; ship with `wrangler versions upload` + `Cloudflare-Workers-Version-Overrides` checks before shifting traffic
