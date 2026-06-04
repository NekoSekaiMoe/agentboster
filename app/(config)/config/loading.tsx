export default function ConfigLoading() {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="text-center">
        <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent" />
        <p className="mt-4 text-sm text-muted-foreground">Loading configuration...</p>
      </div>
    </div>
  );
}
