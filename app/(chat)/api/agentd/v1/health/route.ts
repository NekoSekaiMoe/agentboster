export async function GET() {
  return Response.json({
    success: true,
    data: {
      status: 'ok',
      service: 'agentd-api',
      timestamp: new Date().toISOString(),
    },
  });
}
