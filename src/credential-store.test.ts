import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "./errors.js";
import {
  PlatformCredentialStore,
  credentialBackendName,
  isMissingCredentialError,
} from "./credential-store.js";

describe("platform credential storage", () => {
  it.each([
    ["darwin", "macOS Keychain"],
    ["win32", "Windows Credential Manager"],
    ["linux", "Linux Secret Service"],
  ] as const)("routes %s only to %s", (platform, backend) => {
    expect(credentialBackendName(platform)).toBe(backend);
    expect(() => new PlatformCredentialStore(platform)).not.toThrow();
  });

  it("fails closed on unsupported platforms", () => {
    expect(() => new PlatformCredentialStore("freebsd")).toThrow(
      ConfigurationError,
    );
  });

  it("treats only native not-found results as an absent credential", () => {
    expect(isMissingCredentialError("darwin", { code: 44 })).toBe(false);
    expect(isMissingCredentialError("linux", { code: 1, stderr: "" })).toBe(
      true,
    );
    expect(isMissingCredentialError("linux", { code: "ENOENT" })).toBe(false);
    expect(
      isMissingCredentialError("linux", { code: 1, stderr: "keyring locked" }),
    ).toBe(false);
    expect(isMissingCredentialError("win32", { code: 1168 })).toBe(false);
  });

  it("invokes only macOS Keychain commands for the selected account", async () => {
    const execute = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const writeInput = vi.fn(async () => undefined);
    const writeFileDescriptor = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: `value:${Buffer.from("saved-session").toString("base64")}\n`,
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "stored\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "deleted\n", stderr: "" });
    const store = new PlatformCredentialStore(
      "darwin",
      execute,
      writeInput,
      writeFileDescriptor,
    );

    await expect(store.get("prod:client:api")).resolves.toBe("saved-session");
    await store.set("prod:client:api", "secret-session");
    await store.delete("prod:client:api");

    expect(execute).not.toHaveBeenCalled();
    expect(writeInput).not.toHaveBeenCalled();
    expect(writeFileDescriptor).toHaveBeenCalledTimes(3);
    expect(
      writeFileDescriptor.mock.calls.map(([, arguments_]) => arguments_),
    ).toEqual([
      ["-l", "JavaScript", "-", "get", "ai.cobaltcode.cli", "prod:client:api"],
      ["-l", "JavaScript", "-", "set", "ai.cobaltcode.cli", "prod:client:api"],
      [
        "-l",
        "JavaScript",
        "-",
        "delete",
        "ai.cobaltcode.cli",
        "prod:client:api",
      ],
    ]);
    for (const [file, arguments_, program] of writeFileDescriptor.mock.calls) {
      expect(file).toBe("/usr/bin/osascript");
      expect(program).toContain('ObjC.import("Security")');
      expect(program).toContain(
        "initWithFileDescriptorCloseOnDealloc(3, false)",
      );
      expect(program).toContain("ObjC.castRefToObject(result[0])");
      expect(program).toContain("$.SecItemUpdate");
      expect(program).toContain("$.SecItemAdd");
      expect(program).toContain("$.SecItemDelete");
      expect(JSON.stringify({ arguments_, program })).not.toContain(
        "secret-session",
      );
    }
    expect(writeFileDescriptor.mock.calls[1]![3]).toBe("secret-session");
    expect(writeFileDescriptor.mock.calls[0]![3]).toBe("");
    expect(writeFileDescriptor.mock.calls[2]![3]).toBe("");
  });

  it("maps a missing macOS Keychain item without plaintext fallback", async () => {
    const writeFileDescriptor = vi.fn(async () => ({
      stdout: "missing\n",
      stderr: "",
    }));
    const store = new PlatformCredentialStore(
      "darwin",
      vi.fn(async () => ({ stdout: "", stderr: "" })),
      vi.fn(async () => undefined),
      writeFileDescriptor,
    );

    await expect(store.get("prod:client:api")).resolves.toBeNull();
  });

  it("fails closed on malformed macOS Keychain output", async () => {
    const store = new PlatformCredentialStore(
      "darwin",
      vi.fn(async () => ({ stdout: "", stderr: "" })),
      vi.fn(async () => undefined),
      vi.fn(async () => ({ stdout: "value:not-base64!\n", stderr: "" })),
    );

    await expect(store.get("prod:client:api")).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it("passes Linux Secret Service values through stdin, never argv", async () => {
    const execute = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const writeInput = vi.fn(async () => undefined);
    const store = new PlatformCredentialStore("linux", execute, writeInput);

    await store.set("prod:client:api", "secret-session");

    expect(writeInput).toHaveBeenCalledWith(
      "secret-tool",
      [
        "store",
        "--label",
        "Cobalt CLI auth session",
        "service",
        "ai.cobaltcode.cli",
        "account",
        "prod:client:api",
      ],
      "secret-session",
    );
    expect(JSON.stringify(writeInput.mock.calls[0]![1])).not.toContain(
      "secret-session",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses Credential Manager through non-interactive PowerShell on Windows", async () => {
    const execute = vi.fn(async () => ({ stdout: "session", stderr: "" }));
    const store = new PlatformCredentialStore("win32", execute);

    await expect(store.get("prod:client:api")).resolves.toBe("session");
    await store.set("prod:client:api", "secret-session");
    await store.delete("prod:client:api");

    for (const [file, arguments_, options] of execute.mock.calls) {
      expect(file).toBe("powershell.exe");
      expect(arguments_).toContain("-NonInteractive");
      expect(JSON.stringify(arguments_)).not.toContain("secret-session");
      expect(options?.env?.COBALT_CREDENTIAL_ACCOUNT).toBe("prod:client:api");
    }
    expect(
      execute.mock.calls.map(
        (call) => call[2]?.env?.COBALT_CREDENTIAL_OPERATION,
      ),
    ).toEqual(["Read", "Write", "Delete"]);
    expect(execute.mock.calls[1]![2]?.env?.COBALT_CREDENTIAL_SECRET).toBe(
      "secret-session",
    );
  });

  it("fails closed when a selected native credential command is unavailable", async () => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const store = new PlatformCredentialStore("linux", execute);
    await expect(store.get("prod:client:api")).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });
});
