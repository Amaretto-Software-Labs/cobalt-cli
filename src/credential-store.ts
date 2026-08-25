import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { ConfigurationError } from "./errors.js";

const execFileAsync = promisify(execFile);
const service = "ai.cobaltcode.cli";

export type CredentialExecutor = (
  file: string,
  arguments_: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; windowsHide?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export type CredentialInputExecutor = (
  file: string,
  arguments_: readonly string[],
  input: string,
) => Promise<void>;

export type CredentialFileDescriptorExecutor = (
  file: string,
  arguments_: readonly string[],
  program: string,
  secret: string,
) => Promise<{ stdout: string; stderr: string }>;

const macOSCredentialProgram = String.raw`ObjC.import("Foundation");
ObjC.import("Security");

function run(argv) {
  if (argv.length !== 3) throw new Error("Expected operation, service, and account.");
  const operation = argv[0];
  const value = (item) => $.NSString.stringWithString(item);
  const constant = (item) => ObjC.castRefToObject(item);
  const query = $.NSMutableDictionary.alloc.init;
  query.setObjectForKey(constant($.kSecClassGenericPassword), constant($.kSecClass));
  query.setObjectForKey(value(argv[1]), constant($.kSecAttrService));
  query.setObjectForKey(value(argv[2]), constant($.kSecAttrAccount));

  if (operation === "get") {
    query.setObjectForKey($.NSNumber.numberWithBool(true), constant($.kSecReturnData));
    query.setObjectForKey(constant($.kSecMatchLimitOne), constant($.kSecMatchLimit));
    const result = Ref();
    const status = Number($.SecItemCopyMatching(query, result));
    if (status === Number($.errSecItemNotFound)) return "missing";
    if (status !== Number($.errSecSuccess))
      throw new Error("Keychain read failed with status " + status + ".");
    const secretData = ObjC.castRefToObject(result[0]);
    return "value:" + ObjC.unwrap(secretData.base64EncodedStringWithOptions(0));
  }

  if (operation === "delete") {
    const status = Number($.SecItemDelete(query));
    if (status !== Number($.errSecSuccess) && status !== Number($.errSecItemNotFound))
      throw new Error("Keychain deletion failed with status " + status + ".");
    return "deleted";
  }

  if (operation !== "set") throw new Error("Unsupported Keychain operation.");
  const secretHandle = $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(3, false);
  const secretData = secretHandle.readDataToEndOfFile;
  if (Number(secretData.length) === 0) throw new Error("Credential data is empty.");
  const attributes = $.NSMutableDictionary.alloc.init;
  attributes.setObjectForKey(secretData, constant($.kSecValueData));
  let status = Number($.SecItemUpdate(query, attributes));
  if (status === Number($.errSecItemNotFound)) {
    query.setObjectForKey(secretData, constant($.kSecValueData));
    status = Number($.SecItemAdd(query, null));
  }
  if (status !== Number($.errSecSuccess))
    throw new Error("Keychain write failed with status " + status + ".");
  return "stored";
}
`;

const executeCredentialCommand: CredentialExecutor = async (
  file,
  arguments_,
  options,
) => {
  const result = await execFileAsync(file, arguments_, {
    encoding: "utf8",
    ...options,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

const writeCredentialCommand: CredentialInputExecutor = async (
  file,
  arguments_,
  input,
) => {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(file, arguments_, (error) =>
      error ? reject(error) : resolve(),
    );
    if (!child.stdin) {
      child.kill();
      reject(new Error(`Unable to open stdin for '${file}'.`));
      return;
    }
    child.stdin.end(input);
  });
};

const executeCredentialFileDescriptorCommand: CredentialFileDescriptorExecutor =
  async (file, arguments_, program, secret) => {
    return await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(file, arguments_, {
          detached: true,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        let settled = false;
        let outputBytes = 0;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (error) {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
            reject(error);
          } else
            resolve({
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
            });
        };
        const timeout = setTimeout(
          () => finish(new Error(`'${file}' timed out.`)),
          15_000,
        );
        const trackOutput = (target: Buffer[]) => (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > 64 * 1024)
            finish(new Error(`'${file}' produced too much output.`));
          else target.push(chunk);
        };
        child.stdout?.on("data", trackOutput(stdout));
        child.stderr?.on("data", trackOutput(stderr));
        child.once("error", finish);
        child.once("close", (code) =>
          code === 0
            ? finish()
            : finish(new Error(`'${file}' exited with status ${code ?? -1}.`)),
        );
        const secretPipe = child.stdio[3] as
          (NodeJS.WritableStream & { end(value: string): void }) | null;
        if (!child.stdin || !secretPipe) {
          finish(new Error("Unable to open credential process pipes."));
          return;
        }
        child.stdin.once("error", finish);
        secretPipe.once("error", finish);
        child.stdin.end(program);
        secretPipe.end(secret);
      },
    );
  };

