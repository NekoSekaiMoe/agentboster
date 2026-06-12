export function executeVersionCommand(): { text: string } {
  const version = process.env.npm_package_version || '1.0.0';
  const nodeVersion = process.version;

  return {
    text: `AgentBoster v${version}
Runtime: Node.js ${nodeVersion}
Platform: ${process.platform}`,
  };
}
