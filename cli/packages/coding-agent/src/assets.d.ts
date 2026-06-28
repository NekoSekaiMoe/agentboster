// Ambient declarations for non-TS assets inlined by esbuild loaders.
// These files live next to the source (e.g. template.html, dark.json)
// and are bundled at build time.

declare module "*.html" {
	const content: string;
	export default content;
}

declare module "*.css" {
	const content: string;
	export default content;
}

declare module "*.json" {
	const value: unknown;
	export default value;
}

declare module "*.js" {
	const value: string;
	export default value;
}

declare module "*.min.js" {
	const value: string;
	export default value;
}

declare module "*.base64" {
	const value: string;
	export default value;
}