export async function writeMacOSKeychainCredential(
  serviceName: string,
  account: string,
  secret: string,
  execute: CredentialFileDescriptorExecutor = executeCredentialFileDescriptorCommand,
): Promise<void> {
  await executeMacOSKeychainCredential(
    "set",
    serviceName,
    account,
    secret,
    execute,
  );
}

export async function readMacOSKeychainCredential(
  serviceName: string,
  account: string,
  execute: CredentialFileDescriptorExecutor = executeCredentialFileDescriptorCommand,
): Promise<string | null> {
  const value = await executeMacOSKeychainCredential(
    "get",
    serviceName,
    account,
    "",
    execute,
  );
  if (value === "missing") return null;
  if (!value.startsWith("value:"))
    throw new Error("Keychain returned an invalid response.");
  const encoded = value.slice("value:".length);
  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  )
    throw new Error("Keychain returned invalid credential data.");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded)
    throw new Error("Keychain returned invalid credential data.");
  return decoded.toString("utf8");
}

export async function deleteMacOSKeychainCredential(
  serviceName: string,
  account: string,
  execute: CredentialFileDescriptorExecutor = executeCredentialFileDescriptorCommand,
): Promise<void> {
  await executeMacOSKeychainCredential(
    "delete",
    serviceName,
    account,
    "",
    execute,
  );
}

async function executeMacOSKeychainCredential(
  operation: "get" | "set" | "delete",
  serviceName: string,
  account: string,
  secret: string,
  execute: CredentialFileDescriptorExecutor,
): Promise<string> {
  const result = await execute(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-", operation, serviceName, account],
    macOSCredentialProgram,
    secret,
  );
  return result.stdout.replace(/\r?\n$/, "");
}

export interface CredentialStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export function credentialBackendName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  if (platform === "linux") return "Linux Secret Service";
  throw new ConfigurationError(
    `Secure credential storage is unsupported on '${platform}'.`,
  );
}

export function isMissingCredentialError(
  platform: NodeJS.Platform,
  failure: { code?: number | string; stderr?: string },
): boolean {
  return platform === "linux" && failure.code === 1 && !failure.stderr?.trim();
}

