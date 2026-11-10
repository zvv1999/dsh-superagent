/** Host-only contracts for managed CLI onboarding. Never serialize command output or prepared credentials into panel views. */
export type CliPlatform = 'feishu' | 'dingtalk'
export type CliFailureCode = 'install_failed' | 'unsupported_platform' | 'authorization_failed' | 'expired' | 'cancelled'
  | 'network_failed' | 'invalid_response' | 'permission_required' | 'credentials_required' | 'invalid_credentials'
  | 'settings_conflict' | 'save_failed' | 'not_ready' | 'platform_policy_denied' | 'config_path_too_long'
/** Stable public failure code; deliberately carries no command output or provider message. */
export class CliFailure extends Error {
  constructor(readonly code: CliFailureCode) { super(code) }
}
export interface CliChallenge { url: string; userCode?: string; expiresAt?: string }
export interface CliApplication { id: string; name: string; clientId?: string }
export interface CliIdentity { profileId?: string; userId?: string; name?: string; organization?: string; app?: CliApplication }
export interface CliCheck { id: 'identity' | 'bot' | 'receive' | 'send' | 'published'; state: 'passed' | 'action' | 'unknown' }
export interface CliCommandOptions {
  signal: AbortSignal
  stdin?: string
  timeoutMs?: number
  /** Host-only streaming output, never forwarded to the panel or logging. */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
}
export interface CliCommandResult { stdout: string; stderr: string }
export interface CliIo {
  /** Native executable, not an npm shim; managed paths only. */
  executable: string
  configDir: string
  run(args: readonly string[], options: CliCommandOptions): Promise<CliCommandResult>
}
export interface CliCredentials { appId: string; secret: string; clientId?: string }
export interface CliPrepared {
  accountId: string
  name: string
  /** Only an identity verified to belong to the selected bot/application may be granted automatically. */
  ownerId?: string
  checks: CliCheck[]
  platformUrl: string
  /** DingTalk host-only material, persisted privately by the coordinator on confirmation. */
  credential?: { clientId: string; clientSecret: string; robotCode?: string }
}
export interface CliPrepareInput {
  cli: CliIo
  identity: CliIdentity
  app: CliApplication
  credentials?: CliCredentials
  /** Recheck the same prepared app without repeating an initialization or losing a once-only secret. */
  previous?: CliPrepared
  signal: AbortSignal
}
export interface CliDriver {
  /** Recover a saved, managed application identity without resolving its secret or granting access. */
  recover?(cli: CliIo, signal: AbortSignal): Promise<CliIdentity | undefined>
  authorize(cli: CliIo, signal: AbortSignal, challenge: (value: CliChallenge) => void): Promise<CliIdentity>
  applications(cli: CliIo, identity: CliIdentity, signal: AbortSignal): Promise<CliApplication[]>
  prepare(input: CliPrepareInput): Promise<CliPrepared>
}
