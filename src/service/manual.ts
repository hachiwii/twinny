export function manualServiceUnavailableMessage(): string {
  return [
    "Twinny managed service is not available in this WSL2 environment because systemd user services are not enabled.",
    "Run Twinny in the foreground with `TWINNY_HOME=/path/to/home twinny run`, or enable systemd in WSL and run `twinny install` again."
  ].join(" ");
}

export async function installManualService(): Promise<void> {
  console.log("No managed service installed. Use `twinny run` to run Twinny in the foreground.");
}

export async function uninstallManualService(): Promise<void> {
  console.log("No managed service is installed for this environment.");
}

export async function startManualService(): Promise<void> {
  throw new Error(manualServiceUnavailableMessage());
}

export async function stopManualService(): Promise<void> {
  throw new Error(manualServiceUnavailableMessage());
}

export async function restartManualService(): Promise<void> {
  throw new Error(manualServiceUnavailableMessage());
}

export async function statusManualService(): Promise<void> {
  console.log(manualServiceUnavailableMessage());
}

export async function tailManualServiceLogs(): Promise<void> {
  throw new Error(manualServiceUnavailableMessage());
}
