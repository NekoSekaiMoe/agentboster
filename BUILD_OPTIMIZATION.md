# Build Optimization Guide

## Current Performance
- Clean build: ~2m2s
- Incremental build: ~1m18s

## Bottlenecks (cannot optimize further)
1. **Workflow processing (~12s)**: Vercel Workflow DevKit overhead
   - Discovering directives: 6-7s
   - Creating bundles: 4-5s
   - No way to skip this for workflows

2. **Static page generation (~40s)**: 70 API route pages
   - Required by Next.js App Router
   - Each route needs metadata extraction

## Already Applied Optimizations
- ✅ SWC minifier (7x faster than Terser)
- ✅ Extended optimizePackageImports (lucide, radix, react-markdown, framer-motion, date-fns)
- ✅ serverExternalPackages for heavy deps (playwright, discord.js, chat adapters)
- ✅ typescript.ignoreBuildErrors (type checking via separate lint step)

## Further Optimization Options

### Option 1: Parallel Builds (Complex)
**Impact**: 20-30% faster on multi-core
**Effort**: High
**Tradeoff**: More memory usage

Enable experimental worker threads for webpack:
```ts
experimental: {
  webpackBuildWorker: true,  // Next.js 15+ experimental
}
```

### Option 2: Reduce Static Page Count (Breaking)
**Impact**: 30-40% faster
**Effort**: Medium
**Tradeoff**: Some routes become dynamic (slower first request)

Convert some API routes from static to dynamic:
```ts
export const dynamic = 'force-dynamic';  // Add to route.ts
```

Good candidates: `/api/agentd/v1/*` (rarely pre-rendered anyway)

### Option 3: Skip Source Maps in Production
**Impact**: 10-15% faster
**Effort**: Low
**Tradeoff**: Harder to debug production errors

```ts
productionBrowserSourceMaps: false,  // default is false already
```

### Option 4: Lazy Load Heavy Components
**Impact**: Smaller bundles, faster build
**Effort**: Medium
**Tradeoff**: Slight UX delay on component load

Use `next/dynamic` for CodeMirror, React Markdown, etc:
```tsx
const CodeEditor = dynamic(() => import('./CodeEditor'), { ssr: false });
```

### Option 5: Cache Workflow Bundles (Experimental)
**Impact**: 50% faster incremental builds
**Effort**: High (requires patching Workflow DevKit)
**Tradeoff**: Risk of stale bundles

Would need to implement custom caching for workflow directive discovery.

## Recommended Next Steps

1. **Low-hanging fruit**: Review API routes, mark non-critical ones as dynamic
2. **Medium effort**: Lazy load heavy React components (CodeMirror, Markdown)
3. **High effort**: Only if build time becomes critical (>5min)

## Vercel Deployment

Vercel's build cache is separate from local. First Vercel deploy will be slow (~3-5min including postbuild playwright install). Subsequent deploys with cache: ~2-3min.

To speed up Vercel builds:
- Ensure `node_modules` are cached (automatic)
- Consider splitting agentd build to separate workflow (if it changes frequently)
