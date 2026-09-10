/**
 * Ambient module declaration for the Markdown "Text" module rule configured
 * in wrangler.jsonc (`rules: [{ type: "Text", globs: ["**\/*.md"] }]`).
 * Lets `src/knowledge.ts` `import` the knowledge-base files as plain strings.
 */
declare module "*.md" {
  const content: string;
  export default content;
}