export class PlatformCredentialStore implements CredentialStore {
  public constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly execute: CredentialExecutor = executeCredentialCommand,
    private readonly writeInput: CredentialInputExecutor = writeCredentialCommand,
    private readonly writeFileDescriptor: CredentialFileDescriptorExecutor = executeCredentialFileDescriptorCommand,
  ) {
    credentialBackendName(platform);
  }

  public async get(account: string): Promise<string | null> {
    return await this.nativeGet(account);
  }

  public async set(account: string, secret: string): Promise<void> {
    try {
      await this.nativeSet(account, secret);
    } catch (error) {
      throw new ConfigurationError(
        "Secure Cobalt CLI credential storage is unavailable. Install and unlock the platform credential service. COBALT_TOKEN may be used for a single invocation.",
        { cause: error },
      );
    }
  }

  public async delete(account: string): Promise<void> {
    await this.nativeDelete(account);
  }

  private async nativeGet(account: string): Promise<string | null> {
    try {
      if (this.platform === "darwin") {
        return await readMacOSKeychainCredential(
          service,
          account,
          this.writeFileDescriptor,
        );
      }
      if (this.platform === "linux") {
        const result = await this.execute("secret-tool", [
          "lookup",
          "service",
          service,
          "account",
          account,
        ]);
        return result.stdout.replace(/\r?\n$/, "") || null;
      }
      if (this.platform === "win32") {
        const result = await execWindowsCredential(
          "Read",
          account,
          undefined,
          this.execute,
        );
        return result.stdout || null;
      }
      throw new Error(`Unsupported platform '${this.platform}'.`);
    } catch (error) {
      const failure = error as {
        code?: number | string;
        stderr?: string;
      };
      if (isMissingCredentialError(this.platform, failure)) return null;
      throw new ConfigurationError(
        "Secure Cobalt CLI credential storage is unavailable. Install and unlock the platform credential service, or use COBALT_TOKEN for this invocation.",
        { cause: error },
      );
    }
  }

  private async nativeSet(account: string, secret: string): Promise<void> {
    if (this.platform === "darwin") {
      await writeMacOSKeychainCredential(
        service,
        account,
        secret,
        this.writeFileDescriptor,
      );
      return;
    }
    if (this.platform === "linux") {
      await this.writeInput(
        "secret-tool",
        [
          "store",
          "--label",
          "Cobalt CLI auth session",
          "service",
          service,
          "account",
          account,
        ],
        secret,
      );
      return;
    }
    if (this.platform === "win32") {
      await execWindowsCredential("Write", account, secret, this.execute);
      return;
    }
    throw new Error(`Unsupported platform '${this.platform}'.`);
  }

  private async nativeDelete(account: string): Promise<void> {
    try {
      if (this.platform === "darwin")
        await deleteMacOSKeychainCredential(
          service,
          account,
          this.writeFileDescriptor,
        );
      else if (this.platform === "linux")
        await this.execute("secret-tool", [
          "clear",
          "service",
          service,
          "account",
          account,
        ]);
      else if (this.platform === "win32")
        await execWindowsCredential("Delete", account, undefined, this.execute);
    } catch (error) {
      const failure = error as { code?: number | string; stderr?: string };
      if (!isMissingCredentialError(this.platform, failure))
        throw new ConfigurationError(
          "Secure Cobalt CLI credential storage is unavailable.",
          { cause: error },
        );
    }
  }
}

async function execWindowsCredential(
  operation: "Read" | "Write" | "Delete",
  account: string,
  secret?: string,
  execute: CredentialExecutor = executeCredentialCommand,
): Promise<{ stdout: string }> {
  const source = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CobaltCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public UInt32 Flags, Type; public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob;
    public UInt32 Persist, AttributeCount; public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32")] private static extern void CredFree(IntPtr credential);
  public static string Read(string target) { IntPtr pointer; if (!CredRead(target,1,0,out pointer)) { if (Marshal.GetLastWin32Error()==1168) return null; throw new Win32Exception(); } try { var value=(CREDENTIAL)Marshal.PtrToStructure(pointer,typeof(CREDENTIAL)); return Marshal.PtrToStringUni(value.CredentialBlob,checked((int)value.CredentialBlobSize/2)); } finally { CredFree(pointer); } }
  public static void Write(string target,string account,string secret) { IntPtr blob=Marshal.StringToCoTaskMemUni(secret); try { var value=new CREDENTIAL { Type=1,TargetName=target,CredentialBlobSize=checked((uint)(secret.Length*2)),CredentialBlob=blob,Persist=2,UserName=account }; if (!CredWrite(ref value,0)) throw new Win32Exception(); } finally { Marshal.FreeCoTaskMem(blob); } }
  public static void Delete(string target) { if (!CredDelete(target,1,0) && Marshal.GetLastWin32Error()!=1168) throw new Win32Exception(); }
}`;
  const command =
    "Add-Type -TypeDefinition $env:COBALT_CREDENTIAL_SOURCE; $target='ai.cobaltcode.cli/'+$env:COBALT_CREDENTIAL_ACCOUNT; if ($env:COBALT_CREDENTIAL_OPERATION -eq 'Read') { [Console]::Out.Write([CobaltCredential]::Read($target)) } elseif ($env:COBALT_CREDENTIAL_OPERATION -eq 'Write') { [CobaltCredential]::Write($target,$env:COBALT_CREDENTIAL_ACCOUNT,$env:COBALT_CREDENTIAL_SECRET) } else { [CobaltCredential]::Delete($target) }";
  return await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      env: {
        ...process.env,
        COBALT_CREDENTIAL_SOURCE: source,
        COBALT_CREDENTIAL_OPERATION: operation,
        COBALT_CREDENTIAL_ACCOUNT: account,
        ...(secret === undefined ? {} : { COBALT_CREDENTIAL_SECRET: secret }),
      },
      windowsHide: true,
    },
  );
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();
  public async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }
  public async set(account: string, secret: string): Promise<void> {
    this.values.set(account, secret);
  }
  public async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}
