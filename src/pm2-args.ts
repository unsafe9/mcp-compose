export function extractGatewayPort(args: string[]): number | null {
  let portStr: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--command-arg') {
      i++;
      continue;
    }
    if (arg === '--port') {
      portStr = args[i + 1];
      i++;
    }
  }
  if (portStr === undefined) return null;

  const port = parseInt(portStr, 10);
  return isNaN(port) ? null : port;
}
