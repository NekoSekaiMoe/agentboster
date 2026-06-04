export default function ConfigLoading() {
  return (
    <div className='flex min-h-[400px] items-center justify-center'>
      <div className="text-center">
        <div className='inline-block h-8 w-8 animate-spin rounded-full border-4 border-current border-r-transparent border-solid' />
        <p className='mt-4 text-muted-foreground text-sm'>Loading configuration...</p>
      </div>
    </div>
  );
}
