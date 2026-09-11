export const SUPPORTED_DESKTOP_TARGETS = ['darwin-arm64', 'linux-x64', 'linux-arm64'];

export function assertSupportedDesktopTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (SUPPORTED_DESKTOP_TARGETS.includes(target)) return target;
  throw new Error(`DoomPi Desktop supports ${SUPPORTED_DESKTOP_TARGETS.join(', ')}; ${target} is not supported.`);
}
