// Owner requested Ghidra removal. Broad RE/Architect authorization cannot
// reinstall or launch it. Keep this gate independent of inherited environment.
export const GHIDRA_EXECUTION_POLICY = Object.freeze({
  mode: 'disabled-pending-removal', approvalRequired: true, uninstallRequested: true,
  automaticLaunchAllowed: false, automaticInstallAllowed: false,
});
export function isGhidraLaunch(command, args) {
  const values=[command,...(Array.isArray(args)?args:[])].filter(v=>typeof v==='string');
  const text=values.join(' ').replaceAll('\\','/');
  return /(?:^|[\s/"'=])(?:ghidra(?:[_/ .-]|Run|Server)|analyzeHeadless(?:\.bat|\.sh|\s|$))|\b(?:pyghidra|ghidra_bridge|ghidra\.Ghidra)\b/i.test(text)
    || /(?:^|[\s/"'])tools\/java\/[^\s"']*\/bin\/javaw?\.exe(?:[\s"']|$)/i.test(text);
}
export function assertGhidraLaunchAllowed(command,args) {
  if(isGhidraLaunch(command,args)) {
    const error=new Error('Ghidra is disabled and requires explicit user approval before installation or launch.');
    error.code='GHIDRA_USER_APPROVAL_REQUIRED';throw error;
  }
}
