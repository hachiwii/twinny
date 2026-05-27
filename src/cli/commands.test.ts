import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./commands.js";

const runInstallAgent = vi.fn(async () => undefined);
const runInstallWizard = vi.fn(async () => undefined);

vi.mock("./install-wizard.js", () => ({
  runInstallAgent,
  runInstallWizard
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("CLI command parsing", () => {
  it("passes no-gui to the agent installer when set on the parent install command", async () => {
    await runCli(["node", "twinny", "install", "--no-gui", "agent", "--start", "false"]);

    expect(runInstallAgent).toHaveBeenCalledWith(expect.objectContaining({
      noGui: true,
      start: false
    }));
  });

  it("passes no-gui to the agent installer when set on the agent subcommand", async () => {
    await runCli(["node", "twinny", "install", "agent", "--no-gui", "--start", "false"]);

    expect(runInstallAgent).toHaveBeenCalledWith(expect.objectContaining({
      noGui: true,
      start: false
    }));
  });

  it("inherits disable-keychain from the parent install command for agent installs", async () => {
    await runCli(["node", "twinny", "install", "--disable-keychain", "agent", "--start", "false"]);

    expect(runInstallAgent).toHaveBeenCalledWith(expect.objectContaining({
      disableKeychain: true
    }));
  });
});
